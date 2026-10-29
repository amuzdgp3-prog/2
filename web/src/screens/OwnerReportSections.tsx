import { useState, type ReactNode } from 'react';
import { formatGames, formatMoney } from '../calc';
import { adviceText } from '../clawAdvice';
import type {
  OwnerMonthExpenseLine,
  OwnerMonthReport,
} from '../ownerMonthReport';

const money = (value: string | number) => `${formatMoney(value)} ₽`;

/** «1 точка», «2 точки», «5 точек». */
function pointsLabel(count: number): string {
  const lastTwo = count % 100;
  const last = count % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return `${count} точек`;
  if (last === 1) return `${count} точка`;
  if (last >= 2 && last <= 4) return `${count} точки`;
  return `${count} точек`;
}

/** Доля в процентах, целым числом; 0, если делить не на что. */
function percent(part: string, whole: string): number {
  const denominator = Number(whole);
  if (!denominator) return 0;
  return Math.round((Number(part) / denominator) * 100);
}

function Line({
  label,
  value,
  className = '',
}: {
  label: ReactNode;
  value: string | number;
  className?: string;
}) {
  return (
    <div className={`or-line ${className}`.trim()}>
      <span>{label}</span>
      <span className="mono">{money(value)}</span>
    </div>
  );
}

/** Строка со значком раскрытия: свёрнутая по умолчанию, как «Прочие расходы» и точки без аппарата. */
function Fold({
  label,
  value,
  children,
  labelClassName,
  bodyClassName = 'or-fold-body',
}: {
  label: ReactNode;
  value: string;
  children: ReactNode;
  labelClassName?: string;
  bodyClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="or-fold" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className={labelClassName}>
          <span className="or-chevron" aria-hidden="true">▸</span>
          {label}
        </span>
        <span className={`mono ${labelClassName ?? ''}`.trim()}>{money(value)}</span>
      </button>
      {open && <div className={bodyClassName}>{children}</div>}
    </>
  );
}

export function RevenueAndProfit({ report }: { report: OwnerMonthReport }) {
  const cashPercent = percent(report.cash, report.revenue);
  const cashlessPercent = report.revenue && Number(report.revenue) ? 100 - cashPercent : 0;
  const negative = Number(report.profit) < 0;
  return (
    <div className="or-head">
      <div className="card card-pad or-revenue">
        <div className="muted">Общая выручка</div>
        <div className="or-figure xl">{money(report.revenue)}</div>
        <div className="or-split">
          <div><div className="muted">Наличные</div><div className="or-figure">{money(report.cash)}</div></div>
          <div><div className="muted">Безнал</div><div className="or-figure">{money(report.cashless)}</div></div>
        </div>
        <div className="or-bar" role="img" aria-label={`Наличные ${cashPercent}%, безнал ${cashlessPercent}%`}>
          <div style={{ background: 'var(--surface-ink)', width: `${cashPercent}%` }} />
          <div style={{ background: 'var(--brass)', width: `${cashlessPercent}%` }} />
        </div>
        <div className="or-legend">
          <span><span className="or-dot" style={{ background: 'var(--surface-ink)' }} />Наличные {cashPercent}%</span>
          <span><span className="or-dot" style={{ background: 'var(--brass)' }} />Безнал {cashlessPercent}%</span>
        </div>
      </div>
      <div className={`card card-pad or-profit${negative ? ' negative' : ''}`}>
        <div className="or-profit-title">Прибыль за вычетом расходов</div>
        <div className="or-figure lg" style={{ marginTop: 4 }}>{money(report.profit)}</div>
        <div className="muted" style={{ marginTop: 6 }}>
          Выручка {formatMoney(report.revenue)} − расходы {formatMoney(report.expenses.total)}
        </div>
      </div>
    </div>
  );
}

