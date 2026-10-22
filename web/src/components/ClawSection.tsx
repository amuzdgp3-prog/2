import { useState } from 'react';
import {
  adviceText,
  adviseClaw,
  formatVolts,
  roundClaw,
  type ClawAdvice,
  type ClawState,
  type ClawValues,
  type PeriodTotals,
} from '../clawAdvice';

/**
 * Блок «Клешня» в форме обслуживания (DECISION-090). Свёрнут по умолчанию: в одной строке видно
 * текущий Weak и короткий совет, нажатие разворачивает. Поле Weak заранее заполнено тем, что стоит
 * на аппарате; пока значение не совпадает с советом, оно красное, совпало — зелёное. Сохраняется
 * всё одной кнопкой формы, отдельных кнопок здесь нет.
 */

/** Итоги текущего обслуживания, которые добавляются к итогам с сервера. null — счётчик не введён. */
export type ClawAddedTotals = PeriodTotals | null;

/** Скачок Weak, о котором предупреждаем: обычно меняют на один шаг. */
const BIG_JUMP_VOLTS = 1;

export function clawAdvice(state: ClawState, added: ClawAddedTotals): ClawAdvice | { kind: 'need-counter' } {
  if (state.current.weak === null) return { kind: 'no-settings' };
  if (!added) return { kind: 'need-counter' };
  return adviseClaw({
    current: state.current,
    limits: state.limits,
    band: state.band,
    totals: {
      games: state.since.games + added.games,
      revenue: state.since.revenue + added.revenue,
      toyCost: state.since.toyCost + added.toyCost,
    },
  }).advice;
}

/** Weak за границами типа — такое значение форма не сохраняет. */
export function weakOutOfBounds(state: ClawState, weak: number | null): boolean {
  if (weak === null) return false;
  const { weakMin, weakMax } = state.limits;
  return (weakMin !== null && weak < weakMin - 1e-9) || (weakMax !== null && weak > weakMax + 1e-9);
}

const percent = (value: number) => `${Math.round(value * 10) / 10} %`.replace('.', ',');

function levelOf(advice: ReturnType<typeof clawAdvice>): 'low' | 'ok' | 'high' | 'none' {
  if (advice.kind === 'ok') return 'ok';
  if (advice.kind === 'change' || advice.kind === 'limit') return advice.direction === 'raise' ? 'low' : 'high';
  return 'none';
}

function summary(advice: ReturnType<typeof clawAdvice>): string {
  switch (advice.kind) {
    case 'need-counter':
      return 'Совет появится после счётчика';
    case 'no-settings':
      return 'Значение ещё не вносилось — нажмите, чтобы ввести';
    case 'early':
      return `Рано судить · ${Math.round(advice.games)} из ${advice.minGames} игр`;
    case 'no-data':
      return 'Рано судить · с изменения ещё не было игр';
    case 'ok':
      return `Норма ${percent(advice.payoutPercent)} · не менять`;
    case 'change':
      return `${advice.direction === 'raise' ? 'Отдаёт мало' : 'Отдаёт много'} ${percent(advice.payoutPercent)} · совет: ${adviceText(advice)}`;
    case 'limit':
      return 'Weak и Medium у границы';
  }
}

function AdviceBox({ advice, state }: { advice: ReturnType<typeof clawAdvice>; state: ClawState }) {
  const level = levelOf(advice);
  const band = state.band;
  const target = band.target === null ? `норма ${band.low}–${band.high} %` : `цель ${band.target} %`;
  const since = state.changedAt
    ? `с ${new Date(state.changedAt).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}`
    : '';
  let head = '';
  let body = '';
  switch (advice.kind) {
    case 'need-counter':
      head = 'Совет появится после счётчика';
      body = 'Введите счётчик игр: без выручки за период отдачу не посчитать.';
      break;
    case 'no-settings':
      head = 'Значение ещё не вносилось';
      body = 'Посмотрите на аппарате: Crane Setting → Claw Set → 3 и введите, что там стоит.';
      break;
    case 'early':
      head = 'Рано судить · не менять';
      body = `После изменения ${since} сыграно ${Math.round(advice.games)} из ${advice.minGames} игр.`;
      break;
    case 'no-data':
      head = 'Рано судить · не менять';
      body = 'С изменения ещё не было игр.';
      break;
    case 'ok':
      head = 'Норма · не менять';
      body = `Затраты ${percent(advice.payoutPercent)}, ${target}. ${since ? `Сыграно ${since} ${Math.round(advice.games)} игр.` : ''}`;
      break;
    case 'change':
      head = `${advice.direction === 'raise' ? 'Отдаёт мало' : 'Отдаёт много'}: затраты ${percent(advice.payoutPercent)}, ${target}`;
      body = `Совет: ${adviceText(advice)}`;
      break;
    case 'limit':
      head = `Затраты ${percent(advice.payoutPercent)}, ${target}`;
      body = adviceText(advice);
      break;
  }
  return (
    <div className={`claw-advice tci-${level === 'none' ? 'none' : level}`}>
      <p className="claw-advice-head">{head}</p>
      <p>{body}</p>
    </div>
  );
}

