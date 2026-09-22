import type { Client } from '../db/pool.js';
import { auditInsert, auditUpdate, type Actor } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { lockMachines } from '../lib/locks.js';
import { assertAdmin } from '../lib/scope.js';
import { rematchCashless } from './cashless.js';

export async function createTerminal(
  client: Client,
  actor: Actor,
  input: { serial: string; provider: string; label?: string },
): Promise<Record<string, unknown>> {
  assertAdmin(actor);
  // Безнал сопоставляется точным равенством serial = terminal_external_id (cashless.ts), поэтому
  // невидимый пробел по краям навсегда отрезал бы терминал от его транзакций.
  const serial = input.serial.trim();
  if (serial === '') throw badRequest('SERIAL_REQUIRED', 'серийный номер не может быть пустым');
  const inserted = await client.query(
    `INSERT INTO terminals (serial, provider, label) VALUES ($1, $2, $3) RETURNING *`,
    [serial, input.provider, input.label ?? ''],
  );
  await auditInsert(client, actor, 'terminal', inserted.rows[0].id, inserted.rows[0]);
  return inserted.rows[0];
}

/**
 * Номер терминала на сайте iVend восьмизначный и начинается с «50» (50264785), но владелец
 * оперирует короткой формой без этих цифр (264785). Завести короткую форму как новый терминал
 * система не мешала: UNIQUE сравнивает строки дословно, а дальше такая запись мертва — парсер
 * опрашивает iVend только по точным серийникам, и транзакции не приходят вовсе (DECISION-084).
 * Сравнение по последним пяти цифрам ловит и пропущенный префикс, и опечатку в начале номера.
 */
const SIMILAR_SUFFIX_LENGTH = 5;

export async function findSimilarTerminals(
  client: Pick<Client, 'query'>,
  serial: string,
): Promise<Record<string, unknown>[]> {
  const digits = serial.replace(/\D/g, '');
  if (digits.length < SIMILAR_SUFFIX_LENGTH) return [];

  const result = await client.query(
    `SELECT t.id, t.serial, t.status,
            b.machine_number AS bound_machine,
            b.started_at     AS bound_since,
            p.address,
            l.name AS location_name
     FROM terminals t
     LEFT JOIN terminal_bindings b ON b.terminal_id = t.id AND b.ended_at IS NULL
     LEFT JOIN machine_placements p ON p.machine_number = b.machine_number AND p.ended_at IS NULL
     LEFT JOIN locations l ON l.id = p.location_id
     WHERE right(regexp_replace(t.serial, '\\D', '', 'g'), $1::int) = right($2, $1::int)
       AND t.serial <> $3
     ORDER BY t.serial`,
    [SIMILAR_SUFFIX_LENGTH, digits, serial.trim()],
  );
  return result.rows;
}

/**
 * terminalBind / terminalReplace (10_ТЗ §6, 14_BASELINE §9): closes the previous interval of this
 * terminal and opens a new one. A terminal is never carried over automatically when a machine is
 * replaced, and a machine can hold at most one active terminal. Because historical cashless
 * ownership is derived from these intervals, affected transactions are rematched and the machine
 * chains are recalculated inside the same transaction.
 */
