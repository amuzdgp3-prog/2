import { useEffect, useState } from 'react';
import { api } from '../../api';
import { formatVolts, payoutBand } from '../../clawAdvice';

/**
 * Клешня и отдача на карточке типа аппарата (DECISION-090): есть ли меню Claw Set, цель отдачи
 * с назначением всем аппаратам типа, шаги платы и границы, «выставить настройки всем» через задачи
 * техникам и аналитика «больше выигрывают — больше играют?».
 */
export interface MachineTypeClawRow {
  name: string;
  machines_count: number;
  has_claw_settings?: boolean;
  target_payout_percent?: string | null;
  claw_weak_step?: string;
  claw_strong_step?: string;
  claw_medium_step?: string;
  claw_weak_min?: string | null;
  claw_weak_max?: string | null;
  claw_strong_min?: string;
  claw_strong_max?: string;
  claw_medium_min?: string;
  claw_medium_max?: string;
}

interface Analytics {
  periods: number;
  firstServiceAt: string | null;
  bins: Array<{ label: string; periods: number; nextPacePercent: number | null; standardError: number | null; from: number; to: number | null }>;
  effects: Array<{ direction: 'raise' | 'lower'; count: number; complete: number; paceAdjustedPercent: number | null; netChangePercent: number | null }>;
}

const num = (text: string) => (text.trim() === '' ? null : Number(text.replace(',', '.')));
const show = (value: string | null | undefined) => (value === null || value === undefined ? '' : String(Number(value)).replace('.', ','));
const signed = (value: number | null) =>
  value === null ? '—' : `${value > 0 ? '+' : value < 0 ? '−' : '±'}${Math.abs(Math.round(value))} %`;

/** Точки «темп в следующем периоде» по корзинам отдачи, с полосой ±1 ошибки и коридором цели. */
function PaceChart({ analytics, target }: { analytics: Analytics; target: number | null }) {
  const bins = analytics.bins;
  const W = 560;
  const L = 46;
  const R = 12;
  const T = 16;
  const H = 170;
  const values = bins.flatMap((bin) =>
    bin.nextPacePercent === null ? [] : [bin.nextPacePercent - (bin.standardError ?? 0), bin.nextPacePercent + (bin.standardError ?? 0)],
  );
  const min = Math.min(90, Math.floor(Math.min(...values, 100) / 5) * 5);
  const max = Math.max(120, Math.ceil(Math.max(...values, 100) / 5) * 5);
  const cw = (W - L - R) / bins.length;
  const cx = (index: number) => L + cw * index + cw / 2;
  const Y = (value: number) => T + H - ((value - min) / (max - min)) * H;
  const ticks = [];
  for (let tick = min; tick <= max; tick += 10) ticks.push(tick);
  const band = target === null ? null : payoutBand(target);
  const bandIndex = band ? bins.findIndex((bin) => band.low < (bin.to ?? Infinity) && band.high > bin.from) : -1;
  const points = bins
    .map((bin, index) => (bin.nextPacePercent === null ? null : `${cx(index)},${Y(bin.nextPacePercent)}`))
    .filter(Boolean)
    .join(' ');
  return (
    <div className="scroll-x">
      <svg className="claw-chart type" viewBox={`0 0 ${W} ${T + H + 26}`} role="img" aria-label="Темп игр в следующем периоде в зависимости от отдачи">
        {bandIndex >= 0 && (
          <>
            <rect className="band" x={L + cw * bandIndex} y={T} width={cw} height={H} />
            <text className="band-label" x={cx(bandIndex)} y={T + 12} textAnchor="middle">цель</text>
          </>
        )}
        {ticks.map((tick) => (
          <g key={tick}>
            <line className="grid" x1={L} x2={W - R} y1={Y(tick)} y2={Y(tick)} style={tick === 100 ? { stroke: 'var(--ink-faint)' } : undefined} />
            <text x={L - 6} y={Y(tick) + 3.5} textAnchor="end">{tick}%</text>
          </g>
        ))}
        <text x={W - R} y={Y(100) - 5} textAnchor="end">обычный темп</text>
        <polyline className="line" style={{ stroke: 'var(--ink-faint)', strokeWidth: 1.5 }} points={points} />
        {bins.map((bin, index) =>
          bin.nextPacePercent === null ? null : (
            <g key={bin.label}>
              {bin.standardError !== null && (
                <line className="whisk" x1={cx(index)} x2={cx(index)} y1={Y(bin.nextPacePercent - bin.standardError)} y2={Y(bin.nextPacePercent + bin.standardError)} />
              )}
              <circle className="dot" cx={cx(index)} cy={Y(bin.nextPacePercent)} r={6}>
                <title>{`Отдача ${bin.label} %: в следующем периоде играли на ${Math.round(bin.nextPacePercent)} % от обычного (${bin.periods} периодов)`}</title>
              </circle>
              <text x={cx(index)} y={Y(bin.nextPacePercent) - 11} textAnchor="middle" style={{ fill: 'var(--ink)' }}>
                {Math.round(bin.nextPacePercent)}
              </text>
            </g>
          ),
        )}
        {bins.map((bin, index) => (
          <text key={`x-${bin.label}`} x={cx(index)} y={T + H + 16} textAnchor="middle">{bin.label} %</text>
        ))}
      </svg>
    </div>
  );
}

