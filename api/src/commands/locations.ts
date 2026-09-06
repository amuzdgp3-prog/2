import type { Client } from '../db/pool.js';
import { auditDelete, auditInsert, auditUpdate, type Actor } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { lockLocationLifecycle, lockMachines } from '../lib/locks.js';
import { assertAdmin } from '../lib/scope.js';
import { createFinalService } from './services.js';

export async function createLocation(
  client: Client,
  actor: Actor,
  input: {
    name: string;
    address?: string;
    timezone: string;
    parentId?: number | null;
    minServiceDays?: number | null;
    maxServiceDays?: number | null;
  },
): Promise<Record<string, unknown>> {
  assertAdmin(actor);
  const inserted = await client.query(
    `INSERT INTO locations (name, address, timezone, parent_id, min_service_days, max_service_days)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      input.name,
      input.address ?? '',
      input.timezone,
      input.parentId ?? null,
      input.minServiceDays ?? null,
      input.maxServiceDays ?? null,
    ],
  );
  await auditInsert(client, actor, 'location', inserted.rows[0].id, inserted.rows[0]);
  return inserted.rows[0];
}

export async function updateLocation(
  client: Client,
  actor: Actor,
  locationId: number,
  patch: {
    name?: string;
    address?: string;
    timezone?: string;
    parentId?: number | null;
    minServiceDays?: number | null;
    maxServiceDays?: number | null;
  },
): Promise<Record<string, unknown>> {
  assertAdmin(actor);
  const before = await client.query('SELECT * FROM locations WHERE id = $1', [locationId]);
  if (before.rowCount === 0) throw notFound('точка не существует');

  const after = await client.query(
    `UPDATE locations SET
       name             = COALESCE($2, name),
       address          = COALESCE($3, address),
       timezone         = COALESCE($4, timezone),
       parent_id        = CASE WHEN $5::boolean THEN $6::bigint ELSE parent_id END,
       min_service_days = CASE WHEN $7::boolean THEN $8::integer ELSE min_service_days END,
       max_service_days = CASE WHEN $9::boolean THEN $10::integer ELSE max_service_days END
     WHERE id = $1 RETURNING *`,
    [
      locationId,
      patch.name ?? null,
      patch.address ?? null,
      patch.timezone ?? null,
      patch.parentId !== undefined,
      patch.parentId ?? null,
      patch.minServiceDays !== undefined,
      patch.minServiceDays ?? null,
      patch.maxServiceDays !== undefined,
      patch.maxServiceDays ?? null,
    ],
  );
  await auditUpdate(client, actor, 'location', locationId, before.rows[0], after.rows[0]);
  return after.rows[0];
}

/**
 * deactivateLocation (10_ТЗ §2): the point stops working, no Service and no working revenue,
 * but machines, placements and technician scope are preserved.
 */
export async function setLocationStatus(
  client: Client,
  actor: Actor,
  locationId: number,
  status: 'ACTIVE' | 'DEACTIVATED',
): Promise<Record<string, unknown>> {
  assertAdmin(actor);
  await lockLocationLifecycle(client, locationId);

  // Row lock in the same Location → Machine order used by Service: this blocks until any Service
  // already in flight for this Location commits, closing the deactivation TOCTOU window.
  const before = await client.query('SELECT * FROM locations WHERE id = $1 FOR UPDATE', [
    locationId,
  ]);
  if (before.rowCount === 0) throw notFound('точка не существует');

  const after = await client.query(
    `UPDATE locations SET status = $2::location_status,
            closed_at = CASE WHEN $2 = 'ACTIVE' THEN NULL ELSE closed_at END
     WHERE id = $1 RETURNING *`,
    [locationId, status],
  );
  await auditUpdate(client, actor, 'location', locationId, before.rows[0], after.rows[0], {
    reason: `status_${status.toLowerCase()}`,
  });
  return after.rows[0];
}

export interface FinalCounterInput {
  machineNumber: string;
  localId: string;
  gameCounter: number;
  prizeCounter: number;
  testGames?: number;
  photoObjectKey: string;
}

/**
 * closeLocation (10_ТЗ §2, 16_CONTRACT §12) — one transaction:
 * lifecycle lock → machine locks ASC → final services → recalc → close placements →
 * close terminal bindings → remove route/technician assignments → CLOSED → audit → COMMIT.
 * Any failure rolls the whole thing back; history is preserved and nothing is deleted.
 */
export async function closeLocation(
  client: Client,
  actor: Actor,
  locationId: number,
  occurredAt: string,
  finalCounters: FinalCounterInput[],
): Promise<{ closedPlacements: number; finalServices: number }> {
  assertAdmin(actor);
  await lockLocationLifecycle(client, locationId);

  const location = await client.query('SELECT * FROM locations WHERE id = $1 FOR UPDATE', [
    locationId,
  ]);
  if (location.rowCount === 0) throw notFound('точка не существует');
  if (location.rows[0].status === 'CLOSED') {
    throw badRequest('LOCATION_ALREADY_CLOSED', 'точка уже закрыта');
  }

  const placements = await client.query(
    `SELECT id, machine_number FROM machine_placements
     WHERE location_id = $1 AND ended_at IS NULL
     ORDER BY machine_number`,
    [locationId],
  );
  const machineNumbers = placements.rows.map((row) => row.machine_number as string);
  await lockMachines(client, machineNumbers);

  const countersByMachine = new Map(finalCounters.map((entry) => [entry.machineNumber, entry]));
  for (const machineNumber of machineNumbers) {
    if (!countersByMachine.has(machineNumber)) {
      throw badRequest(
        'FINAL_COUNTERS_REQUIRED',
        `нужны финальные показания счётчиков для аппарата ${machineNumber}`,
      );
    }
  }

  let finalServices = 0;
  for (const placement of placements.rows) {
    const counters = countersByMachine.get(placement.machine_number as string)!;
    await createFinalService(client, actor, {
      localId: counters.localId,
      placementId: placement.id as number,
      machineNumber: placement.machine_number as string,
      locationId,
      occurredAt,
      gameCounter: counters.gameCounter,
      prizeCounter: counters.prizeCounter,
      testGames: counters.testGames ?? 0,
      photoObjectKey: counters.photoObjectKey,
    });
    finalServices += 1;

    const beforePlacement = await client.query('SELECT * FROM machine_placements WHERE id = $1', [
      placement.id,
    ]);
    const closedPlacement = await client.query(
      `UPDATE machine_placements
       SET ended_at = $2, closed_by = $3, close_reason = 'location_closed'
       WHERE id = $1 RETURNING *`,
      [placement.id, occurredAt, actor.id],
    );
    await auditUpdate(
      client,
      actor,
      'placement',
      placement.id as number,
      beforePlacement.rows[0],
      closedPlacement.rows[0],
    );

    const closedBindings = await client.query(
      `UPDATE terminal_bindings SET ended_at = $2
       WHERE machine_number = $1 AND ended_at IS NULL RETURNING *`,
      [placement.machine_number, occurredAt],
    );
    for (const binding of closedBindings.rows) {
      // The UPDATE (ended_at IS NULL → occurredAt) only ever matched open bindings, so the prior
      // row is exactly this one with ended_at still NULL — no extra SELECT needed to audit it.
      await auditUpdate(client, actor, 'terminal_binding', binding.id, { ...binding, ended_at: null }, binding, {
        reason: 'location_closed',
      });
    }

    const routes = await client.query(
      'DELETE FROM machine_routes WHERE machine_number = $1 RETURNING *',
      [placement.machine_number],
    );
    for (const route of routes.rows) {
      await auditDelete(
        client,
        actor,
        'machine_route',
        `${route.machine_number}:${route.route_id}`,
        route,
      );
    }

    const technicians = await client.query(
      'DELETE FROM machine_technicians WHERE machine_number = $1 RETURNING *',
      [placement.machine_number],
    );
    for (const assignment of technicians.rows) {
      await auditDelete(
        client,
        actor,
        'machine_technician',
        `${assignment.machine_number}:${assignment.staff_id}`,
        assignment,
      );
    }
  }

  const closedLocation = await client.query(
    `UPDATE locations SET status = 'CLOSED', closed_at = $2 WHERE id = $1 RETURNING *`,
    [locationId, occurredAt],
  );
  await auditUpdate(
    client,
    actor,
    'location',
    locationId,
    location.rows[0],
    closedLocation.rows[0],
    { reason: 'close_location' },
  );

  return { closedPlacements: placements.rowCount ?? 0, finalServices };
}
