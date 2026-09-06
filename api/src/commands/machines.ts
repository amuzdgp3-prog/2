import type { Client } from '../db/pool.js';
import { recalcMachineChain } from '../domain/counterChain.js';
import { auditInsert, auditUpdate, type Actor } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { lockMachines } from '../lib/locks.js';
import { assertAdmin } from '../lib/scope.js';
import { bindTerminal, unbindTerminal } from './terminals.js';

export interface MachineInput {
  machineNumber: string;
  machineType?: string;
  model?: string;
  pricePerGame: string | number;
  counterDivisor?: string | number | null;
  minServiceDays?: number | null;
  maxServiceDays?: number | null;
}

export interface InitialToyInput {
  toyId: number;
  quantity: number;
}

/** A non-positive or missing divisor is stored as 1.00, i.e. the legacy behaviour. */
export function sanitizeDivisor(input: unknown): string {
  const value = Number(input);
  if (!Number.isFinite(value) || value <= 0) return '1.00';
  return value.toFixed(2);
}

async function assertMachineNumberFree(client: Client, machineNumber: string): Promise<void> {
  const existing = await client.query(
    `SELECT (SELECT 1 FROM machines WHERE machine_number = $1) AS as_machine,
            (SELECT 1 FROM machine_numbers WHERE machine_number = $1) AS as_number`,
    [machineNumber],
  );
  if (existing.rows[0].as_machine) {
    throw conflict('MACHINE_NUMBER_IN_USE', 'такой номер аппарата уже используется');
  }
  if (existing.rows[0].as_number) {
    // A number that was ever issued is never reused, even after the machine is retired.
    throw conflict('MACHINE_NUMBER_RETIRED', 'этот номер аппарата уже был использован и не может быть выдан повторно');
  }
}

/**
 * installMachine (10_ТЗ §4, 14_BASELINE §10) — a separate atomic operation, never a Service.
 * It creates the Machine, the Placement, the initial counters and the initial toys at once.
 * Initial toys are Placement state and are not the cost of the first Service.
 */
export async function installMachine(
  client: Client,
  actor: Actor,
  input: MachineInput & {
    locationId: number;
    startedAt: string;
    initialGameCounter: number;
    initialPrizeCounter: number;
    initialToys?: InitialToyInput[];
    address?: string | null;
  },
): Promise<{ machineNumber: string; placementId: number }> {
  assertAdmin(actor);
  await lockMachines(client, [input.machineNumber]);
  await assertMachineNumberFree(client, input.machineNumber);

  const location = await client.query('SELECT id, status FROM locations WHERE id = $1', [
    input.locationId,
  ]);
  if (location.rowCount === 0) throw notFound('точка не существует');
  if (location.rows[0].status !== 'ACTIVE') {
    throw badRequest('LOCATION_NOT_ACTIVE', 'аппарат можно установить только на точку в статусе «активна»');
  }

  const machine = await client.query(
    `INSERT INTO machines (machine_number, machine_type, model, price_per_game, counter_divisor,
                           min_service_days, max_service_days)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      input.machineNumber,
      input.machineType ?? 'CRANE',
      input.model ?? '',
      String(input.pricePerGame),
      sanitizeDivisor(input.counterDivisor ?? 1),
      input.minServiceDays ?? null,
      input.maxServiceDays ?? null,
    ],
  );
  await auditInsert(client, actor, 'machine', input.machineNumber, machine.rows[0]);

  const placement = await client.query(
    `INSERT INTO machine_placements (machine_number, location_id, started_at,
                                     initial_game_counter, initial_prize_counter, installed_by, address)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      input.machineNumber,
      input.locationId,
      input.startedAt,
      input.initialGameCounter,
      input.initialPrizeCounter,
      actor.id,
      input.address ?? null,
    ],
  );
  const placementId = placement.rows[0].id as number;
  await auditInsert(client, actor, 'placement', placementId, placement.rows[0]);

  for (const toy of input.initialToys ?? []) {
    const inserted = await client.query(
      `INSERT INTO placement_initial_toys (placement_id, toy_id, quantity, unit_cost_snapshot)
       SELECT $1, t.id, $3, t.unit_cost FROM toys t WHERE t.id = $2
       RETURNING *`,
      [placementId, toy.toyId, toy.quantity],
    );
    if (inserted.rowCount === 0) throw notFound(`игрушка №${toy.toyId} не существует`);
    await auditInsert(
      client,
      actor,
      'placement_initial_toy',
      `${placementId}:${toy.toyId}`,
      inserted.rows[0],
    );
  }

  return { machineNumber: input.machineNumber, placementId };
}

