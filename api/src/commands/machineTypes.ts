import type { Client } from '../db/pool.js';
import { auditDelete, auditInsert, auditUpdate, type Actor } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { assertAdmin } from '../lib/scope.js';

/**
 * Справочник типов аппаратов (015_machine_types.sql). Ключ справочника — само название типа, а не
 * суррогатный id: machines.machine_type остаётся текстовым, поэтому все существующие фильтры по
 * типу продолжают работать без единой правки, а переименование разъезжается по аппаратам внешним
 * ключом ON UPDATE CASCADE.
 *
 * Отсюда следует разделение «отключить» и «удалить». Удалить можно только тип, которым не помечен
 * ни один аппарат, включая списанные, — иначе пришлось бы переписывать историю. Тип, который уже
 * использовался, отключается: он остаётся на своих аппаратах и в отчётах, но больше не предлагается
 * при установке новых.
 */
export interface MachineTypeRow {
  name: string;
  is_active: boolean;
  created_at: Date;
  machines_count: number;
}

const NAME_MAX = 60;

function normalizeName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!name) throw badRequest('EMPTY_TYPE_NAME', 'название типа не может быть пустым');
  if (name.length > NAME_MAX) {
    throw badRequest('TYPE_NAME_TOO_LONG', `название типа длиннее ${NAME_MAX} символов`);
  }
  return name;
}

/** Список типов со счётчиком аппаратов — админке он нужен, чтобы объяснить, почему тип не удаляется. */
export async function listMachineTypes(client: Client, actor: Actor): Promise<MachineTypeRow[]> {
  // Руководителю список нужен только для чтения — фильтр «Тип аппарата» в журнале.
  if (actor.role !== 'BOSS') assertAdmin(actor);
  const result = await client.query<MachineTypeRow>(
    `SELECT t.name, t.is_active, t.created_at,
            (SELECT count(*)::int FROM machines m WHERE m.machine_type = t.name) AS machines_count
     FROM machine_types t
     ORDER BY t.is_active DESC, t.name`,
  );
  return result.rows;
}

export async function createMachineType(
  client: Client,
  actor: Actor,
  input: { name: string },
): Promise<MachineTypeRow> {
  assertAdmin(actor);
  const name = normalizeName(input.name);

  const existing = await client.query('SELECT name FROM machine_types WHERE name = $1', [name]);
  if (existing.rowCount) throw conflict('TYPE_EXISTS', 'такой тип аппарата уже есть');

  const inserted = await client.query(
    'INSERT INTO machine_types (name) VALUES ($1) RETURNING *',
    [name],
  );
  await auditInsert(client, actor, 'machine_type', name, inserted.rows[0]);
  return { ...inserted.rows[0], machines_count: 0 };
}

/**
 * Переименование. Внешний ключ ON UPDATE CASCADE сам переносит новое имя на все аппараты, включая
 * списанные, поэтому отдельного UPDATE по machines здесь нет и быть не должно.
 */
export async function renameMachineType(
  client: Client,
  actor: Actor,
  currentName: string,
  input: { name: string },
): Promise<MachineTypeRow> {
  assertAdmin(actor);
  const name = normalizeName(input.name);

  const before = await client.query('SELECT * FROM machine_types WHERE name = $1', [currentName]);
  if (before.rowCount === 0) throw notFound('тип аппарата не существует');
  if (name === currentName) return (await listMachineTypes(client, actor)).find((row) => row.name === name)!;

  const clash = await client.query('SELECT name FROM machine_types WHERE name = $1', [name]);
  if (clash.rowCount) throw conflict('TYPE_EXISTS', 'такой тип аппарата уже есть');

  const after = await client.query(
    'UPDATE machine_types SET name = $2 WHERE name = $1 RETURNING *',
    [currentName, name],
  );
  await auditUpdate(client, actor, 'machine_type', currentName, before.rows[0], after.rows[0], {
    reason: 'renamed',
    renamedTo: name,
  });
  const counted = await client.query<{ machines_count: number }>(
    'SELECT count(*)::int AS machines_count FROM machines WHERE machine_type = $1',
    [name],
  );
  return { ...after.rows[0], machines_count: counted.rows[0].machines_count };
}

/** Отключённый тип остаётся на своих аппаратах и в отчётах, но не предлагается при установке. */
export async function setMachineTypeActive(
  client: Client,
  actor: Actor,
  name: string,
  isActive: boolean,
): Promise<MachineTypeRow> {
  assertAdmin(actor);
  const before = await client.query('SELECT * FROM machine_types WHERE name = $1', [name]);
  if (before.rowCount === 0) throw notFound('тип аппарата не существует');

  const after = await client.query(
    'UPDATE machine_types SET is_active = $2 WHERE name = $1 RETURNING *',
    [name, isActive],
  );
  await auditUpdate(client, actor, 'machine_type', name, before.rows[0], after.rows[0]);
  const counted = await client.query<{ machines_count: number }>(
    'SELECT count(*)::int AS machines_count FROM machines WHERE machine_type = $1',
    [name],
  );
  return { ...after.rows[0], machines_count: counted.rows[0].machines_count };
}

/**
 * Удаление разрешено только для типа, которым не помечен ни один аппарат. Внешний ключ и так не дал
 * бы удалить используемый тип, но сообщение Postgres техник не поймёт, поэтому случай проверяется
 * заранее и объясняется словами, со счётчиком.
 */
export async function deleteMachineType(client: Client, actor: Actor, name: string): Promise<void> {
  assertAdmin(actor);
  const before = await client.query('SELECT * FROM machine_types WHERE name = $1', [name]);
  if (before.rowCount === 0) throw notFound('тип аппарата не существует');

  const used = await client.query<{ machines_count: number }>(
    'SELECT count(*)::int AS machines_count FROM machines WHERE machine_type = $1',
    [name],
  );
  if (used.rows[0].machines_count > 0) {
    throw badRequest(
      'TYPE_IN_USE',
      `тип используется в ${used.rows[0].machines_count} аппаратах — его можно отключить, но не удалить`,
    );
  }

  await client.query('DELETE FROM machine_types WHERE name = $1', [name]);
  await auditDelete(client, actor, 'machine_type', name, before.rows[0]);
}