export async function bindTerminal(
  client: Client,
  actor: Actor,
  input: { terminalId: number; machineNumber: string; startedAt: string },
): Promise<Record<string, unknown>> {
  assertAdmin(actor);

  const terminal = await client.query('SELECT * FROM terminals WHERE id = $1', [input.terminalId]);
  if (terminal.rowCount === 0) throw notFound('терминал не существует');

  const placement = await client.query(
    `SELECT p.id, p.location_id FROM machine_placements p
     WHERE p.machine_number = $1 AND tstzrange(p.started_at, p.ended_at) @> $2::timestamptz`,
    [input.machineNumber, input.startedAt],
  );
  if (placement.rowCount === 0) {
    throw badRequest('NO_PLACEMENT_AT_TIME', 'на этот момент аппарат не был установлен ни на одной точке');
  }

  // Locked before the occupancy check (not just before the final insert) so two concurrent binds
  // of two different terminals to this same destination machine can't both read "unoccupied"
  // before either commits.
  await lockMachines(client, [input.machineNumber]);

  const machineBinding = await client.query(
    `SELECT * FROM terminal_bindings
     WHERE machine_number = $1 AND ended_at IS NULL AND terminal_id <> $2`,
    [input.machineNumber, input.terminalId],
  );
  if (machineBinding.rowCount) {
    throw badRequest(
      'MACHINE_TERMINAL_OCCUPIED',
      'на аппарате уже есть привязанный терминал — сначала снимите его',
    );
  }

  const previous = await client.query(
    `UPDATE terminal_bindings SET ended_at = $2
     WHERE terminal_id = $1 AND ended_at IS NULL RETURNING *`,
    [input.terminalId, input.startedAt],
  );
  for (const row of previous.rows) {
    // The UPDATE (ended_at IS NULL → startedAt) only ever matched open bindings, so the prior row
    // is exactly this one with ended_at still NULL.
    await auditUpdate(client, actor, 'terminal_binding', row.id, { ...row, ended_at: null }, row, {
      reason: 'rebind',
    });
  }

  await lockMachines(
    client,
    [input.machineNumber, ...previous.rows.map((row) => row.machine_number as string)],
  );

  const binding = await client.query(
    `INSERT INTO terminal_bindings (terminal_id, machine_number, location_id, started_at, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [
      input.terminalId,
      input.machineNumber,
      placement.rows[0].location_id,
      input.startedAt,
      actor.id,
    ],
  );
  await auditInsert(client, actor, 'terminal_binding', binding.rows[0].id, binding.rows[0]);

  const installed = await client.query(
    `UPDATE terminals SET status = 'INSTALLED' WHERE id = $1 RETURNING *`,
    [input.terminalId],
  );
  await auditUpdate(
    client,
    actor,
    'terminal',
    input.terminalId,
    terminal.rows[0],
    installed.rows[0],
    { reason: 'terminal_bound' },
  );

  await rematchCashless(client, actor, { terminalId: input.terminalId });

  return binding.rows[0];
}

export async function unbindTerminal(
  client: Client,
  actor: Actor,
  input: { terminalId: number; endedAt: string },
): Promise<Record<string, unknown> | null> {
  assertAdmin(actor);

  const unlocked = await client.query(
    `SELECT machine_number FROM terminal_bindings WHERE terminal_id = $1 AND ended_at IS NULL`,
    [input.terminalId],
  );
  if (unlocked.rowCount === 0) return null;

  await lockMachines(client, [unlocked.rows[0].machine_number as string]);

  // Re-read under the lock: a concurrent unbind for the same terminal may have already closed
  // this binding while we were waiting for it.
  const active = await client.query(
    `SELECT * FROM terminal_bindings WHERE terminal_id = $1 AND ended_at IS NULL`,
    [input.terminalId],
  );
  if (active.rowCount === 0) return null;

  const closed = await client.query(
    `UPDATE terminal_bindings SET ended_at = $2 WHERE id = $1 AND ended_at IS NULL RETURNING *`,
    [active.rows[0].id, input.endedAt],
  );
  if (closed.rowCount === 0) return null;
  await auditUpdate(client, actor, 'terminal_binding', closed.rows[0].id, active.rows[0], closed.rows[0], {
    reason: 'unbind',
  });

  // The terminal goes back to stock; it is not carried to another machine automatically.
  const terminalBefore = await client.query('SELECT * FROM terminals WHERE id = $1', [
    input.terminalId,
  ]);
  const returned = await client.query(
    `UPDATE terminals SET status = 'IN_STOCK' WHERE id = $1 RETURNING *`,
    [input.terminalId],
  );
  await auditUpdate(
    client,
    actor,
    'terminal',
    input.terminalId,
    terminalBefore.rows[0],
    returned.rows[0],
    { reason: 'terminal_unbound' },
  );

  await rematchCashless(client, actor, { terminalId: input.terminalId });

  return closed.rows[0];
}
