import { useEffect, useState } from 'react';
import { api } from '../../api';
import { formatMoney } from '../../calc';
import {
  adviceText,
  formatVolts,
  payoutLevel,
  type ClawAdviceResult,
  type ClawChangeEffect,
  type ClawLimits,
  type PayoutBand,
  type PeriodTotals,
} from '../../clawAdvice';
import { newLocalId } from '../../localId';
import { ClawTimeline, type ClawPeriodPoint } from './ClawTimeline';

/**
 * Вкладка «Клешня и отдача» карточки аппарата (DECISION-090): цель и коридор, отдача с последнего
 * изменения настроек, совет, действующие значения с кнопкой «Изменили на аппарате», история
 * изменений с отдачей «потом» и аналитика «настройки и выручка».
 */

interface SettingRow {
  id: number;
  effectiveAt: string;
  strong: number | null;
  medium: number | null;
  weak: number | null;
  prizeSet: number | null;
  source: 'SERVICE' | 'CARD' | 'TASK';
  enteredByName: string | null;
  note: string;
}

interface HistoryRow extends SettingRow {
  tenure: PeriodTotals & { payoutPercent: number | null };
  effect: ClawChangeEffect | null;
}

export interface MachineClawCardData {
  machineNumber: string;
  machineType: string;
  enabled: boolean;
  limits: ClawLimits;
  band: PayoutBand;
  machineTarget: number | null;
  typeTarget: number | null;
  current: SettingRow | null;
  since: PeriodTotals & { payoutPercent: number | null };
  advice: ClawAdviceResult;
  history: HistoryRow[];
  periods: ClawPeriodPoint[];
}

const SOURCE: Record<SettingRow['source'], string> = {
  SERVICE: 'обслуживание',
  CARD: 'карточку',
  TASK: 'задачу',
};

const pct = (value: number | null, digits = 1) =>
  value === null ? '—' : `${value.toFixed(digits).replace('.', ',')} %`;
const date = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });
/** Рубли в сутки — без копеек. */
const rub = (value: number) => Math.round(value).toLocaleString('ru-RU');
const signed = (value: number | null) =>
  value === null ? '—' : `${value > 0 ? '+' : value < 0 ? '−' : '±'}${Math.abs(Math.round(value))} %`;
const trend = (value: number | null, threshold = 2) =>
  value === null ? 'flat' : value > threshold ? 'up' : value < -threshold ? 'down' : 'flat';

function levelClass(percent: number | null, band: PayoutBand): 'ok' | 'low' | 'high' | 'none' {
  return percent === null ? 'none' : payoutLevel(percent, band);
}

const LEVEL_WORD = { ok: 'норма', low: 'отдаёт мало', high: 'отдаёт много', none: 'нет данных' } as const;
const ICON: Record<'ok' | 'low' | 'high' | 'none', string> = {
  low: 'M12 19V5M5 12l7-7 7 7',
  high: 'M12 5v14M5 12l7 7 7-7',
  ok: 'M5 12.5l4.5 4.5L19 7.5',
  none: 'M6 12h12',
};

function Indicator({ percent, band, word }: { percent: number | null; band: PayoutBand; word?: string }) {
  const level = levelClass(percent, band);
  return (
    <span className={`tci tci-${level}`}>
      <span className="tci-ico"><svg viewBox="0 0 24 24" aria-hidden="true"><path d={ICON[level]} /></svg></span>
      <span className="tci-txt">
        <b>{percent === null ? '—' : `${Math.round(percent)}%`}</b>
        <small>{word ?? LEVEL_WORD[level]}</small>
      </span>
    </span>
  );
}

