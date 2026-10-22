import type { Client } from '../db/pool.js';
import {
  adviceAt,
  loadCurrentClaw,
  loadMachineClawConfig,
  type ClawSettingRow,
  type MachineClawConfig,
} from '../domain/clawStats.js';
import { auditInsert, auditUpdate, type Actor } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { lockMachines } from '../lib/locks.js';
import { assertAdmin, assertCanMutate, assertMachineInScope } from '../lib/scope.js';

/**
 * Запись настроек клешни (DECISION-090). Новая строка истории появляется только при изменении:
 * если прислали те же значения, что уже действуют, ничего не пишется — журнал и карточка
 * показывают изменение, а не каждое обслуживание.
 *
 * Поле, которое не прислали, остаётся прежним: строка истории — снимок всех значений, поэтому
 * недостающее берётся из действующей настройки.
 */
export interface ClawInput {
  strong?: number | null;
  medium?: number | null;
  weak?: number | null;
  prizeSet?: number | null;
}

const FIELDS = ['strong', 'medium', 'weak', 'prizeSet'] as const;

function validate(config: MachineClawConfig, values: Required<ClawInput>): void {
  const { limits } = config;
  const check = (name: string, value: number | null, min: number | null, max: number | null) => {
    if (value === null) return;
    if (!Number.isFinite(value) || value < 0) throw badRequest('CLAW_VALUE_INVALID', `${name}: неверное значение`);
    if ((min !== null && value < min) || (max !== null && value > max)) {
      const range = [min !== null ? `от ${min}` : null, max !== null ? `до ${max}` : null].filter(Boolean).join(' ');
      throw badRequest('CLAW_VALUE_OUT_OF_RANGE', `${name} должен быть ${range} В (границы типа ${config.machineType})`);
    }
  };
  check('Strong', values.strong, limits.strongMin, limits.strongMax);
  check('Medium', values.medium, limits.mediumMin, limits.mediumMax);
  check('Weak', values.weak, limits.weakMin, limits.weakMax);
  if (values.prizeSet !== null && (!Number.isInteger(values.prizeSet) || values.prizeSet < 0 || values.prizeSet > 499)) {
    throw badRequest('CLAW_VALUE_OUT_OF_RANGE', 'Prize Set должен быть целым от 0 до 499');
  }
}

/** Значения с точностью платы — десятые вольта; на вход может прийти 12.600000000000001. */
const tenth = (value: number | null) => (value === null ? null : Math.round(value * 10) / 10);

export async function recordClawSettings(
  client: Client,
  actor: Actor,
  input: {
    machineNumber: string;
    values: ClawInput;
    source: 'SERVICE' | 'CARD' | 'TASK';
    effectiveAt: Date | string;
    serviceId?: number | null;
    taskId?: number | null;
    localId?: string | null;
    enteredBy?: number | null;
    note?: string;
  },
): Promise<ClawSettingRow | null> {
  if (input.localId) {
    const replay = await client.query('SELECT id FROM claw_settings WHERE local_id = $1', [input.localId]);
    if (replay.rowCount) return loadCurrentClaw(client, input.machineNumber);
  }

  const config = await loadMachineClawConfig(client, input.machineNumber);
  if (!config) throw notFound('аппарат не существует');
  if (!config.enabled) {
    throw badRequest('CLAW_SETTINGS_DISABLED', `у типа ${config.machineType} нет меню Claw Set`);
  }

  // Сравниваем с тем, что действовало на момент изменения, а не с последней строкой: обслуживание,
  // внесённое задним числом, не должно сравниваться с более поздней настройкой.
  const current = await loadCurrentClaw(client, input.machineNumber, input.effectiveAt);
  const next = {
    strong: input.values.strong !== undefined ? tenth(input.values.strong) : current?.strong ?? null,
    medium: input.values.medium !== undefined ? tenth(input.values.medium) : current?.medium ?? null,
    weak: input.values.weak !== undefined ? tenth(input.values.weak) : current?.weak ?? null,
    prizeSet: input.values.prizeSet !== undefined ? input.values.prizeSet : current?.prizeSet ?? null,
  };
  const changed = FIELDS.some((field) => (current?.[field] ?? null) !== next[field]);
  if (!changed) return null;
  validate(config, next);

  // Совет, который система давала в момент изменения, — по нему журнал отличает «по совету» от
  // «против совета». Для записи из обслуживания сюда входит и само это обслуживание.
  const advice = await adviceAt(client, config, current, input.effectiveAt);

  const inserted = await client.query(
    `INSERT INTO claw_settings
       (local_id, machine_number, effective_at, strong, medium, weak, prize_set, source,
        service_id, task_id, advice, entered_by, note)
     VALUES ($1, $2, $3::timestamptz, $4, $5, $6, $7, $8::claw_setting_source, $9, $10, $11, $12, $13)
     RETURNING *`,
    [
      input.localId ?? null,
      input.machineNumber,
      input.effectiveAt,
      next.strong,
      next.medium,
      next.weak,
      next.prizeSet,
      input.source,
      input.serviceId ?? null,
      input.taskId ?? null,
      JSON.stringify(advice),
      input.enteredBy ?? actor.id,
      (input.note ?? '').trim(),
    ],
  );
  await auditInsert(client, actor, 'claw_settings', inserted.rows[0].id, inserted.rows[0]);
  return loadCurrentClaw(client, input.machineNumber);
}

/** «Изменили на аппарате» с карточки: техник своего аппарата или администратор. */
export async function recordClawFromCard(
  client: Client,
  actor: Actor,
  machineNumber: string,
  input: ClawInput & { localId?: string; note?: string },
): Promise<ClawSettingRow | null> {
  assertCanMutate(actor);
  await assertMachineInScope(client, actor, machineNumber);
  await lockMachines(client, [machineNumber]);
  return recordClawSettings(client, actor, {
    machineNumber,
    values: { strong: input.strong, medium: input.medium, weak: input.weak, prizeSet: input.prizeSet },
    source: 'CARD',
    effectiveAt: new Date(),
    localId: input.localId ?? null,
    note: input.note,
  });
}

const validTarget = (value: number | null) => {
  if (value === null) return null;
  if (!Number.isFinite(value) || value <= 0 || value >= 100) {
    throw badRequest('TARGET_OUT_OF_RANGE', 'целевая отдача — процент больше 0 и меньше 100');
  }
  return Math.round(value * 100) / 100;
};

/** Своя цель аппарата; null — снова как у типа. */
export async function setMachineTarget(
  client: Client,
  actor: Actor,
  machineNumber: string,
  percent: number | null,
): Promise<{ machineNumber: string; targetPayoutPercent: number | null }> {
  assertAdmin(actor);
  const target = validTarget(percent);
  const before = await client.query('SELECT * FROM machines WHERE machine_number = $1', [machineNumber]);
  if (before.rowCount === 0) throw notFound('аппарат не существует');
  const after = await client.query(
    'UPDATE machines SET target_payout_percent = $2 WHERE machine_number = $1 RETURNING *',
    [machineNumber, target],
  );
  await auditUpdate(client, actor, 'machine', machineNumber, before.rows[0], after.rows[0], {
    reason: 'target_payout',
  });
  return { machineNumber, targetPayoutPercent: target };
}

export { validTarget };
