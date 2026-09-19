import { useState, type ReactNode } from 'react';
import { formatGames, formatMoney } from '../calc';
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