function verdictText(analytics: Analytics): string {
  const known = analytics.bins.filter((bin) => bin.nextPacePercent !== null && bin.periods >= 30);
  if (known.length < 3) return 'Данных пока мало для вывода.';
  const values = known.map((bin) => bin.nextPacePercent as number);
  const spread = Math.max(...values) - Math.min(...values);
  const best = known.reduce((top, bin) => ((bin.nextPacePercent ?? 0) > (top.nextPacePercent ?? 0) ? bin : top));
  return spread < 10
    ? `При любой отдаче в следующий период играют примерно одинаково: от ${Math.round(Math.min(...values))} до ${Math.round(Math.max(...values))} % обычного. Чуть лучше — при отдаче ${best.label} %, но разница в пределах случайности.`
    : `Заметная разница: при отдаче ${best.label} % в следующий период играют на ${Math.round(best.nextPacePercent ?? 0)} % от обычного.`;
}

export function TypeClawPanel({ row, onDone, onError }: {
  row: MachineTypeClawRow;
  onDone: (message: string) => void;
  onError: (error: unknown) => void;
}) {
  const url = `/api/machine-types/${encodeURIComponent(row.name)}`;
  const [hasClaw, setHasClaw] = useState(Boolean(row.has_claw_settings));
  const [target, setTarget] = useState(show(row.target_payout_percent));
  const [confirmTarget, setConfirmTarget] = useState(false);
  const [limits, setLimits] = useState({
    weakStep: show(row.claw_weak_step),
    strongStep: show(row.claw_strong_step),
    mediumStep: show(row.claw_medium_step),
    weakMin: show(row.claw_weak_min),
    weakMax: show(row.claw_weak_max),
    strongMin: show(row.claw_strong_min),
    strongMax: show(row.claw_strong_max),
    mediumMin: show(row.claw_medium_min),
    mediumMax: show(row.claw_medium_max),
  });
  const [plan, setPlan] = useState({ strong: '', medium: '', weak: '', prizeSet: '' });
  const [planStep, setPlanStep] = useState<'closed' | 'form' | 'confirm'>('closed');
  const [analytics, setAnalytics] = useState<Analytics | null>(null);

  useEffect(() => {
    if (!row.has_claw_settings) return;
    api.get<Analytics>(`${url}/claw-analytics`).then(setAnalytics).catch(() => setAnalytics(null));
  }, [row.name, row.has_claw_settings]);

  const saveConfig = async () => {
    try {
      await api.patch(`${url}/claw`, {
        hasClawSettings: hasClaw,
        weakStep: num(limits.weakStep) ?? undefined,
        strongStep: num(limits.strongStep) ?? undefined,
        mediumStep: num(limits.mediumStep) ?? undefined,
        weakMin: num(limits.weakMin),
        weakMax: num(limits.weakMax),
        strongMin: num(limits.strongMin) ?? undefined,
        strongMax: num(limits.strongMax) ?? undefined,
        mediumMin: num(limits.mediumMin) ?? undefined,
        mediumMax: num(limits.mediumMax) ?? undefined,
      });
      onDone(`Настройки клешни типа «${row.name}» сохранены`);
    } catch (caught) {
      onError(caught);
    }
  };

  const applyTarget = async () => {
    try {
      const result = await api.post<{ machines: number; overwritten: number; targetPayoutPercent: number | null }>(
        `${url}/apply-target`,
        { percent: num(target) },
      );
      setConfirmTarget(false);
      onDone(
        result.targetPayoutPercent === null
          ? `Цель снята у типа «${row.name}»`
          : `Цель ${result.targetPayoutPercent} % назначена ${result.machines} аппаратам${result.overwritten ? `, своя цель заменена у ${result.overwritten}` : ''}`,
      );
    } catch (caught) {
      onError(caught);
    }
  };

  const planValues = {
    strong: num(plan.strong),
    medium: num(plan.medium),
    weak: num(plan.weak),
    prizeSet: num(plan.prizeSet),
  };
  const planText = [
    planValues.strong !== null ? `Strong ${formatVolts(planValues.strong)} В` : null,
    planValues.medium !== null ? `Medium ${formatVolts(planValues.medium)} В` : null,
    planValues.weak !== null ? `Weak ${formatVolts(planValues.weak)} В` : null,
    planValues.prizeSet !== null ? `Prize Set ${planValues.prizeSet}` : null,
  ].filter(Boolean).join(', ');

  const createPlan = async () => {
    try {
      const result = await api.post<{ created: number }>(`${url}/claw-plan`, planValues);
      setPlanStep('closed');
      setPlan({ strong: '', medium: '', weak: '', prizeSet: '' });
      onDone(`Создано задач: ${result.created}. Значения станут действующими, когда техники подтвердят.`);
    } catch (caught) {
      onError(caught);
    }
  };

  const band = num(target) !== null ? payoutBand(num(target)) : null;
  const field = (key: keyof typeof limits, label: string) => (
    <label className="type-claw-field">
      <span>{label}</span>
      <input className="mono" inputMode="decimal" value={limits[key]} onChange={(event) => setLimits({ ...limits, [key]: event.target.value })} />
    </label>
  );

  return (
    <div className="type-claw">
      <div className="grid-2" style={{ gap: 16, alignItems: 'start' }}>
        <div className="type-claw-cfg">
          <label className="row" style={{ gap: 8, justifyContent: 'flex-start' }}>
            <input type="checkbox" checked={hasClaw} onChange={(event) => setHasClaw(event.target.checked)} />
            Есть меню Claw Set — показывать блок «Клешня» в форме и карточке
          </label>

          <div className="type-claw-row">
            <span className="lbl">Цель отдачи</span>
            <div style={{ display: 'grid', gap: 8 }}>
              <div className="row" style={{ gap: 8, justifyContent: 'flex-start' }}>
                <input className="mono" style={{ width: 90 }} inputMode="decimal" value={target} onChange={(event) => { setTarget(event.target.value); setConfirmTarget(false); }} />
                <span>%</span>
                <span className="muted" style={{ fontSize: 12 }}>
                  {band ? `норма ${formatVolts(band.low)}–${formatVolts(band.high)} %` : 'пусто — общая норма 25–40 %'}
                </span>
              </div>
              {confirmTarget ? (
                <div className="type-claw-confirm">
                  <div>
                    Цель <b>{band ? `${target} %` : 'не задана'}</b> будет назначена всем <b>{row.machines_count}</b> аппаратам типа.
                    Своя цель у аппаратов будет заменена.
                  </div>
                  <div className="row" style={{ gap: 8, justifyContent: 'flex-start' }}>
                    <button type="button" className="primary" onClick={() => void applyTarget()}>Назначить всем {row.machines_count}</button>
                    <button type="button" onClick={() => setConfirmTarget(false)}>Отмена</button>
                  </div>
                </div>
              ) : (
                <div><button type="button" onClick={() => setConfirmTarget(true)}>Назначить всем {row.machines_count}</button></div>
              )}
            </div>
          </div>

          <div className="type-claw-row">
            <span className="lbl">Шаг на плате, В</span>
            <div className="type-claw-grid">
              {field('weakStep', 'Weak')}
              {field('strongStep', 'Strong')}
              {field('mediumStep', 'Medium')}
            </div>
          </div>
          <div className="type-claw-row">
            <span className="lbl">Границы, В</span>
            <div className="type-claw-grid">
              {field('weakMin', 'Weak от')}
              {field('weakMax', 'Weak до')}
              {field('strongMin', 'Strong от')}
              {field('strongMax', 'Strong до')}
              {field('mediumMin', 'Medium от')}
              {field('mediumMax', 'Medium до')}
            </div>
          </div>
          <div><button type="button" className="primary" onClick={() => void saveConfig()}>Сохранить настройки клешни</button></div>
        </div>

        <div className="type-claw-plan">
          <strong>Выставить настройки клешни всем</strong>
          <p className="muted" style={{ fontSize: 12.5, margin: '6px 0 10px' }}>
            Система не меняет плату сама: она создаст техникам задачи по всем установленным аппаратам типа.
            Значение станет действующим, когда техник подтвердит, что выставил.
          </p>
          {planStep === 'closed' && (
            <button type="button" disabled={!row.has_claw_settings} onClick={() => setPlanStep('form')}>Выставить настройки всем…</button>
          )}
          {planStep !== 'closed' && (
            <div style={{ display: 'grid', gap: 10 }}>
              <div className="type-claw-grid">
                {(['strong', 'medium', 'weak', 'prizeSet'] as const).map((key) => (
                  <label className="type-claw-field" key={key}>
                    <span>{{ strong: 'Strong', medium: 'Medium', weak: 'Weak', prizeSet: 'Prize Set' }[key]}</span>
                    <input className="mono" inputMode="decimal" placeholder="не менять" value={plan[key]} onChange={(event) => { setPlan({ ...plan, [key]: event.target.value }); setPlanStep('form'); }} />
                  </label>
                ))}
              </div>
              {planStep === 'confirm' ? (
                <div className="type-claw-confirm">
                  <div>Будут созданы задачи «Выставить настройки клешни» по установленным аппаратам типа: <b>{planText}</b>.</div>
                  <div className="row" style={{ gap: 8, justifyContent: 'flex-start' }}>
                    <button type="button" className="primary" onClick={() => void createPlan()}>Создать задачи</button>
                    <button type="button" onClick={() => setPlanStep('form')}>Назад</button>
                  </div>
                </div>
              ) : (
                <div className="row" style={{ gap: 8, justifyContent: 'flex-start' }}>
                  <button type="button" className="primary" disabled={!planText} onClick={() => setPlanStep('confirm')}>Дальше</button>
                  <button type="button" onClick={() => setPlanStep('closed')}>Отмена</button>
                </div>
              )}
            </div>
          )}
          {!row.has_claw_settings && <p className="muted" style={{ fontSize: 12 }}>Сначала включите меню Claw Set и сохраните.</p>}
        </div>
      </div>

      {analytics && (
        <div className="type-claw-analytics">
          <div className="row">
            <strong>Больше выигрывают — больше играют?</strong>
            <span className="muted" style={{ fontSize: 12 }}>
              {analytics.periods.toLocaleString('ru-RU')} периодов
              {analytics.firstServiceAt ? ` с ${new Date(analytics.firstServiceAt).toLocaleDateString('ru-RU')}` : ''}
            </span>
          </div>
          <div className="grid-2" style={{ gap: 16, alignItems: 'start' }}>
            <div>
              <div className="lbl-small">Темп игр в следующем периоде, % от обычного для аппарата</div>
              <PaceChart analytics={analytics} target={num(target)} />
              <p className="muted" style={{ fontSize: 12, margin: '4px 0 0' }}>
                Снизу — отдача в периоде. Темп берём в следующем периоде: в слабую неделю процент отдачи растёт сам собой, потому что выручка в знаменателе. Усы — ± ошибка среднего.
              </p>
            </div>
            <div style={{ display: 'grid', gap: 10 }}>
              <div className="claw-insight">
                <b>Что видно сейчас</b>
                <span>{verdictText(analytics)}</span>
                <span className="muted">Отдача здесь менялась сама, а не настройкой. Точнее покажут изменения Weak ниже.</span>
              </div>
              <div className="table-wrap scroll-x">
                <table>
                  <thead>
                    <tr><th>Изменения Weak</th><th className="num">Раз</th><th className="num">Прошло 14 дн.</th><th className="num">Игр/сут к фону</th><th className="num">После игрушек</th></tr>
                  </thead>
                  <tbody>
                    {analytics.effects.map((effect) => (
                      <tr key={effect.direction}>
                        <td>{effect.direction === 'raise' ? 'прибавили' : 'убавили'}</td>
                        <td className="num mono">{effect.count}</td>
                        <td className="num mono">{effect.complete}</td>
                        <td className="num mono">{signed(effect.paceAdjustedPercent)}</td>
                        <td className="num mono">{signed(effect.netChangePercent)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