/**
 * Updates machine attributes. Both the price and the counter divisor are snapshots taken when a
 * Service is recorded, so changing them here affects future services only and never rewrites
 * revenue that has already been reported. Correcting a value that was wrong in the past is a
 * separate, deliberate operation — see applyDivisorToHistory.
 */
export async function updateMachine(
  client: Client,
  actor: Actor,
  machineNumber: string,
  patch: Partial<Omit<MachineInput, 'machineNumber'>> & { status?: 'ACTIVE' | 'RETIRED' },
): Promise<{ machine: Record<string, unknown>; recalculated: number }> {
  assertAdmin(actor);
  await lockMachines(client, [machineNumber]);

  const before = await client.query('SELECT * FROM machines WHERE machine_number = $1', [
    machineNumber,
  ]);
  if (before.rowCount === 0) throw notFound('аппарат не существует');

  const after = await client.query(
    `UPDATE machines SET
       machine_type     = COALESCE($2, machine_type),
       model            = COALESCE($3, model),
       price_per_game   = COALESCE($4, price_per_game),
       counter_divisor  = COALESCE($5, counter_divisor),
       min_service_days = CASE WHEN $6::boolean THEN $7::integer ELSE min_service_days END,
       max_service_days = CASE WHEN $8::boolean THEN $9::integer ELSE max_service_days END,
       status           = COALESCE($10::machine_status, status)
     WHERE machine_number = $1
     RETURNING *`,
    [
      machineNumber,
      patch.machineType ?? null,
      patch.model ?? null,
      patch.pricePerGame === undefined ? null : String(patch.pricePerGame),
      patch.counterDivisor === undefined ? null : sanitizeDivisor(patch.counterDivisor),
      patch.minServiceDays !== undefined,
      patch.minServiceDays ?? null,
      patch.maxServiceDays !== undefined,
      patch.maxServiceDays ?? null,
      patch.status ?? null,
    ],
  );

  await auditUpdate(client, actor, 'machine', machineNumber, before.rows[0], after.rows[0]);

  return { machine: after.rows[0], recalculated: 0 };
}

/**
 * Moves a machine to a different Location without touching the physical device: the same
 * machine_number keeps running, its counter simply carries over from wherever it last stood
 * (the machine wasn't reset — it just got a new administrative home). This is a lighter
 * operation than replaceMachine on purpose: no visit happened, so there is no final counter
 * reading to record and no photo to require, and the machine_number is never retired.
 *
 * This exists because, absent it, reorganising a location hierarchy (e.g. splitting one city
 * location into several territory sub-locations after the fact) had no path forward: every
 * machine stayed on whichever location it was first installed at, permanently, and a
 * technician's Location-scope grant to a sub-location no longer used at install time can never
 * pick up any machine at all — the empty scope isn't a bug, it's just this missing feature.
 */
