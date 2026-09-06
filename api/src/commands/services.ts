import type { Client } from '../db/pool.js';
import { recalcMachineChain } from '../domain/counterChain.js';
import { auditDelete, auditInsert, auditUpdate, type Actor } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { lockMachines } from '../lib/locks.js';
import { assertAdmin, assertCanMutate, assertMachineInScope } from '../lib/scope.js';

export interface ToyLine {
  toyId: number;
  quantity: number;
}

export interface ServiceInput {
  localId: string;
  machineNumber: string;
  occurredAt: string;
  gameCounter: number;
  prizeCounter: number;
  testGames?: number;
  toys?: ToyLine[];
  photoObjectKey: string;
  notes?: string;
}

interface ActivePlacement {
  id: number;
  machine_number: string;
  location_id: number;
  started_at: Date;
  timezone: string;
  location_status: string;
}

async function loadActivePlacement(
  client: Client,
  machineNumber: string,
): Promise<ActivePlacement> {
  const result = await client.query<ActivePlacement>(
    `SELECT p.id, p.machine_number, p.location_id, p.started_at,
            l.timezone, l.status AS location_status
     FROM machine_placements p
     JOIN locations l ON l.id = p.location_id
     WHERE p.machine_number = $1 AND p.ended_at IS NULL`,
    [machineNumber],
  );
  if (result.rowCount === 0) {
    throw badRequest('NO_ACTIVE_PLACEMENT', 'аппарат сейчас не установлен ни на одной точке');
  }
  return result.rows[0];
}

/**
 * Canonical lock order is Location → Machine, and every path that reads or changes the lifecycle
 * status follows it. A Service takes a shared row lock on its Location before locking the Machine,
 * so a concurrent deactivateLocation/closeLocation cannot slip between the status check and the
 * insert: the lifecycle change waits for the Service to commit, and any Service starting after it
 * reads the new status and is rejected.
 */
async function lockPlacementAndLocation(
  client: Client,
  machineNumber: string,
): Promise<ActivePlacement> {
  const unlocked = await loadActivePlacement(client, machineNumber);
  await client.query('SELECT id FROM locations WHERE id = $1 FOR SHARE', [unlocked.location_id]);
  await lockMachines(client, [machineNumber]);
  // Re-read under both locks: the placement may have been closed while we were waiting.
  return loadActivePlacement(client, machineNumber);
}

async function assertPhotoExists(client: Client, objectKey: string): Promise<void> {
  const photo = await client.query('SELECT 1 FROM photo_objects WHERE object_key = $1', [objectKey]);
  if (photo.rowCount === 0) {
    // The counter photo is mandatory; it must be uploaded before the Service is committed.
    throw badRequest('COUNTER_PHOTO_REQUIRED', 'фото счётчика должно быть загружено до сохранения обслуживания');
  }
}

async function writeToyLines(
  client: Client,
  actor: Actor,
  serviceId: number,
  toys: ToyLine[],
): Promise<void> {
  for (const line of toys) {
    // Toy price is resolved server-side; a price sent by the client is never trusted.
    const inserted = await client.query(
      `INSERT INTO toy_distributions (service_id, toy_id, quantity, unit_cost_snapshot)
       SELECT $1, t.id, $3, t.unit_cost FROM toys t WHERE t.id = $2
       RETURNING *`,
      [serviceId, line.toyId, line.quantity],
    );
    if (inserted.rowCount === 0) throw notFound(`игрушка №${line.toyId} не существует`);
    await auditInsert(
      client,
      actor,
      'toy_distribution',
      `${serviceId}:${line.toyId}`,
      inserted.rows[0],
    );
  }
}

interface InsertParams {
  localId: string;
  placementId: number;
  machineNumber: string;
  locationId: number;
  occurredAt: string;
  gameCounter: number;
  prizeCounter: number;
  testGames: number;
  photoObjectKey: string;
  notes?: string;
  kind: 'REGULAR' | 'FINAL';
  technicianId: number | null;
}

/**
 * Inserts the Service row itself. Financial columns are placeholders: the values are produced by
 * the chain recalculation later in the same transaction, so there is exactly one implementation
 * of the counter and revenue formulas.
 */