function MiniStepper({
  label,
  hint,
  value,
  current,
  step,
  digits,
  highlight,
  onChange,
}: {
  label: string;
  hint: string;
  value: number | null;
  current: number | null;
  step: number;
  digits: number;
  highlight: 'need' | 'match' | null;
  onChange: (value: number | null) => void;
}) {
  const changed = value !== current;
  const show = (v: number | null) => (v === null ? '—' : digits === 0 ? String(v) : formatVolts(v));
  return (
    <div className={`claw-mini ${changed ? 'changed' : ''} ${highlight ?? ''}`}>
      <div className="claw-mini-name">
        {label}
        {changed && <span className="claw-chg">{show(current)} → {show(value)}</span>}
        <small>{hint}</small>
      </div>
      <div className="claw-mini-ctl">
        <button type="button" aria-label={`${label} меньше`} onClick={() => onChange(roundClaw((value ?? 0) - step))}>−</button>
        <input
          inputMode="decimal"
          aria-label={label}
          value={value === null ? '' : digits === 0 ? String(value) : String(value).replace('.', ',')}
          onChange={(event) => {
            const parsed = Number(event.target.value.replace(',', '.'));
            onChange(event.target.value.trim() === '' || !Number.isFinite(parsed) ? null : parsed);
          }}
        />
        <button type="button" aria-label={`${label} больше`} onClick={() => onChange(roundClaw((value ?? 0) + step))}>+</button>
      </div>
    </div>
  );
}