/** Полоса 0…max с зелёным коридором нормы и точкой текущей отдачи. */
function Corridor({ percent, band }: { percent: number | null; band: PayoutBand }) {
  const max = Math.max(60, Math.ceil(((percent ?? 0) + 10) / 10) * 10);
  const x = (value: number) => `${Math.max(0, Math.min(100, (value / max) * 100))}%`;
  const level = levelClass(percent, band);
  return (
    <div className="claw-corridor" aria-label={`Коридор нормы ${band.low}–${band.high} %`}>
      <div className="bar" />
      <div className="norm" style={{ left: x(band.low), width: `calc(${x(band.high)} - ${x(band.low)})` }} />
      {percent !== null && <div className={`dot tci-${level}`} style={{ left: x(percent) }} />}
      <span className="tick" style={{ left: x(band.low) }}>{formatVolts(band.low).replace(',0', '')}</span>
      <span className="tick" style={{ left: x(band.high) }}>{formatVolts(band.high).replace(',0', '')}</span>
      <span className="tick edge-left">0</span>
      <span className="tick edge-right">{max} %</span>
    </div>
  );
}

function EditValues({
  card,
  onSaved,
  onCancel,
}: {
  card: MachineClawCardData;
  onSaved: (message: string) => void;
  onCancel: () => void;
}) {
  const current = card.current;
  const [fields, setFields] = useState({
    strong: current?.strong?.toString().replace('.', ',') ?? '',
    medium: current?.medium?.toString().replace('.', ',') ?? '',
    weak: current?.weak?.toString().replace('.', ',') ?? '',
    prizeSet: current?.prizeSet?.toString() ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const parse = (text: string) => (text.trim() === '' ? null : Number(text.replace(',', '.')));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ changed: boolean }>(
        `/api/machines/${encodeURIComponent(card.machineNumber)}/claw-settings`,
        {
          localId: newLocalId(),
          strong: parse(fields.strong),
          medium: parse(fields.medium),
          weak: parse(fields.weak),
          prizeSet: parse(fields.prizeSet),
        },
      );
      onSaved(result.changed ? 'Настройки сохранены — наблюдение начато заново' : 'Значения те же — запись не создана');
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="claw-edit">
      <p className="muted">Введите, что сейчас стоит на аппарате. Поменяйте только то, что меняли.</p>
      <div className="claw-edit-grid">
        {([
          ['strong', 'Strong · п.1'],
          ['medium', 'Medium · п.2'],
          ['weak', 'Weak · п.3'],
          ['prizeSet', 'Prize Set'],
        ] as const).map(([key, label]) => (
          <label key={key}>
            <span className="field-label">{label}</span>
            <input
              className="mono"
              inputMode="decimal"
              value={fields[key]}
              onChange={(event) => setFields({ ...fields, [key]: event.target.value })}
            />
          </label>
        ))}
      </div>
      {error && <div className="alert error" style={{ margin: 0 }}>{error}</div>}
      <div className="row" style={{ gap: 8, justifyContent: 'flex-start' }}>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>Сохранить</button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Отмена</button>
      </div>
    </div>
  );
}

