import { createHash } from 'node:crypto';
import type { Client } from '../db/pool.js';
import { auditInsert, auditUpdate, type Actor } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { assertAdmin } from '../lib/scope.js';

export const CASH_START = '2026-11-01';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
function date(value: string) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value
    || value < CASH_START || value > today()) {
    throw badRequest('INVALID_DATE', 'Укажите существующую дату с 01.11.2026 по сегодня');
  }
}
// Integer kopecks throughout: never sum money with floating point.
const cents = (value: string) => {
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  return BigInt(whole) * (negative ? -100n : 100n) + BigInt(fraction.padEnd(2, '0')) * (negative ? -1n : 1n);
};
const money = (value: bigint) => `${value < 0n ? '-' : ''}${(value < 0n ? -value : value) / 100n}.${String((value < 0n ? -value : value) % 100n).padStart(2, '0')}`;
type Item = { id: number; date: string; amount: string; label: string; category: string };
type Saved = { id: number; period_from: string; period_to: string; expected: string; snapshot: Snapshot };
type Snapshot = {
  from: string; to: string; cash: string; salary: string; fuel: string; other: string; transferred: string;
  adjustment: string; expected: string; services: Item[]; expenses: Item[];
  corrections: Array<{ collectionId: number; from: string; to: string; delta: string }>;
};
const total = (items: Item[]) => items.reduce((sum, item) => sum + cents(item.amount), 0n);
const net = (services: Item[], expenses: Item[]) => total(services) - total(expenses);

async function calculate(client: Client, technicianId: number, to: string) {
  date(to);
  if (!Number.isSafeInteger(technicianId) || technicianId < 1) throw badRequest('INVALID_TECHNICIAN', 'Выберите техника');
  const staff = await client.query("SELECT id FROM staff WHERE id=$1 AND role='TECHNICIAN' AND (is_field_technician OR EXISTS (SELECT 1 FROM cash_collections WHERE technician_id=staff.id))", [technicianId]);
  if (!staff.rowCount) throw notFound('Техник не найден');
  const previous = await client.query<Saved>('SELECT * FROM cash_collections WHERE technician_id=$1 ORDER BY period_to', [technicianId]);
  const last = previous.rows.at(-1);
  const from = last ? new Date(Date.parse(last.period_to) + 86400000).toISOString().slice(0, 10) : CASH_START;
  if (to < from) throw conflict('PERIOD_CLOSED', 'Эта дата уже закрыта инкассацией. Выберите более позднюю дату');
  const services = (await client.query<Item>(
    `SELECT id, service_date AS date, cash_amount AS amount, machine_number AS label, 'CASH' AS category
     FROM services WHERE technician_id=$1 AND service_date BETWEEN $2::date AND $3::date ORDER BY service_date,id`,
    [technicianId, CASH_START, to],
  )).rows;
  const expenses = (await client.query<Item>(
    `SELECT id, expense_date AS date, amount, comment AS label, category FROM business_expenses
     WHERE staff_id=$1 AND source='TECHNICIAN' AND expense_date BETWEEN $2::date AND $3::date ORDER BY expense_date,id`,
    [technicianId, CASH_START, to],
  )).rows;
  const currentServices = services.filter(item => item.date >= from);
  const currentExpenses = expenses.filter(item => item.date >= from);
  const oldNet = net(services.filter(item => item.date < from), expenses.filter(item => item.date < from));
  // Subtract expected handovers, never actual: a discrepancy is not silently converted to a debt.
  const adjustment = oldNet - previous.rows.reduce((sum, row) => sum + cents(row.expected), 0n);
  const category = (name: string) => money(total(currentExpenses.filter(item => item.category === name)));
  const corrections = previous.rows.flatMap(row => {
    const inPeriod = (item: Item) => item.date >= row.period_from && item.date <= row.period_to;
    const delta = net(services.filter(inPeriod), expenses.filter(inPeriod)) - net(row.snapshot.services, row.snapshot.expenses);
    return delta ? [{ collectionId: row.id, from: row.period_from, to: row.period_to, delta: money(delta) }] : [];
  });
  const snapshot: Snapshot = {
    from, to, cash: money(total(currentServices)), salary: category('SALARY'), fuel: category('FUEL'),
    other: category('OTHER'), transferred: category('CARD'), adjustment: money(adjustment),
    expected: money(net(currentServices, currentExpenses) + adjustment),
    services: currentServices, expenses: currentExpenses, corrections,
  };
  // Includes every historical source row: late edits invalidate an open preview too.
  const token = createHash('sha256').update(JSON.stringify({ technicianId, snapshot, services, expenses, previous: previous.rows.map(row => row.id) })).digest('hex');
  return { ...snapshot, token };
}

export async function previewCollection(client: Client, actor: Actor, technicianId: number, to: string) {
  assertAdmin(actor);
  // Multiple reads form one coherent snapshot, also in READ COMMITTED transactions.
  await client.query('LOCK TABLE services, business_expenses, cash_collections IN SHARE MODE');
  return calculate(client, technicianId, to);
}