export function MachineCounts({ report }: { report: OwnerMonthReport }) {
  const items: Array<[string, number]> = [
    ['Аппаратов в отчёте', report.machines.total],
    ['С терминалом', report.machines.withTerminal],
    ['Без терминала', report.machines.withoutTerminal],
  ];
  return (
    <div className="or-stats">
      {items.map(([label, value]) => (
        <div key={label} className="card card-pad">
          <div className="muted">{label}</div>
          <div className="or-figure lg" style={{ marginTop: 4 }}>{value}</div>
        </div>
      ))}
    </div>
  );
}

export function GroupsTable({ report }: { report: OwnerMonthReport }) {
  return (
    <div className="card card-pad" style={{ marginBottom: 12 }}>
      <h2 className="or-title">Аппараты по типам и цене игры</h2>
      <p className="or-sub">Наличные и безнал в разрезе типа аппарата и цены одной игры</p>
      <div className="table-wrap scroll-x">
        <table>
          <thead>
            <tr>
              <th>Тип</th>
              <th className="num">Цена игры</th>
              <th className="num">Аппаратов</th>
              <th className="num">Игр</th>
              <th className="num">Наличные</th>
              <th className="num">Безнал</th>
              <th className="num">Выручка</th>
            </tr>
          </thead>
          <tbody>
            {report.groups.map((group) => (
              <tr key={`${group.machineTypeName}|${group.gamePrice}`}>
                <td>{group.machineTypeName}</td>
                <td className="num">{money(group.gamePrice)}</td>
                <td className="num">{group.machines}</td>
                <td className="num">{formatGames(group.games)}</td>
                <td className="num">{money(group.cash)}</td>
                <td className="num">{money(group.cashless)}</td>
                <td className="num">{money(group.revenue)}</td>
              </tr>
            ))}
            <tr className="or-total-row">
              <td>Итого</td>
              <td />
              <td className="num">{report.machines.total}</td>
              <td className="num">{formatGames(report.groups.reduce((sum, group) => sum + Number(group.games), 0))}</td>
              <td className="num">{money(report.cash)}</td>
              <td className="num">{money(report.cashless)}</td>
              <td className="num">{money(report.revenue)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ExpenseLine({ line }: { line: OwnerMonthExpenseLine }) {
  if (line.items.length === 0) return <Line label={line.label} value={line.amount} />;
  const children = line.items.map((item, index) => (
    <Line key={`${item.label}-${index}`} label={item.label} value={item.amount} className={line.collapsed ? '' : 'child'} />
  ));
  if (line.collapsed) {
    return (
      <Fold label={<>{line.label} <span className="muted">({line.items.length})</span></>} value={line.amount}>
        {children}
      </Fold>
    );
  }
  return (
    <>
      <Line label={line.label} value={line.amount} />
      {children}
    </>
  );
}

export function ExpensesCard({ report }: { report: OwnerMonthReport }) {
  return (
    <div className="card card-pad">
      <h2 className="or-title">Расходы</h2>
      <p className="or-sub">Всё, что вычитается из выручки</p>
      {report.expenses.lines.map((line) => <ExpenseLine key={line.key} line={line} />)}
      <Line label="Всего расходов" value={report.expenses.total} className="total" />
    </div>
  );
}

export function CashReportCard({ report }: { report: OwnerMonthReport }) {
  const cash = report.cashReport;
  return (
    <div className="card card-pad">
      <h2 className="or-title">Отчёт по наличке</h2>
      <p className="or-sub">Деньги, которые прошли через меня</p>
      <Line label="Собрано наличными" value={cash.collected} />
      <Line label="− Зарплата, бензин, прочие" value={cash.spentFromCash} />
      <Line label="− Переведено на карту" value={cash.transferredToCard} />
      <Line label="Осталось на руках" value={cash.onHand} className="strong" />
      <div style={{ height: 10 }} />
      <Line label="Безнал" value={cash.cashless} />
      <Line label="На карту" value={cash.transferredToCard} />
      <Line label="Дошло до владельца" value={cash.reachedOwner} className="strong" />
    </div>
  );
}

export function RentCard({ report }: { report: OwnerMonthReport }) {
  const rent = report.rent;
  const idlePercent = percent(rent.idle, rent.total);
  const activePercent = Number(rent.total) ? 100 - idlePercent : 0;
  const pointsTotal = rent.activeLocationsCount + rent.idleLocations.length;
  return (
    <div className="card card-pad" style={{ marginBottom: 12 }}>
      <h2 className="or-title">Аренда</h2>
      <p className="or-sub">Платим за все точки с договорами, в том числе за те, где сейчас нет аппарата</p>
      <div className="or-rent-figures">
        <div>
          <div className="muted">Всего в месяц · {pointsLabel(pointsTotal)}</div>
          <div className="or-figure lg">{money(rent.total)}</div>
        </div>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <div>
            <div className="muted">Работают · {pointsLabel(rent.activeLocationsCount)}</div>
            <div className="or-figure" style={{ fontSize: 20 }}>{money(rent.active)}</div>
          </div>
          <div className="or-idle">
            <div style={{ fontSize: 13 }}>Простой, без аппарата · {pointsLabel(rent.idleLocations.length)}</div>
            <div className="or-figure" style={{ fontSize: 20 }}>{money(rent.idle)}</div>
          </div>
        </div>
      </div>
      <div className="or-bar" role="img" aria-label={`Работают ${activePercent}%, простой ${idlePercent}%`}>
        <div style={{ background: 'var(--brass)', width: `${activePercent}%` }} />
        <div style={{ background: 'var(--bad)', width: `${idlePercent}%` }} />
      </div>
      <div className="muted" style={{ marginTop: 8 }}>На простаивающие точки уходит {idlePercent}% аренды</div>
      {rent.idleLocations.length > 0 && (
        <Fold label="Точки без аппарата" value={rent.idle} labelClassName="or-idle" bodyClassName="or-idle-body">
          {rent.idleLocations.map((location) => (
            <Line key={location.locationId} label={location.locationName} value={location.amount} />
          ))}
        </Fold>
      )}
    </div>
  );
}

export function ToysTable({ report }: { report: OwnerMonthReport }) {
  return (
    <div className="card card-pad" style={{ marginBottom: 12 }}>
      <h2 className="or-title">Затраты на игрушки</h2>
      <p className="or-sub">Израсходовано за месяц</p>
      <div className="table-wrap scroll-x">
        <table>
          <thead>
            <tr>
              <th>Вид</th>
              <th className="num">Цена</th>
              <th className="num">Количество</th>
              <th className="num">Сумма</th>
            </tr>
          </thead>
          <tbody>
            {report.toys.rows.map((toy) => (
              <tr key={`${toy.toyName}|${toy.price}`}>
                <td>{toy.toyName}</td>
                <td className="num">{money(toy.price)}</td>
                <td className="num">{toy.quantity} шт.</td>
                <td className="num">{money(toy.amount)}</td>
              </tr>
            ))}
            <tr className="or-total-row">
              <td>Итого</td>
              <td />
              <td className="num">{report.toys.totalQuantity} шт.</td>
              <td className="num">{money(report.toys.totalAmount)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

const pct = (value: number | null) => (value === null ? '—' : `${(Math.round(value * 10) / 10).toString().replace('.', ',')} %`);
const signedPct = (value: number | null) =>
  value === null ? '—' : `${value > 0 ? '+' : value < 0 ? '−' : '±'}${Math.abs(Math.round(value))} %`;
const rubDay = (value: number | null) => (value === null ? '—' : `${Math.round(value).toLocaleString('ru-RU')} ₽`);

/**
 * «Отдача и настройки клешни» (DECISION-090): аппараты относительно цели, изменения Weak за месяц
 * и их эффект, аппараты, где совет висит. Тот же раздел — в xlsx (monthlyExcelReport.ts).
 */
export function PayoutCard({ report }: { report: OwnerMonthReport }) {
  const payout = report.payout;
  if (!payout || payout.types.length === 0) return null;
  const sum = payout.types.reduce(
    (total, type) => ({
      low: total.low + type.lowCount,
      ok: total.ok + type.okCount,
      high: total.high + type.highCount,
      early: total.early + type.earlyCount,
    }),
    { low: 0, ok: 0, high: 0, early: 0 },
  );
  const all = sum.low + sum.ok + sum.high + sum.early;
  const segment = (value: number, color: string, label: string) =>
    value > 0 ? <div title={`${label}: ${value}`} style={{ flex: value, background: color }} /> : null;
  return (
    <div className="card card-pad" style={{ marginBottom: 12 }}>
      <h2 className="or-title">Отдача и настройки клешни</h2>
      <p className="or-sub">Аппараты относительно цели — по отдаче с последнего изменения настроек на конец месяца</p>

      {all > 0 && (
        <>
          <div className="or-payout-bar">
            {segment(sum.low, 'var(--warn)', 'отдают мало')}
            {segment(sum.ok, 'var(--good)', 'в норме')}
            {segment(sum.high, 'var(--bad)', 'отдают много')}
            {segment(sum.early, 'var(--line)', 'рано судить')}
          </div>
          <div className="or-payout-legend">
            <span><i style={{ background: 'var(--warn)' }} />отдают мало <b>{sum.low}</b></span>
            <span><i style={{ background: 'var(--good)' }} />в норме <b>{sum.ok}</b></span>
            <span><i style={{ background: 'var(--bad)' }} />отдают много <b>{sum.high}</b></span>
            <span><i style={{ background: 'var(--line)' }} />рано судить <b>{sum.early}</b></span>
          </div>
        </>
      )}

      <div className="table-wrap scroll-x">
        <table>
          <thead>
            <tr>
              <th>Тип</th>
              <th className="num">Цель</th>
              <th className="num">Отдача за месяц</th>
              <th className="num">Мало / норма / много</th>
              <th className="num">После игрушек, в сутки на аппарат</th>
            </tr>
          </thead>
          <tbody>
            {payout.types.map((type) => {
              const change = type.netPerDay !== null && type.netPerDayPrev ? ((type.netPerDay - type.netPerDayPrev) / type.netPerDayPrev) * 100 : null;
              return (
                <tr key={type.machineTypeName}>
                  <td>{type.machineTypeName}</td>
                  <td className="num">{type.target === null ? `норма ${type.low}–${type.high} %` : `${type.target} %`}</td>
                  <td className="num">{pct(type.payoutPercent)} <span className="muted">(было {pct(type.payoutPercentPrev)})</span></td>
                  <td className="num">{type.lowCount} / {type.okCount} / {type.highCount}</td>
                  <td className="num"><b>{rubDay(type.netPerDay)}</b> <span className={change === null ? 'muted' : change > 1 ? 'or-up' : change < -1 ? 'or-down' : 'muted'}>{signedPct(change)}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="or-payout-cols">
        <div>
          <h3 className="or-subtitle">Изменения настроек за месяц</h3>
          <div className="or-payout-kpis">
            <div><span>Изменений Weak</span><b>{payout.changes.total}</b><small>на {payout.changes.machines} аппаратах</small></div>
            <div><span>По совету</span><b>{payout.changes.follow}</b><small>без совета {payout.changes.free} · против {payout.changes.against}</small></div>
            <div><span>Совет висит</span><b>{payout.changes.pendingAdvice}</b><small>аппаратов не трогали</small></div>
          </div>
          <div className="table-wrap scroll-x" style={{ marginTop: 10 }}>
            <table>
              <thead>
                <tr><th>Шаг</th><th className="num">Раз</th><th className="num">Игр в сутки</th><th className="num">После игрушек</th></tr>
              </thead>
              <tbody>
                {payout.changes.effects.map((effect) => (
                  <tr key={effect.direction}>
                    <td>Weak {effect.direction === 'raise' ? 'прибавили' : 'убавили'}</td>
                    <td className="num">{effect.count}{effect.complete < effect.count ? <span className="muted"> ({effect.complete} с итогом)</span> : null}</td>
                    <td className="num">{signedPct(effect.paceAdjustedPercent)}</td>
                    <td className="num">{signedPct(effect.netChangePercent)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="or-sub" style={{ marginTop: 6 }}>14 дней до и после изменения, с поправкой на общий фон типа. Изменения моложе 14 дней ещё не в средних.</p>
        </div>
        <div>
          <h3 className="or-subtitle">Требуют внимания</h3>
          <p className="or-sub">Вне нормы, 300+ игр с изменения, настройку не меняли</p>
          {payout.attention.length === 0 ? (
            <p className="muted">Таких аппаратов нет.</p>
          ) : (
            <div className="table-wrap scroll-x">
              <table>
                <thead>
                  <tr><th>Аппарат</th><th className="num">Отдача</th><th className="num">Игр с изменения</th><th>Совет</th></tr>
                </thead>
                <tbody>
                  {payout.attention.map((item) => (
                    <tr key={item.machineNumber}>
                      <td className="wrap">№ {item.machineNumber} {item.address} <span className="muted">· {item.machineTypeName}</span></td>
                      <td className="num">{pct(item.payoutPercent)}{item.target !== null && <span className="muted"> / цель {item.target} %</span>}</td>
                      <td className="num">{Math.round(item.games).toLocaleString('ru-RU')}</td>
                      <td>{adviceText(item.advice)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const COLLAPSED_ROWS = 10;

export function MachineRowsTable({ report }: { report: OwnerMonthReport }) {
  const [showAll, setShowAll] = useState(false);
  const rows = showAll ? report.machineRows : report.machineRows.slice(0, COLLAPSED_ROWS);
  return (
    <div className="card card-pad">
      <h2 className="or-title">Детализация по аппаратам</h2>
      <p className="or-sub">Как в журнале обслуживания, за месяц целиком</p>
      <div className="table-wrap scroll-x">
        <table>
          <thead>
            <tr>
              <th>№</th>
              <th>Адрес</th>
              <th>Тип</th>
              <th className="num">Цена</th>
              <th>Терминал</th>
              <th className="num">Игр</th>
              <th className="num">Наличные</th>
              <th className="num">Безнал</th>
              <th className="num">Выручка</th>
              <th className="num" title="Выручка ÷ игрушки за последние три обслуживания на конец месяца">ROI (3 обсл.)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((machine) => (
              <tr key={machine.machineNumber}>
                <td>{machine.machineNumber}</td>
                <td>{machine.address}</td>
                <td>{machine.machineTypeName}</td>
                <td className="num">{money(machine.gamePrice)}</td>
                <td>{machine.hasTerminal ? 'есть' : 'нет'}</td>
                <td className="num">{formatGames(machine.games)}</td>
                <td className="num">{money(machine.cash)}</td>
                <td className="num">{machine.hasTerminal ? money(machine.cashless) : '—'}</td>
                <td className="num">{money(machine.revenue)}</td>
                <td className="num">{machine.roi3 == null ? '—' : Number(machine.roi3).toFixed(2).replace('.', ',')}</td>
              </tr>
            ))}
            <tr className="or-total-row">
              <td />
              <td>Итого</td>
              <td /><td /><td />
              <td className="num">{formatGames(report.machineRows.reduce((sum, machine) => sum + Number(machine.games), 0))}</td>
              <td className="num">{money(report.cash)}</td>
              <td className="num">{money(report.cashless)}</td>
              <td className="num">{money(report.revenue)}</td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
      {report.machineRows.length > COLLAPSED_ROWS && (
        <button type="button" className="or-more" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Свернуть' : `Показать все ${report.machineRows.length}`}
        </button>
      )}
    </div>
  );
}