function TargetEditor({
  card,
  onSaved,
  onCancel,
}: {
  card: MachineClawCardData;
  onSaved: (message: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(String(card.band.target ?? ''));
  const [error, setError] = useState<string | null>(null);
  const put = async (percent: number | null) => {
    try {
      await api.put(`/api/machines/${encodeURIComponent(card.machineNumber)}/target-payout`, { percent });
      onSaved(percent === null ? 'Цель снова как у типа' : `Своя цель аппарата — ${percent} %`);
    } catch (caught) {
      setError((caught as Error).message);
    }
  };
  return (
    <div className="claw-edit">
      <div className="row" style={{ gap: 8, justifyContent: 'flex-start' }}>
        <label className="field-label" htmlFor="own-target" style={{ margin: 0 }}>Своя цель, %</label>
        <input id="own-target" className="mono" style={{ width: 90 }} inputMode="decimal" value={value} onChange={(event) => setValue(event.target.value)} />
      </div>
      {error && <div className="alert error" style={{ margin: 0 }}>{error}</div>}
      <div className="row" style={{ gap: 8, justifyContent: 'flex-start' }}>
        <button type="button" className="btn btn-primary" onClick={() => void put(Number(value.replace(',', '.')))}>Сохранить</button>
        {card.machineTarget !== null && (
          <button type="button" className="btn btn-ghost" onClick={() => void put(null)}>Как у типа</button>
        )}
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Отмена</button>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>Массовое назначение цели на тип перезапишет это значение.</p>
    </div>
  );
}

function describeChange(row: HistoryRow, previous: HistoryRow | null): string {
  if (!previous) {
    const parts = [
      row.strong !== null ? `Strong ${formatVolts(row.strong)}` : null,
      row.medium !== null ? `Medium ${formatVolts(row.medium)}` : null,
      row.weak !== null ? `Weak ${formatVolts(row.weak)}` : null,
      row.prizeSet !== null ? `Prize ${row.prizeSet}` : null,
    ].filter(Boolean);
    return `Первые показания: ${parts.join(' · ')}`;
  }
  const parts: string[] = [];
  const add = (label: string, from: number | null, to: number | null, volts = true) => {
    if (from === to) return;
    const show = (value: number | null) => (value === null ? '—' : volts ? formatVolts(value) : String(value));
    parts.push(`${label} ${show(from)} → ${show(to)}`);
  };
  add('Weak', previous.weak, row.weak);
  add('Strong', previous.strong, row.strong);
  add('Medium', previous.medium, row.medium);
  add('Prize', previous.prizeSet, row.prizeSet, false);
  return parts.join(' · ') || 'Без изменений значений';
}

/** Итог последнего изменения: три цифры «до → после». */
function LastEffect({ card }: { card: MachineClawCardData }) {
  const index = card.history.findIndex((row) => row.effect !== null);
  if (index < 0) {
    return (
      <div className="claw-empty">
        Итог изменения появится после первого изменения настроек: система сравнит 14 дней до и 14 дней после.
      </div>
    );
  }
  const row = card.history[index];
  const previous = card.history[index + 1] ?? null;
  const effect = row.effect as ClawChangeEffect;
  const net = effect.netChangePercent;
  const summary = !effect.complete
    ? 'С изменения прошло меньше 14 дней — итог предварительный.'
    : (effect.paceAdjustedPercent ?? 0) > 2 && (net ?? 0) < -2
      ? 'Играть стали больше, но игрушек ушло ещё больше — после игрушек вышло меньше.'
      : (effect.paceAdjustedPercent ?? 0) > 2 && (net ?? 0) >= -2
        ? 'Играть стали больше, и после игрушек не потеряли.'
        : Math.abs(net ?? 0) <= 2
          ? 'Заметного эффекта нет: после игрушек почти без изменений.'
          : (net ?? 0) > 0
            ? 'После игрушек стало больше.'
            : 'После игрушек стало меньше.';
  return (
    <>
      <div className="claw-insight">
        <b>Последнее изменение: {describeChange(row, previous)} ({date(row.effectiveAt)})</b>
        <span className="muted">{summary}</span>
      </div>
      <div className="claw-effect">
        <div>
          <span className="lbl">Отдача</span>
          <span className="v">{pct(effect.payoutBefore, 0)} → {pct(effect.payoutAfter, 0)}</span>
          <span className="d flat">{card.band.target !== null ? `цель ${card.band.target} %` : `норма ${card.band.low}–${card.band.high} %`}</span>
        </div>
        <div>
          <span className="lbl">Игр в сутки</span>
          <span className="v">
            {effect.gamesPerDayBefore === null ? '—' : Math.round(effect.gamesPerDayBefore)} → {effect.gamesPerDayAfter === null ? '—' : Math.round(effect.gamesPerDayAfter)}
          </span>
          <span className={`d ${trend(effect.paceAdjustedPercent)}`}>
            {signed(effect.paceChangePercent)} · с поправкой на фон {card.machineType} {signed(effect.paceAdjustedPercent)}
          </span>
        </div>
        <div>
          <span className="lbl">После игрушек, ₽/сут</span>
          <span className="v">
            {effect.netPerDayBefore === null ? '—' : rub(effect.netPerDayBefore)} → {effect.netPerDayAfter === null ? '—' : rub(effect.netPerDayAfter)}
          </span>
          <span className={`d ${trend(effect.netChangePercent)}`}>{signed(effect.netChangePercent)}</span>
        </div>
      </div>
    </>
  );
}

/** Периоды настроек: что было при каждом значении — главная цифра «после игрушек в сутки». */
function SettingPeriods({ card }: { card: MachineClawCardData }) {
  const now = Date.now();
  const rows = card.history.map((row, index) => {
    const end = index === 0 ? now : new Date(card.history[index - 1].effectiveAt).getTime();
    const days = Math.max((end - new Date(row.effectiveAt).getTime()) / 86_400_000, 0);
    const { games, revenue, toyCost, payoutPercent } = row.tenure;
    return {
      row,
      days,
      gamesPerDay: days > 0 ? games / days : null,
      revenuePerDay: days > 0 ? revenue / days : null,
      netPerDay: days > 0 ? (revenue - toyCost) / days : null,
      payoutPercent,
    };
  });
  const finished = rows.filter((item) => item.days >= 7 && item.netPerDay !== null);
  const best = finished.reduce<typeof rows[number] | null>((top, item) => (!top || (item.netPerDay ?? 0) > (top.netPerDay ?? 0) ? item : top), null);
  if (rows.length === 0) return null;
  return (
    <div className="table-wrap scroll-x">
      <table className="claw-periods">
        <thead>
          <tr>
            <th>Weak</th>
            <th>С</th>
            <th className="num">Дней</th>
            <th className="num">Игр/сут</th>
            <th className="num">Отдача</th>
            <th className="num">Выручка/сут</th>
            <th className="num">После игрушек/сут</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((item) => (
            <tr key={item.row.id} className={item === best && finished.length > 1 ? 'best' : undefined}>
              <td className="mono">{formatVolts(item.row.weak)}</td>
              <td className="mono">{date(item.row.effectiveAt)}</td>
              <td className="num mono">{Math.round(item.days)}</td>
              <td className="num mono">{item.gamesPerDay === null ? '—' : Math.round(item.gamesPerDay)}</td>
              <td className="num mono">{pct(item.payoutPercent, 0)}</td>
              <td className="num mono">{item.revenuePerDay === null ? '—' : `${rub(item.revenuePerDay)} ₽`}</td>
              <td className="num mono">
                <b>{item.netPerDay === null ? '—' : `${rub(item.netPerDay)} ₽`}</b>
                {item === best && finished.length > 1 && <span className="chip" style={{ marginLeft: 6 }}>лучше всего</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MachineClawPanel({ machineNumber, canEditTarget, canEditValues }: {
  machineNumber: string;
  canEditTarget: boolean;
  canEditValues: boolean;
}) {
  const [card, setCard] = useState<MachineClawCardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editValues, setEditValues] = useState(false);
  const [editTarget, setEditTarget] = useState(false);

  const load = () =>
    api
      .get<MachineClawCardData>(`/api/machines/${encodeURIComponent(machineNumber)}/claw`)
      .then(setCard)
      .catch((caught) => setError((caught as Error).message));

  useEffect(() => {
    void load();
  }, [machineNumber]);

  if (error) return <div className="alert error">{error}</div>;
  if (!card) return <p className="muted">Загрузка…</p>;

  const done = (message: string) => {
    setNotice(message);
    setEditValues(false);
    setEditTarget(false);
    void load();
  };

  const { band, since, advice } = card;
  const current = card.current;

  return (
    <div className="claw-panel">
      {notice && <div className="alert ok">{notice}</div>}
      <div className="grid-2 claw-panel-top">
        <section className="card card-pad">
          <h3 className="claw-h">Отдача</h3>
          <div className="claw-target">
            <span className="lbl">Цель</span>
            <span className="big mono">{band.target === null ? '—' : `${band.target} %`}</span>
            <span className="chip">
              {card.machineTarget !== null ? 'своя у аппарата' : band.target !== null ? `как у типа ${card.machineType}` : 'не задана — норма 25–40 %'}
            </span>
            {canEditTarget && !editTarget && (
              <button type="button" className="btn btn-ghost" onClick={() => setEditTarget(true)}>Изменить</button>
            )}
          </div>
          {editTarget && <TargetEditor card={card} onSaved={done} onCancel={() => setEditTarget(false)} />}
          <Corridor percent={since.payoutPercent} band={band} />
          <div className="claw-since">
            <div className="row">
              <span className="muted">{current ? `С ${date(current.effectiveAt)} (текущая настройка)` : 'Настройки ещё не вносились'}</span>
              <Indicator percent={since.payoutPercent} band={band} />
            </div>
            <dl className="claw-kv">
              <dt>Игр</dt><dd className="mono">{Math.round(since.games).toLocaleString('ru-RU')}</dd>
              <dt>Выручка</dt><dd className="mono">{formatMoney(since.revenue.toFixed(2))} ₽</dd>
              <dt>Игрушки</dt><dd className="mono">{formatMoney(since.toyCost.toFixed(2))} ₽</dd>
            </dl>
            <div className={`alert ${advice.advice.kind === 'ok' ? 'ok' : advice.advice.kind === 'change' || advice.advice.kind === 'limit' ? 'warn' : ''}`} style={{ margin: 0 }}>
              <b>Совет:</b> {adviceText(advice.advice)}
            </div>
            {advice.warnings.includes('order') && (
              <div className="alert warn" style={{ margin: 0 }}>Значения противоречат друг другу: должно быть Strong ≥ Medium ≥ Weak.</div>
            )}
          </div>
        </section>

        <section className="card card-pad">
          <div className="row">
            <h3 className="claw-h">Клешня · Crane Setting → Claw Set</h3>
            {canEditValues && !editValues && (
              <button type="button" className="btn btn-ghost" onClick={() => setEditValues(true)}>Изменили на аппарате</button>
            )}
          </div>
          <div className="claw-values">
            <div><span className="lbl">Strong · п.1</span><b className="mono">{formatVolts(current?.strong ?? null)}</b></div>
            <div><span className="lbl">Medium · п.2</span><b className="mono">{formatVolts(current?.medium ?? null)}</b></div>
            <div className="hl"><span className="lbl">Weak · п.3</span><b className="mono">{formatVolts(current?.weak ?? null)}</b></div>
            <div><span className="lbl">Prize Set</span><b className="mono">{current?.prizeSet ?? '—'}</b></div>
          </div>
          {editValues && <EditValues card={card} onSaved={done} onCancel={() => setEditValues(false)} />}

          <h3 className="claw-h" style={{ marginTop: 18, fontSize: 14 }}>История настроек</h3>
          {card.history.length === 0 && <p className="muted">Изменений пока не было.</p>}
          <ul className="claw-hist">
            {card.history.map((row, index) => (
              <li key={row.id}>
                <span className="d mono">{date(row.effectiveAt)}</span>
                <div>
                  <div>{describeChange(row, card.history[index + 1] ?? null)}</div>
                  <div className="who">{row.enteredByName ?? '—'} · через {SOURCE[row.source]}</div>
                </div>
                <div className="res">
                  {index === 0
                    ? <span className="chip">действует сейчас</span>
                    : <Indicator percent={row.tenure.payoutPercent} band={band} word={`${Math.round(row.tenure.games).toLocaleString('ru-RU')} игр`} />}
                </div>
              </li>
            ))}
          </ul>
          {card.history.length > 1 && (
            <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>Справа — отдача за то время, пока стояла эта настройка.</p>
          )}
        </section>
      </div>

      <section className="card card-pad claw-analytics">
        <div className="row">
          <h3 className="claw-h">Настройки и выручка</h3>
          <span className="muted" style={{ fontSize: 12 }}>сравнение 14 дней до и после изменения, с поправкой на общий фон типа</span>
        </div>
        <LastEffect card={card} />
        {card.periods.length > 1 && <ClawTimeline periods={card.periods} band={band} />}
        <SettingPeriods card={card} />
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>
          Главная цифра — «после игрушек в сутки»: выручка минус стоимость отданных игрушек. Она показывает, окупает ли рост игр рост отдачи.
        </p>
      </section>
    </div>
  );
}