export async function createCollection(client: Client, actor: Actor, input: {
  technicianId: number; to: string; receivedOn: string; token: string; actual?: string; comment?: string;
}) {
  assertAdmin(actor);
  date(input.receivedOn);
  if (input.receivedOn < input.to) throw badRequest('INVALID_RECEIVED_DATE', 'Дата получения не может быть раньше конца периода');
  if (input.actual !== undefined) validateCount(input.actual, input.comment ?? '');
  else if (input.comment) throw badRequest('INVALID_COMMENT', 'Комментарий к пересчёту требует фактическую сумму');
  // Serialise creation across admins before taking source-table locks (no lock upgrade).
  await client.query('SELECT pg_advisory_xact_lock(25025)');
  await client.query('LOCK TABLE services, business_expenses IN SHARE MODE');
  const { token, ...snapshot } = await calculate(client, input.technicianId, input.to);
  if (input.token !== token) throw conflict('PREVIEW_CHANGED', 'Данные изменились. Обновите расчёт и проверьте сумму перед фиксацией');
  if (cents(snapshot.expected) < 0n) throw badRequest('NEGATIVE_BAG', 'Расходы превышают наличные. Проверьте записи перед инкассацией');
  const row = (await client.query(
    `INSERT INTO cash_collections (technician_id,period_from,period_to,received_on,expected,snapshot,created_by,actual,comment,counted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,CASE WHEN $8::numeric IS NULL THEN NULL ELSE now() END) RETURNING *`,
    [input.technicianId, snapshot.from, snapshot.to, input.receivedOn, snapshot.expected, JSON.stringify(snapshot), actor.id,
      input.actual ?? null, input.comment ?? ''],
  )).rows[0];
  await auditInsert(client, actor, 'cash_collection', row.id, row);
  return row;
}

function validateCount(actual: string, comment: string) {
  if (typeof actual !== 'string' || !/^\d{1,12}(\.\d{1,2})?$/.test(actual)) throw badRequest('INVALID_AMOUNT', 'Введите неотрицательную сумму, не более двух знаков после запятой');
  if (typeof comment !== 'string' || comment.length > 2000) throw badRequest('INVALID_COMMENT', 'Комментарий — до 2000 символов');
}

export async function countCollection(client: Client, actor: Actor, id: number, input: { actual: string; comment: string }) {
  assertAdmin(actor);
  validateCount(input.actual, input.comment);
  const before = (await client.query('SELECT * FROM cash_collections WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!before) throw notFound('Инкассация не найдена');
  if (before.actual !== null) throw conflict('ALREADY_COUNTED', 'Результат пересчёта уже сохранён');
  const row = (await client.query('UPDATE cash_collections SET actual=$2,comment=$3,counted_at=now() WHERE id=$1 RETURNING *', [id, input.actual, input.comment])).rows[0];
  await auditUpdate(client, actor, 'cash_collection', id, before, row);
  return row;
}

export async function collectionOverview(client: Client, actor: Actor) {
  assertAdmin(actor);
  const technicians = (await client.query(
    `SELECT st.id,st.full_name,st.is_active,MAX(c.period_to) AS last_to FROM staff st
     LEFT JOIN cash_collections c ON c.technician_id=st.id
     WHERE (st.role='TECHNICIAN' AND st.is_field_technician) OR c.id IS NOT NULL GROUP BY st.id ORDER BY st.full_name`,
  )).rows;
  const totals = await Promise.all(technicians.map(async (technician: { id: number; last_to: string | null }) => {
    const from = technician.last_to ? new Date(Date.parse(technician.last_to) + 86400000).toISOString().slice(0, 10) : CASH_START;
    const current = from > today() ? { from, cash: '0.00', salary: '0.00', fuel: '0.00', other: '0.00',
      transferred: '0.00', adjustment: '0.00', expected: '0.00' } : await calculate(client, technician.id, today());
    return { id: technician.id, from: current.from, cash: current.cash,
      expenses: money(cents(current.salary) + cents(current.fuel) + cents(current.other) + cents(current.transferred)),
      adjustment: current.adjustment, expected: current.expected };
  }));
  const live = new Map(totals.map(row => [row.id, row]));
  const history = (await client.query(
    `SELECT c.*,st.full_name,(c.actual-c.expected)::numeric(14,2) AS difference,
       ((SELECT COALESCE(SUM(s.cash_amount),0) FROM services s WHERE s.technician_id=c.technician_id AND s.service_date BETWEEN c.period_from AND c.period_to)
       - (SELECT COALESCE(SUM(e.amount),0) FROM business_expenses e WHERE e.staff_id=c.technician_id AND e.source='TECHNICIAN' AND e.expense_date BETWEEN c.period_from AND c.period_to)
       - ((c.snapshot->>'cash')::numeric - (c.snapshot->>'salary')::numeric - (c.snapshot->>'fuel')::numeric - (c.snapshot->>'other')::numeric - (c.snapshot->>'transferred')::numeric))::numeric(14,2) AS source_delta
     FROM cash_collections c JOIN staff st ON st.id=c.technician_id ORDER BY c.created_at DESC,c.id DESC`,
  )).rows;
  return { start: CASH_START, technicians: technicians.map(row => ({ ...row, current: live.get(row.id) })), history };
}