async function insertServiceRow(
  client: Client,
  actor: Actor,
  params: InsertParams,
): Promise<{ row: Record<string, unknown>; alreadyExisted: boolean }> {
  const inserted = await client.query(
    `INSERT INTO services (
       local_id, placement_id, machine_number, kind, service_date, occurred_at, technician_id,
       game_counter, prize_counter, test_games, new_games, new_prizes,
       price_per_game_snapshot, counter_divisor_applied, revenue,
       photo_object_key, notes, created_by)
     SELECT $1, $2, $3, $4::service_kind,
            ($5::timestamptz AT TIME ZONE l.timezone)::date,
            $5::timestamptz, $6,
            $7, $8, $9, 0, 0,
            -- Price and divisor are both snapshotted server-side at the moment of recording.
            m.price_per_game,
            CASE WHEN m.counter_divisor IS NULL OR m.counter_divisor <= 0
                 THEN 1.00 ELSE m.counter_divisor END,
            0, $10, $11, $12
     FROM machines m
     CROSS JOIN locations l
     WHERE m.machine_number = $3 AND l.id = $13
     ON CONFLICT (local_id) DO NOTHING
     RETURNING *`,
    [
      params.localId,
      params.placementId,
      params.machineNumber,
      params.kind,
      params.occurredAt,
      params.technicianId,
      params.gameCounter,
      params.prizeCounter,
      params.testGames,
      params.photoObjectKey,
      params.notes ?? '',
      actor.id,
      params.locationId,
    ],
  );

  if (inserted.rowCount === 1) {
    return { row: inserted.rows[0], alreadyExisted: false };
  }

  // local_id is the database idempotency authority: a repeated offline sync of the same payload
  // returns the stored Service, while a conflicting payload is rejected without overwriting it.
  const existing = await client.query('SELECT * FROM services WHERE local_id = $1', [
    params.localId,
  ]);
  if (existing.rowCount === 0) {
    throw conflict('SERVICE_INSERT_FAILED', 'не удалось сохранить обслуживание');
  }
  const row = existing.rows[0];
  const samePayload =
    Number(row.placement_id) === Number(params.placementId) &&
    row.machine_number === params.machineNumber &&
    Number(row.game_counter) === Number(params.gameCounter) &&
    Number(row.prize_counter) === Number(params.prizeCounter) &&
    Number(row.test_games) === Number(params.testGames) &&
    new Date(row.occurred_at as string).getTime() === new Date(params.occurredAt).getTime();

  if (!samePayload) {
    throw conflict('LOCAL_ID_CONFLICT', 'обслуживание с таким идентификатором уже сохранено с другими данными', {
      serviceId: row.id,
    });
  }
  return { row, alreadyExisted: true };
}

async function reloadService(client: Client, id: number): Promise<Record<string, unknown>> {
  const result = await client.query('SELECT * FROM services WHERE id = $1', [id]);
  return result.rows[0];
}

/**
 * Regular Service (10_ТЗ §7 §22). Runs under the canonical protocol:
 * lock machine → validate → insert → recalculate chain → audit → commit.
 */
export async function createService(
  client: Client,
  actor: Actor,
  input: ServiceInput,
): Promise<{ service: Record<string, unknown>; idempotentReplay: boolean }> {
  assertCanMutate(actor);
  await assertMachineInScope(client, actor, input.machineNumber);

  const placement = await lockPlacementAndLocation(client, input.machineNumber);
  if (placement.location_status !== 'ACTIVE') {
    throw badRequest(
      'LOCATION_NOT_ACTIVE',
      'обслуживание можно вносить только для точки в статусе «активна»',
    );
  }
  if (new Date(input.occurredAt) < new Date(placement.started_at)) {
    throw badRequest('BEFORE_PLACEMENT_START', 'дата обслуживания раньше даты установки аппарата на точке');
  }
  if (new Date(input.occurredAt).getTime() > Date.now() + 5 * 60_000) {
    throw badRequest('FUTURE_OCCURRED_AT', 'обслуживание не может быть датировано будущим временем');
  }
  await assertPhotoExists(client, input.photoObjectKey);

  const { row, alreadyExisted } = await insertServiceRow(client, actor, {
    localId: input.localId,
    placementId: placement.id,
    machineNumber: input.machineNumber,
    locationId: placement.location_id,
    occurredAt: input.occurredAt,
    gameCounter: input.gameCounter,
    prizeCounter: input.prizeCounter,
    testGames: input.testGames ?? 0,
    photoObjectKey: input.photoObjectKey,
    notes: input.notes,
    kind: 'REGULAR',
    technicianId: actor.role === 'TECHNICIAN' ? actor.id : null,
  });

  if (alreadyExisted) {
    return { service: row, idempotentReplay: true };
  }

  const serviceId = row.id as number;
  await writeToyLines(client, actor, serviceId, input.toys ?? []);
  await recalcMachineChain(client, input.machineNumber, actor, 'service_created');

  const stored = await reloadService(client, serviceId);
  await auditInsert(client, actor, 'service', serviceId, stored);
  return { service: stored, idempotentReplay: false };
}