export function ClawSection({
  state,
  values,
  added,
  onChange,
}: {
  state: ClawState;
  values: ClawValues;
  added: ClawAddedTotals;
  onChange: (next: ClawValues) => void;
}) {
  const [open, setOpen] = useState(false);
  const [othersOpen, setOthersOpen] = useState(false);
  const [weakText, setWeakText] = useState<string | null>(null);

  const advice = clawAdvice(state, added);
  const level = levelOf(advice);
  const current = state.current;
  const weakChanged = values.weak !== current.weak;
  const othersChanged = values.strong !== current.strong || values.medium !== current.medium || values.prizeSet !== current.prizeSet;
  const weakAdvice = advice.kind === 'change' && advice.param === 'weak' ? advice : null;
  const mediumAdvice = advice.kind === 'change' && advice.param === 'medium' ? advice : null;
  const weakColor = weakAdvice ? (values.weak === weakAdvice.to ? 'match' : 'need') : weakChanged ? 'changed' : '';
  const outOfBounds = weakOutOfBounds(state, values.weak);
  const bigJump = current.weak !== null && values.weak !== null && Math.abs(values.weak - current.weak) > BIG_JUMP_VOLTS + 1e-9;
  const { weakMin, weakMax, weakStep } = state.limits;

  const setWeak = (weak: number | null) => {
    setWeakText(null);
    onChange({ ...values, weak });
  };

  const weakTitle = weakChanged && current.weak !== null
    ? `Weak ${formatVolts(current.weak)} → ${formatVolts(values.weak)} В`
    : `Weak ${formatVolts(values.weak)} В`;

  return (
    <div className="claw">
      <button type="button" className="claw-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="claw-toggle-main">
          <span className={`claw-dot tci-${level}`} />
          <span>
            <b className="mono">{weakTitle}</b>
            <small>{summary(advice)}</small>
          </span>
        </span>
        <span className="claw-toggle-side">
          {(weakChanged || othersChanged) && <span className="claw-chg">изменено</span>}
          <span className="claw-arrow">{open ? '▴' : '▾'}</span>
        </span>
      </button>

      {open && (
        <div className="claw-open">
          <AdviceBox advice={advice} state={state} />
          <div className="claw-body">
            {weakChanged && current.weak !== null && (
              <div className="claw-was">было <b className="mono">{formatVolts(current.weak)}</b> → стало <b className="mono">{formatVolts(values.weak)}</b></div>
            )}
            <div className={`claw-stepper ${weakColor}`}>
              <button type="button" aria-label="Уменьшить Weak" onClick={() => setWeak(roundClaw((values.weak ?? current.weak ?? weakMin ?? 0) - weakStep))}>
                −{formatVolts(weakStep)}
              </button>
              <input
                inputMode="decimal"
                aria-label="Weak, вольты"
                placeholder="—"
                value={weakText ?? (values.weak === null ? '' : formatVolts(values.weak))}
                onChange={(event) => {
                  setWeakText(event.target.value);
                  const parsed = Number(event.target.value.replace(',', '.'));
                  onChange({ ...values, weak: event.target.value.trim() === '' || !Number.isFinite(parsed) ? null : roundClaw(parsed) });
                }}
                onBlur={() => setWeakText(null)}
              />
              <button type="button" aria-label="Увеличить Weak" onClick={() => setWeak(roundClaw((values.weak ?? current.weak ?? weakMin ?? 0) + weakStep))}>
                +{formatVolts(weakStep)}
              </button>
            </div>
            <div className="claw-unit">
              вольт · шаг {formatVolts(weakStep)}
              {(weakMin !== null || weakMax !== null) && ` · границы ${formatVolts(weakMin)}–${formatVolts(weakMax)}`}
            </div>
            {outOfBounds && (
              <div className="alert error" style={{ margin: 0 }}>
                Weak должен быть от {formatVolts(weakMin)} до {formatVolts(weakMax)} В. Так сохранить нельзя.
              </div>
            )}
            {!outOfBounds && bigJump && (
              <div className="alert warn" style={{ margin: 0 }}>
                Изменение на {formatVolts(Math.abs((values.weak ?? 0) - (current.weak ?? 0)))} В — проверьте, что ввели верно.
              </div>
            )}
            {weakChanged && current.weak !== null && (
              <button type="button" className="btn btn-ghost claw-revert" onClick={() => setWeak(current.weak)}>
                Вернуть {formatVolts(current.weak)}
              </button>
            )}
          </div>

          <button type="button" className="claw-others-toggle" aria-expanded={othersOpen} onClick={() => setOthersOpen(!othersOpen)}>
            <span>Другие настройки{othersChanged && <span className="claw-chg">изменено</span>}</span>
            <span className="mono">
              Strong {formatVolts(values.strong)} · Medium {formatVolts(values.medium)} · Prize {values.prizeSet ?? '—'} {othersOpen ? '▴' : '▾'}
            </span>
          </button>
          {othersOpen && (
            <div className="claw-others">
              <MiniStepper
                label="Strong · п.1"
                hint={`шаг ${formatVolts(state.limits.strongStep)} · ${state.limits.strongMin}–${state.limits.strongMax} В`}
                value={values.strong}
                current={current.strong}
                step={state.limits.strongStep}
                digits={1}
                highlight={null}
                onChange={(strong) => onChange({ ...values, strong })}
              />
              <MiniStepper
                label="Medium · п.2"
                hint={`шаг ${formatVolts(state.limits.mediumStep)} · ${state.limits.mediumMin}–${state.limits.mediumMax} В`}
                value={values.medium}
                current={current.medium}
                step={state.limits.mediumStep}
                digits={1}
                highlight={mediumAdvice ? (values.medium === mediumAdvice.to ? 'match' : 'need') : null}
                onChange={(medium) => onChange({ ...values, medium })}
              />
              <MiniStepper
                label="Prize Set"
                hint="игр на приз · для справки"
                value={values.prizeSet}
                current={current.prizeSet}
                step={1}
                digits={0}
                highlight={null}
                onChange={(prizeSet) => onChange({ ...values, prizeSet: prizeSet === null ? null : Math.round(prizeSet) })}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Только изменённые поля — их форма кладёт в черновик. undefined — ничего не меняли. */
export function changedClaw(state: ClawState, values: ClawValues) {
  const diff: Partial<ClawValues> = {};
  for (const key of ['strong', 'medium', 'weak', 'prizeSet'] as const) {
    if (values[key] !== state.current[key]) diff[key] = values[key];
  }
  return Object.keys(diff).length ? diff : undefined;
}

