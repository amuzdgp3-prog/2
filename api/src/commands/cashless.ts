import { createHash } from 'node:crypto';
import type { Client } from '../db/pool.js';
import { recalcMachineChain } from '../domain/counterChain.js';
import { auditUpdate, type Actor } from '../lib/audit.js';
import { lockMachines } from '../lib/locks.js';
import { assertAdmin } from '../lib/scope.js';

export interface RawTransaction {
  providerTransactionId?: string | null;
  terminalExternalId: string;
  occurredAt: string;
  amount: string | number;
  paymentType: string;
  raw?: Record<string, unknown>;
}

/**
 * Deterministic fallback identity (10_ТЗ §21.4). Used only when the provider gives no
 * transaction id. It is built from stable payload fields, never from local import time.
 */
export function transactionFingerprint(provider: string, tx: RawTransaction): string {
  const canonical = [
    provider,
    tx.terminalExternalId,
    new Date(tx.occurredAt).toISOString(),
    Number(tx.amount).toFixed(2),
    tx.paymentType,
    JSON.stringify(tx.raw?.external_ref ?? ''),
  ].join('|');
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Historical matching (10_ТЗ §14): a transaction belongs to the Machine that the Terminal was
 * bound to at occurred_at, not to the current binding. Unmatched rows are kept with a reason
 * and can be rematched later.
 */
async function matchTransactions(
  client: Client,
  actor: Actor,
  transactionIds: number[],
): Promise<string[]> {
  if (transactionIds.length === 0) return [];

  const candidates = await client.query(
    `SELECT DISTINCT b.machine_number
     FROM cashless_transactions t
     JOIN terminals term ON term.serial = t.terminal_external_id
     JOIN terminal_bindings b ON b.terminal_id = term.id
       AND tstzrange(b.started_at, b.ended_at) @> t.occurred_at
     WHERE t.id = ANY($1::bigint[])`,
    [transactionIds],
  );
  const affectedMachines = candidates.rows.map((row) => row.machine_number as string);
  await lockMachines(client, affectedMachines);

  const matched = await client.query(
    `UPDATE cashless_transactions t
     SET terminal_id            = term.id,
         matched_machine_number = b.machine_number,
         matched_placement_id   = p.id,
         matched_location_id    = b.location_id,
         match_status           = 'MATCHED',
         matched_at             = now(),
         unmatched_reason       = NULL
     FROM terminals term
     JOIN terminal_bindings b ON b.terminal_id = term.id
     JOIN machine_placements p ON p.machine_number = b.machine_number
     WHERE t.id = ANY($1::bigint[])
       AND term.serial = t.terminal_external_id
       AND tstzrange(b.started_at, b.ended_at) @> t.occurred_at
       AND tstzrange(p.started_at, p.ended_at) @> t.occurred_at
     RETURNING t.id, t.matched_machine_number`,
    [transactionIds],
  );

  const matchedIds = new Set(matched.rows.map((row) => row.id as number));
  const unmatchedIds = transactionIds.filter((id) => !matchedIds.has(id));

  if (unmatchedIds.length > 0) {
    await client.query(
      `UPDATE cashless_transactions t
       SET match_status = 'UNMATCHED',
           unmatched_reason = CASE
             WHEN NOT EXISTS (SELECT 1 FROM terminals term WHERE term.serial = t.terminal_external_id)
               THEN 'unknown terminal'
             WHEN NOT EXISTS (
               SELECT 1 FROM terminals term
               JOIN terminal_bindings b ON b.terminal_id = term.id
               WHERE term.serial = t.terminal_external_id
                 AND tstzrange(b.started_at, b.ended_at) @> t.occurred_at)
               THEN 'no terminal binding at occurred_at'
             ELSE 'no placement covering occurred_at'
           END,
           matched_machine_number = NULL,
           matched_placement_id = NULL,
           matched_location_id = NULL,
           matched_at = NULL
       WHERE t.id = ANY($1::bigint[])`,
      [unmatchedIds],
    );
  }

  const touched = [
    ...new Set([...affectedMachines, ...matched.rows.map((row) => row.matched_machine_number as string)]),
  ].filter(Boolean);

  for (const machineNumber of touched.sort()) {
    await recalcMachineChain(client, machineNumber, actor, 'cashless_matched');
  }
  return touched;
}

/**
 * Idempotent import. The parser normalizes and deduplicates, but never creates a Service and
 * never touches game counters (10_ТЗ §13, 11_АРХИТЕКТУРА §12). Duplicate protection is done by
 * the database identity indexes, not by a pre-check.
 */
export async function importCashless(
  client: Client,
  actor: Actor,
  provider: string,
  transactions: RawTransaction[],
): Promise<{ received: number; inserted: number; duplicates: number; machinesTouched: string[] }> {
  assertAdmin(actor);
  const insertedIds: number[] = [];

  for (const tx of transactions) {
    const providerTransactionId = tx.providerTransactionId ?? null;
    const fingerprint = providerTransactionId ? null : transactionFingerprint(provider, tx);

    const inserted = await client.query(
      `INSERT INTO cashless_transactions (
         provider, provider_transaction_id, transaction_fingerprint, terminal_external_id,
         occurred_at, amount, payment_type, raw_payload)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8::jsonb)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        provider,
        providerTransactionId,
        fingerprint,
        tx.terminalExternalId,
        tx.occurredAt,
        String(tx.amount),
        tx.paymentType,
        JSON.stringify(tx.raw ?? {}),
      ],
    );

    if (inserted.rowCount === 1) {
      insertedIds.push(inserted.rows[0].id as number);
      // Раньше здесь стоял auditInsert на каждую строку (DECISION-043): 155 298 из 171 тысяч
      // записей audit_log — точные копии cashless_transactions, таблицы, которая и так
      // неизменяема и полностью читаема сама по себе (rowCount, отфильтрованный по provider/
      // occurred_at). Аудит остаётся там, где он несёт информацию, которой нет в самой таблице —
      // на ручной правке сохранённой транзакции (updateCashlessTransaction ниже, auditUpdate).
    }
  }

  const machinesTouched = await matchTransactions(client, actor, insertedIds);

  return {
    received: transactions.length,
    inserted: insertedIds.length,
    duplicates: transactions.length - insertedIds.length,
    machinesTouched,
  };
}

/** Rematches stored transactions, e.g. after a terminal binding was corrected. */
export async function rematchCashless(
  client: Client,
  actor: Actor,
  filter: { from?: string; terminalId?: number; onlyUnmatched?: boolean },
): Promise<{ processed: number; machinesTouched: string[] }> {
  assertAdmin(actor);
  const rows = await client.query(
    `SELECT t.id FROM cashless_transactions t
     LEFT JOIN terminals term ON term.serial = t.terminal_external_id
     WHERE ($1::timestamptz IS NULL OR t.occurred_at >= $1::timestamptz)
       AND ($2::bigint IS NULL OR term.id = $2::bigint)
       AND ($3::boolean IS FALSE OR t.match_status = 'UNMATCHED')
     ORDER BY t.id`,
    [filter.from ?? null, filter.terminalId ?? null, filter.onlyUnmatched ?? false],
  );

  const ids = rows.rows.map((row) => row.id as number);
  const machinesTouched = await matchTransactions(client, actor, ids);
  return { processed: ids.length, machinesTouched };
}

/** Admin correction of a single stored transaction; audited like any business mutation. */
export async function updateCashlessTransaction(
  client: Client,
  actor: Actor,
  id: number,
  patch: { amount?: string | number; paymentType?: string },
): Promise<Record<string, unknown>> {
  assertAdmin(actor);
  const before = await client.query('SELECT * FROM cashless_transactions WHERE id = $1', [id]);
  const after = await client.query(
    `UPDATE cashless_transactions
     SET amount = COALESCE($2, amount), payment_type = COALESCE($3, payment_type)
     WHERE id = $1 RETURNING *`,
    [id, patch.amount === undefined ? null : String(patch.amount), patch.paymentType ?? null],
  );
  await auditUpdate(client, actor, 'cashless_transaction', id, before.rows[0], after.rows[0]);

  const machineNumber = after.rows[0].matched_machine_number as string | null;
  if (machineNumber) {
    await lockMachines(client, [machineNumber]);
    await recalcMachineChain(client, machineNumber, actor, 'cashless_amount_edited');
  }
  return after.rows[0];
}