/** Final Service used by replaceMachine and closeLocation; the counters are admin-provided. */
export async function createFinalService(
  client: Client,
  actor: Actor,
  input: {
    localId: string;
    placementId: number;
    machineNumber: string;
    locationId: number;
    occurredAt: string;
    gameCounter: number;
    prizeCounter: number;
    testGames: number;
    photoObjectKey: string;
  },
): Promise<{ id: number }> {
  await assertPhotoExists(client, input.photoObjectKey);
  const { row } = await insertServiceRow(client, actor, {
    ...input,
    notes: 'final service',
    kind: 'FINAL',
    technicianId: null,
  });
  await recalcMachineChain(client, input.machineNumber, actor, 'final_service_created');
  const stored = await reloadService(client, row.id as number);
  await auditInsert(client, actor, 'service', row.id as number, stored);
  return { id: row.id as number };
}

/**
 * Admin correction of a stored Service. Technicians never edit services (16_CONTRACT §15).
 * The dependent chain is recalculated before COMMIT.
 */
export async function updateService(
  client: Client,
  actor: Actor,
  serviceId: number,
  patch: {
    gameCounter?: number;
    prizeCounter?: number;
    testGames?: number;
    occurredAt?: string;
    notes?: string;
    toys?: ToyLine[];
  },
): Promise<Record<string, unknown>> {
  assertAdmin(actor);

  const current = await client.query('SELECT * FROM services WHERE id = $1', [serviceId]);
  if (current.rowCount === 0) throw notFound('обслуживание не существует');
  const before = current.rows[0];
  const machineNumber = before.machine_number as string;

  if (patch.occurredAt && new Date(patch.occurredAt).getTime() > Date.now() + 5 * 60_000) {
    throw badRequest('FUTURE_OCCURRED_AT', 'обслуживание не может быть датировано будущим временем');
  }

  await lockMachines(client, [machineNumber]);

  const after = await client.query(
    `UPDATE services s SET
       game_counter = COALESCE($2, s.game_counter),
       prize_counter = COALESCE($3, s.prize_counter),
       test_games   = COALESCE($4, s.test_games),
       occurred_at  = COALESCE($5::timestamptz, s.occurred_at),
       service_date = (COALESCE($5::timestamptz, s.occurred_at) AT TIME ZONE l.timezone)::date,
       notes        = COALESCE($6, s.notes)
     FROM machine_placements p
     JOIN locations l ON l.id = p.location_id
     WHERE s.id = $1 AND p.id = s.placement_id
     RETURNING s.*`,
    [
      serviceId,
      patch.gameCounter ?? null,
      patch.prizeCounter ?? null,
      patch.testGames ?? null,
      patch.occurredAt ?? null,
      patch.notes ?? null,
    ],
  );

  if (patch.toys) {
    const oldLines = await client.query('SELECT * FROM toy_distributions WHERE service_id = $1', [
      serviceId,
    ]);
    await client.query('DELETE FROM toy_distributions WHERE service_id = $1', [serviceId]);
    for (const line of oldLines.rows) {
      await auditDelete(client, actor, 'toy_distribution', `${serviceId}:${line.toy_id}`, line);
    }
    await writeToyLines(client, actor, serviceId, patch.toys);
  }

  await recalcMachineChain(client, machineNumber, actor, 'service_edited');
  const stored = await reloadService(client, serviceId);
  await auditUpdate(client, actor, 'service', serviceId, before, stored);
  return stored;
}

/** Deletes a Service and repairs the dependent chain in the same transaction. */
export async function deleteService(
  client: Client,
  actor: Actor,
  serviceId: number,
): Promise<void> {
  assertAdmin(actor);

  const current = await client.query('SELECT * FROM services WHERE id = $1', [serviceId]);
  if (current.rowCount === 0) throw notFound('обслуживание не существует');
  const before = current.rows[0];
  const machineNumber = before.machine_number as string;

  await lockMachines(client, [machineNumber]);
  await client.query('DELETE FROM services WHERE id = $1', [serviceId]);
  await auditDelete(client, actor, 'service', serviceId, before);
  await recalcMachineChain(client, machineNumber, actor, 'service_deleted');
}
