import type { Client } from '../db/pool.js';
import { badRequest } from '../lib/errors.js';

export interface ResolvedInterval {
  minServiceDays: number;
  maxServiceDays: number;
  minSource: string;
  maxSource: string;
}

/**
 * Normative service-interval inheritance (17_GATE §3): min_service_days and max_service_days are
 * resolved INDEPENDENTLY, each by the priority
 *   Machine → Route (first by sort_order that defines this field) → Location → parent Locations
 *   → global configured default.
 * A missing value at one level never cancels the other field. After resolution min <= max is
 * mandatory; an inconsistent configuration is rejected.
 */
export async function resolveServiceInterval(
  client: Client,
  machineNumber: string,
): Promise<ResolvedInterval> {
  const candidates: Array<{ min: number | null; max: number | null; source: string }> = [];

  const machine = await client.query(
    'SELECT min_service_days, max_service_days FROM machines WHERE machine_number = $1',
    [machineNumber],
  );
  if (machine.rowCount === 0) throw badRequest('UNKNOWN_MACHINE', 'аппарат не существует');
  candidates.push({
    min: machine.rows[0].min_service_days,
    max: machine.rows[0].max_service_days,
    source: 'machine',
  });

  const routes = await client.query(
    `SELECT r.id, r.name, r.min_service_days, r.max_service_days
     FROM machine_routes mr
     JOIN routes r ON r.id = mr.route_id
     WHERE mr.machine_number = $1
     ORDER BY r.sort_order, r.id`,
    [machineNumber],
  );
  for (const route of routes.rows) {
    candidates.push({
      min: route.min_service_days,
      max: route.max_service_days,
      source: `route:${route.id}`,
    });
  }

  const locations = await client.query(
    `WITH RECURSIVE active_location AS (
       SELECT l.id, l.parent_id, l.min_service_days, l.max_service_days, 0 AS depth
       FROM machine_placements p
       JOIN locations l ON l.id = p.location_id
       WHERE p.machine_number = $1 AND p.ended_at IS NULL
       UNION ALL
       SELECT parent.id, parent.parent_id, parent.min_service_days, parent.max_service_days,
              child.depth + 1
       FROM active_location child
       JOIN locations parent ON parent.id = child.parent_id
     )
     SELECT id, min_service_days, max_service_days FROM active_location ORDER BY depth`,
    [machineNumber],
  );
  for (const location of locations.rows) {
    candidates.push({
      min: location.min_service_days,
      max: location.max_service_days,
      source: `location:${location.id}`,
    });
  }

  const defaults = await client.query(
    `SELECT value FROM app_settings WHERE key = 'service_interval_defaults'`,
  );
  const globalDefaults = defaults.rows[0]?.value ?? { min_service_days: 3, max_service_days: 14 };
  candidates.push({
    min: globalDefaults.min_service_days,
    max: globalDefaults.max_service_days,
    source: 'global_default',
  });

  const min = candidates.find((candidate) => candidate.min !== null && candidate.min !== undefined);
  const max = candidates.find((candidate) => candidate.max !== null && candidate.max !== undefined);

  if (!min || !max) {
    throw badRequest('SERVICE_INTERVAL_UNRESOLVED', 'не удалось определить межсервисный интервал');
  }
  if (Number(min.min) > Number(max.max)) {
    throw badRequest(
      'SERVICE_INTERVAL_INVALID',
      `минимальный интервал (${min.min} дн., источник: ${min.source}) больше максимального (${max.max} дн., источник: ${max.source})`,
    );
  }

  return {
    minServiceDays: Number(min.min),
    maxServiceDays: Number(max.max),
    minSource: min.source,
    maxSource: max.source,
  };
}