export async function moveMachine(
  client: Client,
  actor: Actor,
  machineNumber: string,
  input: { locationId: number; movedAt?: string; address?: string | null; detachTerminal?: boolean },
): Promise<{ newPlacementId: number; terminalCarriedOver: boolean }> {
  assertAdmin(actor);
  await lockMachines(client, [machineNumber]);

  const current = await client.query(
    `SELECT p.*,
            COALESCE(last.game_counter, p.initial_game_counter)   AS current_game_counter,
            COALESCE(last.prize_counter, p.initial_prize_counter) AS current_prize_counter
     FROM machine_placements p
     LEFT JOIN LATERAL (
       SELECT game_counter, prize_counter FROM services
       WHERE placement_id = p.id ORDER BY occurred_at DESC, id DESC LIMIT 1
     ) last ON TRUE
     WHERE p.machine_number = $1 AND p.ended_at IS NULL`,
    [machineNumber],
  );
  if (current.rowCount === 0) {
    throw badRequest('NO_ACTIVE_PLACEMENT', 'аппарат сейчас не установлен ни на одной точке');
  }
  const oldPlacement = current.rows[0];
  if (oldPlacement.location_id === input.locationId) {
    throw badRequest('SAME_LOCATION', 'аппарат уже установлен на этой точке');
  }

  const location = await client.query('SELECT id, status FROM locations WHERE id = $1', [
    input.locationId,
  ]);
  if (location.rowCount === 0) throw notFound('точка не существует');
  if (location.rows[0].status !== 'ACTIVE') {
    throw badRequest('LOCATION_NOT_ACTIVE', 'аппарат можно переместить только на точку в статусе «активна»');
  }

  const movedAt = input.movedAt ?? new Date().toISOString();

  const closed = await client.query(
    `UPDATE machine_placements SET ended_at = $2, closed_by = $3, close_reason = 'moved'
     WHERE id = $1 RETURNING *`,
    [oldPlacement.id, movedAt, actor.id],
  );
  await auditUpdate(client, actor, 'placement', oldPlacement.id, oldPlacement, closed.rows[0]);

  const opened = await client.query(
    `INSERT INTO machine_placements (machine_number, location_id, started_at,
                                     initial_game_counter, initial_prize_counter, installed_by, address)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      machineNumber,
      input.locationId,
      movedAt,
      oldPlacement.current_game_counter,
      oldPlacement.current_prize_counter,
      actor.id,
      // A bare location move (no new address given) keeps whatever address was already known —
      // moving between Locations is usually a territory reassignment, not evidence the machine's
      // real street address changed too.
      input.address === undefined ? oldPlacement.address : input.address,
    ],
  );
  await auditInsert(client, actor, 'placement', opened.rows[0].id, opened.rows[0], {
    reason: 'moved',
    fromLocationId: oldPlacement.location_id,
  });

  // The physical vending cabinet carries its own payment terminal with it when it relocates — a
  // move is not a hardware swap (that is replaceMachine's job), so by default the terminal simply
  // keeps working, now billed to the new address. `detachTerminal` is the explicit opt-out for the
  // real exception: the terminal stays behind (a new one will be arranged for the new contract, or
  // the old spot keeps servicing under a different machine, as happened with Шувалова 28).
  const activeBinding = await client.query(
    `SELECT terminal_id FROM terminal_bindings WHERE machine_number = $1 AND ended_at IS NULL`,
    [machineNumber],
  );
  let terminalCarriedOver = false;
  if (activeBinding.rowCount) {
    const terminalId = activeBinding.rows[0].terminal_id as number;
    await unbindTerminal(client, actor, { terminalId, endedAt: movedAt });
    if (!input.detachTerminal) {
      await bindTerminal(client, actor, { terminalId, machineNumber, startedAt: movedAt });
      terminalCarriedOver = true;
    }
  }

  return { newPlacementId: opened.rows[0].id, terminalCarriedOver };
}

/**
 * Corrects or sets the address of a machine's current placement without moving it anywhere —
 * the common case is simply recording the real street address for the first time (see
 * moveMachine's own comment for why this didn't exist as a field at all before).
 */
export async function updateMachineAddress(
  client: Client,
  actor: Actor,
  machineNumber: string,
  address: string | null,
): Promise<{ placement: Record<string, unknown> }> {
  assertAdmin(actor);
  await lockMachines(client, [machineNumber]);

  const before = await client.query(
    `SELECT * FROM machine_placements WHERE machine_number = $1 AND ended_at IS NULL`,
    [machineNumber],
  );
  if (before.rowCount === 0) {
    throw badRequest('NO_ACTIVE_PLACEMENT', 'аппарат сейчас не установлен ни на одной точке');
  }

  const after = await client.query(
    `UPDATE machine_placements SET address = $2 WHERE id = $1 RETURNING *`,
    [before.rows[0].id, address],
  );
  await auditUpdate(client, actor, 'placement', before.rows[0].id, before.rows[0], after.rows[0]);

  return { placement: after.rows[0] };
}

/**
 * Applies the machine's current counter divisor to services that were already recorded, and
 * recalculates the affected chain. This exists for the case where the divisor was configured
 * incorrectly and the stored history is therefore wrong. It is never triggered by simply editing
 * the machine, because a machine whose divisor genuinely changes from a certain date must keep
 * its earlier revenue intact.
 *
 * `from` limits the correction to services on or after that business date.
 */
export async function applyDivisorToHistory(
  client: Client,
  actor: Actor,
  machineNumber: string,
  from?: string,
): Promise<{ restamped: number; recalculated: number }> {
  assertAdmin(actor);
  await lockMachines(client, [machineNumber]);

  const machine = await client.query(
    'SELECT counter_divisor FROM machines WHERE machine_number = $1',
    [machineNumber],
  );
  if (machine.rowCount === 0) throw notFound('аппарат не существует');

  const beforeRows = await client.query(
    `SELECT id, counter_divisor_applied FROM services
     WHERE machine_number = $1
       AND ($2::date IS NULL OR service_date >= $2::date)
       AND counter_divisor_applied IS DISTINCT FROM $3`,
    [machineNumber, from ?? null, machine.rows[0].counter_divisor],
  );
  const beforeById = new Map(beforeRows.rows.map((row) => [row.id as number, row]));

  const restamped = await client.query(
    `UPDATE services
     SET counter_divisor_applied = $2
     WHERE machine_number = $1
       AND ($3::date IS NULL OR service_date >= $3::date)
       AND counter_divisor_applied IS DISTINCT FROM $2
     RETURNING id, counter_divisor_applied`,
    [machineNumber, machine.rows[0].counter_divisor, from ?? null],
  );

  for (const row of restamped.rows) {
    await auditUpdate(client, actor, 'service', row.id as number, beforeById.get(row.id as number), row, {
      reason: 'counter_divisor_applied_to_history',
      from: from ?? null,
    });
  }

  const recalc = await recalcMachineChain(client, machineNumber, actor, 'counter_divisor_restamped');
  return { restamped: restamped.rowCount ?? 0, recalculated: recalc.changed };
}

/**
 * replaceMachine (10_ТЗ §5, 14_BASELINE §10) — atomically closes the old Placement with a final
 * Service and installs a new physical Machine with its own initial counters and toys.
 * Counters of the old and the new machine are never compared.
 */
export async function replaceMachine(
  client: Client,
  actor: Actor,
  input: {
    oldMachineNumber: string;
    occurredAt: string;
    finalGameCounter: number;
    finalPrizeCounter: number;
    testGames?: number;
    localId: string;
    photoObjectKey: string;
    newMachine: MachineInput & {
      initialGameCounter: number;
      initialPrizeCounter: number;
      initialToys?: InitialToyInput[];
      address?: string | null;
    };
  },
): Promise<{ finalServiceId: number; newPlacementId: number }> {
  assertAdmin(actor);
  await lockMachines(client, [input.oldMachineNumber, input.newMachine.machineNumber]);

  const placement = await client.query(
    `SELECT p.*, l.status AS location_status
     FROM machine_placements p
     JOIN locations l ON l.id = p.location_id
     WHERE p.machine_number = $1 AND p.ended_at IS NULL`,
    [input.oldMachineNumber],
  );
  if (placement.rowCount === 0) {
    throw badRequest('NO_ACTIVE_PLACEMENT', 'заменяемый аппарат сейчас не установлен ни на одной точке');
  }
  const oldPlacement = placement.rows[0];

  const { createFinalService } = await import('./services.js');
  const finalService = await createFinalService(client, actor, {
    localId: input.localId,
    placementId: oldPlacement.id,
    machineNumber: input.oldMachineNumber,
    occurredAt: input.occurredAt,
    gameCounter: input.finalGameCounter,
    prizeCounter: input.finalPrizeCounter,
    testGames: input.testGames ?? 0,
    photoObjectKey: input.photoObjectKey,
    locationId: oldPlacement.location_id,
  });

  const closed = await client.query(
    `UPDATE machine_placements SET ended_at = $2, closed_by = $3, close_reason = 'machine_replaced'
     WHERE id = $1 RETURNING *`,
    [oldPlacement.id, input.occurredAt, actor.id],
  );
  await auditUpdate(client, actor, 'placement', oldPlacement.id, oldPlacement, closed.rows[0]);

  const machineBefore = await client.query('SELECT * FROM machines WHERE machine_number = $1', [
    input.oldMachineNumber,
  ]);
  const retired = await client.query(
    `UPDATE machines SET status = 'RETIRED' WHERE machine_number = $1 RETURNING *`,
    [input.oldMachineNumber],
  );
  await auditUpdate(
    client,
    actor,
    'machine',
    input.oldMachineNumber,
    machineBefore.rows[0],
    retired.rows[0],
    { reason: 'machine_replaced' },
  );

  const installed = await installMachine(client, actor, {
    ...input.newMachine,
    locationId: oldPlacement.location_id,
    startedAt: input.occurredAt,
    initialGameCounter: input.newMachine.initialGameCounter,
    initialPrizeCounter: input.newMachine.initialPrizeCounter,
    initialToys: input.newMachine.initialToys,
    // The hardware changed, not the spot it stands in — keep the known address unless the admin
    // deliberately overrides it.
    address: input.newMachine.address === undefined ? oldPlacement.address : input.newMachine.address,
  });

  return { finalServiceId: finalService.id, newPlacementId: installed.placementId };
}
