import type { Client } from '../db/pool.js';
import { auditInsert, auditUpdate, type Actor } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { assertAdmin } from '../lib/scope.js';
import { validTarget, type ClawInput } from './clawSettings.js';

/**
 * Настройки клешни на уровне типа аппарата (DECISION-090): есть ли меню Claw Set, цель отдачи,
 * шаги платы и границы значений, а также массовые действия по всем аппаратам типа.
 */
export interface TypeClawConfigInput {
  hasClawSettings?: boolean;
  targetPayoutPercent?: number | null;
  weakStep?: number;
  strongStep?: number;
  mediumStep?: number;
  weakMin?: number | null;
  weakMax?: number | null;
  strongMin?: number;
  strongMax?: number;
  mediumMin?: number;
  mediumMax?: number;
}

const COLUMNS: Record<keyof TypeClawConfigInput, string> = {
  hasClawSettings: 'has_claw_settings',
  targetPayoutPercent: 'target_payout_percent',
  weakStep: 'claw_weak_step',
  strongStep: 'claw_strong_step',
  mediumStep: 'claw_medium_step',
  weakMin: 'claw_weak_min',
  weakMax: 'claw_weak_max',
  strongMin: 'claw_strong_min',
  strongMax: 'claw_strong_max',
  mediumMin: 'claw_medium_min',
  mediumMax: 'claw_medium_max',
};

async function loadType(client: Client, name: string): Promise<Record<string, unknown>> {
  const result = await client.query('SELECT * FROM machine_types WHERE name = $1', [name]);
  if (result.rowCount === 0) throw notFound('тип аппарата не существует');
  return result.rows[0];
}

export async function updateTypeClawConfig(
  client: Client,
  actor: Actor,
  name: string,
  input: TypeClawConfigInput,
): Promise<Record<string, unknown>> {
  assertAdmin(actor);
  const before = await loadType(client, name);

  const sets: string[] = [];
  const params: unknown[] = [name];
  for (const [key, column] of Object.entries(COLUMNS) as Array<[keyof TypeClawConfigInput, string]>) {
    const value = input[key];
    if (value === undefined) continue;
    if (key === 'targetPayoutPercent') {
      params.push(validTarget(value as number | null));
    } else if (key.endsWith('Step')) {
      if (typeof value !== 'number' || !(value > 0)) throw badRequest('CLAW_STEP_INVALID', 'шаг должен быть больше нуля');
      params.push(value);
    } else {
      params.push(value);
    }
    sets.push(`${column} = $${params.length}`);
  }
  if (sets.length === 0) throw badRequest('NOTHING_TO_UPDATE', 'не передано ни одного изменяемого поля');

  // Границы проверяем понятными словами до того, как их отвергнет CHECK в базе.
  const merged = { ...before } as Record<string, unknown>;
  for (const [key, column] of Object.entries(COLUMNS) as Array<[keyof TypeClawConfigInput, string]>) {
    if (input[key] !== undefined) merged[column] = input[key];
  }
  const pairs: Array<[string, string, string]> = [
    ['Weak', 'claw_weak_min', 'claw_weak_max'],
    ['Strong', 'claw_strong_min', 'claw_strong_max'],
    ['Medium', 'claw_medium_min', 'claw_medium_max'],
  ];
  for (const [label, min, max] of pairs) {
    if (merged[min] !== null && merged[max] !== null && Number(merged[min]) >= Number(merged[max])) {
      throw badRequest('CLAW_RANGE_INVALID', `${label}: нижняя граница должна быть меньше верхней`);
    }
  }

  const after = await client.query(
    `UPDATE machine_types SET ${sets.join(', ')} WHERE name = $1 RETURNING *`,
    params,
  );
  await auditUpdate(client, actor, 'machine_type', name, before, after.rows[0], { reason: 'claw_config' });
  return after.rows[0];
}

/**
 * Цель отдачи всем аппаратам типа. Своя цель аппарата перезаписывается — так решил владелец:
 * она сбрасывается, и аппарат снова берёт цель типа.
 */
export async function applyTypeTarget(
  client: Client,
  actor: Actor,
  name: string,
  percent: number | null,
): Promise<{ targetPayoutPercent: number | null; machines: number; overwritten: number }> {
  assertAdmin(actor);
  await updateTypeClawConfig(client, actor, name, { targetPayoutPercent: percent });
  const overwritten = await client.query(
    `UPDATE machines SET target_payout_percent = NULL
     WHERE machine_type = $1 AND target_payout_percent IS NOT NULL
     RETURNING machine_number`,
    [name],
  );
  for (const row of overwritten.rows) {
    await auditUpdate(client, actor, 'machine', row.machine_number, {}, { target_payout_percent: null }, {
      reason: 'type_target_applied',
    });
  }
  const count = await client.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM machines WHERE machine_type = $1',
    [name],
  );
  return {
    targetPayoutPercent: validTarget(percent),
    machines: count.rows[0].count,
    overwritten: overwritten.rowCount ?? 0,
  };
}

const fmt = (value: number) => String(value).replace('.', ',');

/** Как задача называет значения: «Strong 40, Weak 12,4 В, Prize Set 10». */
export function describeClawPlan(plan: ClawInput): string {
  const parts: string[] = [];
  if (plan.strong != null) parts.push(`Strong ${fmt(plan.strong)} В`);
  if (plan.medium != null) parts.push(`Medium ${fmt(plan.medium)} В`);
  if (plan.weak != null) parts.push(`Weak ${fmt(plan.weak)} В`);
  if (plan.prizeSet != null) parts.push(`Prize Set ${plan.prizeSet}`);
  return parts.join(', ');
}

/**
 * «Выставить настройки клешни всем»: система не может поменять плату сама, поэтому создаёт задачу
 * на каждый установленный аппарат типа. Значение станет действующим, когда техник подтвердит его
 * при закрытии задачи.
 */
export async function createClawPlanTasks(
  client: Client,
  actor: Actor,
  name: string,
  input: ClawInput & { dueDate?: string | null },
): Promise<{ created: number }> {
  assertAdmin(actor);
  const type = await loadType(client, name);
  if (!type.has_claw_settings) {
    throw badRequest('CLAW_SETTINGS_DISABLED', `у типа ${name} нет меню Claw Set`);
  }
  const plan: ClawInput = {};
  for (const key of ['strong', 'medium', 'weak', 'prizeSet'] as const) {
    if (input[key] !== undefined && input[key] !== null) plan[key] = input[key];
  }
  const described = describeClawPlan(plan);
  if (!described) throw badRequest('CLAW_PLAN_EMPTY', 'укажите хотя бы одно значение');

  const machines = await client.query<{ machine_number: string; location_id: number }>(
    `SELECT m.machine_number, p.location_id
     FROM machines m JOIN machine_placements p ON p.machine_number = m.machine_number AND p.ended_at IS NULL
     WHERE m.machine_type = $1 AND m.status = 'ACTIVE'
     ORDER BY m.machine_number`,
    [name],
  );
  for (const machine of machines.rows) {
    const inserted = await client.query(
      `INSERT INTO technician_tasks (machine_number, location_id, title, details, due_date, created_by, claw_plan)
       VALUES ($1, $2, 'Выставить настройки клешни', $3, $4::date, $5, $6)
       RETURNING *`,
      [
        machine.machine_number,
        machine.location_id,
        `Crane Setting → Claw Set: ${described}`,
        input.dueDate ?? null,
        actor.id,
        JSON.stringify(plan),
      ],
    );
    await auditInsert(client, actor, 'technician_task', inserted.rows[0].id, inserted.rows[0]);
  }
  return { created: machines.rowCount ?? 0 };
}
