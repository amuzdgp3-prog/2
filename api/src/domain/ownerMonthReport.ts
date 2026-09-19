import type { Client } from '../db/pool.js';
import type { Actor } from '../lib/audit.js';
import { assertAdmin } from '../lib/scope.js';
import { queryMachineRows, rentSummary, sumDecimal, type MachineRow } from './reports.js';

/**
 * Контракт отчёта владельца за календарный месяц (страница «Отчёт» и ежемесячный xlsx строятся из
 * одного и того же объекта, чтобы экран и файл не расходились).
 *
 * Деньги — строки с двумя знаками (как в остальных отчётах), проценты и доли клиент считает сам.
 * Зеркало этих типов на клиенте: web/src/ownerMonthReport.ts — при правке менять оба файла.
 */

/** Одна позиция внутри строки расходов: техник в «Зарплате», комментарий в «Прочих». */
export interface OwnerMonthExpenseItem {
  label: string;
  amount: string;
}

/**
 * Строка расходов. Список строк приходит с сервера целиком, клиент ничего не знает о конкретных
 * категориях, поэтому новая статья расходов появляется в отчёте без правок клиента.
 * «На карту» сюда не входит — это не расход, а наличные, переданные владельцу (DECISION-080).
 */
export interface OwnerMonthExpenseLine {
  /** Стабильный ключ строки: 'salary', 'fuel', 'other', 'rent', 'toys'. */
  key: string;
  label: string;
  amount: string;
  /** Раскрывающаяся детализация; пустой массив — строка без раскрытия. */
  items: OwnerMonthExpenseItem[];
  /** Показывать свёрнутой со значком раскрытия («Прочие расходы»). */
  collapsed: boolean;
}

/** Группа аппаратов с одним типом и одной ценой игры. */
export interface OwnerMonthGroup {
  machineTypeName: string;
  /** Цена игры по последнему обслуживанию аппарата в месяце. */
  gamePrice: string;
  machines: number;
  games: string;
  cash: string;
  cashless: string;
  revenue: string;
}

export interface OwnerMonthMachineCounts {
  total: number;
  withTerminal: number;
  withoutTerminal: number;
}

/** Отчёт по наличности: деньги, которые прошли через того, кто собирает аппараты. */
export interface OwnerMonthCashReport {
  /** Собрано наличными. */
  collected: string;
  /** Зарплата, бензин и прочие расходы, оплаченные из наличных. */
  spentFromCash: string;
  /** Переведено владельцу на карту (категория CARD). */
  transferredToCard: string;
  /** Осталось на руках: collected − spentFromCash − transferredToCard. */
  onHand: string;
  cashless: string;
  /** cashless + transferredToCard. */
  reachedOwner: string;
}

export interface OwnerMonthRentLocation {
  locationId: number;
  locationName: string;
  /** Аренда точки за месяц (с пропорцией, если ставка менялась внутри месяца). */
  amount: string;
}

/**
 * Аренда: платится за точку, не за аппарат. Простаивающая точка — точка с арендой, на которой не
 * было активного аппарата ни на один день месяца (если аппарат стоял хоть часть месяца, точка
 * считается работающей).
 */
export interface OwnerMonthRent {
  total: string;
  active: string;
  idle: string;
  activeLocationsCount: number;
  idleLocations: OwnerMonthRentLocation[];
}

export interface OwnerMonthToyRow {
  toyName: string;
  price: string;
  quantity: number;
  amount: string;
}

/** Строка детализации по аппаратам за месяц — как в журнале обслуживания, без техника. */
export interface OwnerMonthMachineRow {
  machineNumber: string;
  address: string;
  machineTypeName: string;
  /** Цена игры по последнему обслуживанию аппарата в месяце. */
  gamePrice: string;
  hasTerminal: boolean;
  games: string;
  cash: string;
  cashless: string;
  revenue: string;
}

export interface OwnerMonthReport {
  year: number;
  month: number;
  revenue: string;
  cash: string;
  cashless: string;
  /** Выручка минус все расходы из `expenses` (включая аренду и игрушки). */
  profit: string;
  machines: OwnerMonthMachineCounts;
  groups: OwnerMonthGroup[];
  expenses: { lines: OwnerMonthExpenseLine[]; total: string };
  cashReport: OwnerMonthCashReport;
  rent: OwnerMonthRent;
  toys: { rows: OwnerMonthToyRow[]; totalQuantity: number; totalAmount: string };
  machineRows: OwnerMonthMachineRow[];
}

/** Границы календарного месяца: даты для service_date/expense_date и моменты для периодов. */
interface MonthRange {
  from: string;
  to: string;
  start: string;
  end: string;
}

function monthRange(year: number, month: number): MonthRange {
  const pad = (value: number) => String(value).padStart(2, '0');
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    from: `${year}-${pad(month)}-01`,
    to: new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10),
    start: `${year}-${pad(month)}-01T00:00:00Z`,
    end: `${nextYear}-${pad(nextMonth)}-01T00:00:00Z`,
  };
}

/** Аппарат за месяц: строки по размещениям одного аппарата склеены в одну. */
interface MachineMonth {
  machineNumber: string;
  address: string;
  machineTypeName: string;
  gamePrice: string;
  hasTerminal: boolean;
  games: string;
  cash: string;
  cashless: string;
  revenue: string;
  toyCost: string;
}

async function loadMachineMonths(client: Client, actor: Actor, range: MonthRange): Promise<MachineMonth[]> {
  const rows = await queryMachineRows(client, actor, { from: range.from, to: range.to, limit: 2000 });

  // Цена игры аппарата — по последнему обслуживанию месяца (решение владельца: аппарат с
  // изменившейся посреди месяца ценой остаётся в одной строке).
  const prices = await client.query(
    `SELECT DISTINCT ON (machine_number) machine_number, price_per_game_snapshot AS price
     FROM services
     WHERE service_date >= $1::date AND service_date <= $2::date
     ORDER BY machine_number, occurred_at DESC, id DESC`,
    [range.from, range.to],
  );
  const priceByMachine = new Map<string, string>(
    prices.rows.map((row) => [String(row.machine_number), String(row.price)]),
  );

  // «С терминалом» — у аппарата была привязка терминала хотя бы на часть месяца.
  const bindings = await client.query(
    `SELECT DISTINCT machine_number FROM terminal_bindings
     WHERE tstzrange(started_at, ended_at) && tstzrange($1::timestamptz, $2::timestamptz)`,
    [range.start, range.end],
  );
  const withTerminal = new Set<string>(bindings.rows.map((row) => String(row.machine_number)));

  const byMachine = new Map<string, MachineRow[]>();
  for (const row of rows) {
    const list = byMachine.get(row.machineNumber) ?? [];
    list.push(row);
    byMachine.set(row.machineNumber, list);
  }

  return [...byMachine.entries()].map(([machineNumber, parts]) => ({
    machineNumber,
    address: parts[parts.length - 1].locationName,
    machineTypeName: parts[0].machineType,
    gamePrice: priceByMachine.get(machineNumber) ?? '0.00',
    hasTerminal: withTerminal.has(machineNumber),
    games: sumDecimal(parts.map((part) => part.newGames), 4),
    cash: sumDecimal(parts.map((part) => part.cash), 2),
    cashless: sumDecimal(parts.map((part) => part.cashless), 2),
    revenue: sumDecimal(parts.map((part) => part.revenue), 2),
    toyCost: sumDecimal(parts.map((part) => part.toyCost), 2),
  }));
}

function buildGroups(machines: MachineMonth[]): OwnerMonthGroup[] {
  const groups = new Map<string, MachineMonth[]>();
  for (const machine of machines) {
    const key = `${machine.machineTypeName}\u0000${machine.gamePrice}`;
    const list = groups.get(key) ?? [];
    list.push(machine);
    groups.set(key, list);
  }
  return [...groups.values()]
    .map((list) => ({
      machineTypeName: list[0].machineTypeName,
      gamePrice: list[0].gamePrice,
      machines: list.length,
      games: sumDecimal(list.map((item) => item.games), 4),
      cash: sumDecimal(list.map((item) => item.cash), 2),
      cashless: sumDecimal(list.map((item) => item.cashless), 2),
      revenue: sumDecimal(list.map((item) => item.revenue), 2),
    }))
    .sort(
      (left, right) =>
        left.machineTypeName.localeCompare(right.machineTypeName) ||
        Number(right.gamePrice) - Number(left.gamePrice),
    );
}

async function loadToys(client: Client, range: MonthRange): Promise<OwnerMonthReport['toys']> {
  const result = await client.query(
    `SELECT t.name, td.unit_cost_snapshot AS price,
            SUM(td.quantity)::int AS quantity,
            SUM(td.quantity * td.unit_cost_snapshot) AS amount
     FROM toy_distributions td
     JOIN services s ON s.id = td.service_id
     JOIN toys t ON t.id = td.toy_id
     WHERE s.service_date >= $1::date AND s.service_date <= $2::date
     GROUP BY t.id, t.name, td.unit_cost_snapshot
     ORDER BY t.name, td.unit_cost_snapshot`,
    [range.from, range.to],
  );
  const rows: OwnerMonthToyRow[] = result.rows.map((row) => ({
    toyName: String(row.name),
    price: String(row.price),
    quantity: Number(row.quantity),
    amount: String(row.amount),
  }));
  return {
    rows,
    totalQuantity: rows.reduce((total, row) => total + row.quantity, 0),
    totalAmount: sumDecimal(rows.map((row) => row.amount), 2),
  };
}

const NO_STAFF_LABEL = 'Без привязки к технику';
const NO_COMMENT_LABEL = 'Без комментария';

/**
 * Расходы из business_expenses без «На карту» (это не расход — DECISION-080). Категория, которой
 * нет в таблице соответствия ниже, всё равно попадает в отчёт отдельной строкой со своим ключом.
 */
async function loadExpenseLines(
  client: Client,
  range: MonthRange,
): Promise<{ lines: OwnerMonthExpenseLine[]; cardTotal: string }> {
  const result = await client.query(
    `SELECT e.category, e.amount, e.comment, s.full_name AS staff_name
     FROM business_expenses e
     LEFT JOIN staff s ON s.id = e.staff_id
     WHERE e.expense_date >= $1::date AND e.expense_date <= $2::date
     ORDER BY e.expense_date, e.id`,
    [range.from, range.to],
  );

  const known: Array<{ category: string; key: string; label: string; collapsed: boolean }> = [
    { category: 'SALARY', key: 'salary', label: 'Зарплата', collapsed: false },
    { category: 'FUEL', key: 'fuel', label: 'Бензин', collapsed: false },
    { category: 'OTHER', key: 'other', label: 'Прочие расходы', collapsed: true },
  ];
  const categories = new Set(result.rows.map((row) => String(row.category)));
  for (const category of categories) {
    if (category !== 'CARD' && !known.some((item) => item.category === category)) {
      known.push({ category, key: category.toLowerCase(), label: category, collapsed: false });
    }
  }

  const lines = known.map((definition) => {
    const rows = result.rows.filter((row) => String(row.category) === definition.category);
    const items: OwnerMonthExpenseItem[] = [];
    if (definition.category === 'SALARY') {
      // Зарплата раскладывается по людям: сумма на человека, а не построчно по дням.
      const byPerson = new Map<string, string[]>();
      for (const row of rows) {
        const name = row.staff_name ? String(row.staff_name) : NO_STAFF_LABEL;
        byPerson.set(name, [...(byPerson.get(name) ?? []), String(row.amount)]);
      }
      for (const [label, amounts] of byPerson) items.push({ label, amount: sumDecimal(amounts, 2) });
      items.sort((left, right) => left.label.localeCompare(right.label));
    } else if (definition.category === 'OTHER') {
      for (const row of rows) {
        items.push({ label: String(row.comment || '') || NO_COMMENT_LABEL, amount: String(row.amount) });
      }
    }
    return {
      key: definition.key,
      label: definition.label,
      amount: sumDecimal(rows.map((row) => String(row.amount)), 2),
      items,
      collapsed: definition.collapsed,
    };
  });

  const cardTotal = sumDecimal(
    result.rows.filter((row) => String(row.category) === 'CARD').map((row) => String(row.amount)),
    2,
  );
  return { lines, cardTotal };
}

/**
 * Аренда за месяц и её разбивка на работающие и простаивающие точки. Простой — точка с арендой,
 * на которой не было активного размещения аппарата ни на один день месяца.
 */
async function loadRent(client: Client, range: MonthRange): Promise<OwnerMonthRent> {
  const summary = await rentSummary(client, { from: range.start, to: range.end });

  const occupied = await client.query(
    `SELECT DISTINCT location_id FROM machine_placements
     WHERE tstzrange(started_at, ended_at) && tstzrange($1::timestamptz, $2::timestamptz)`,
    [range.start, range.end],
  );
  const occupiedIds = new Set<number>(occupied.rows.map((row) => Number(row.location_id)));

  const idleLocations: OwnerMonthRentLocation[] = summary.locations
    .filter((location) => !occupiedIds.has(location.locationId))
    .map((location) => ({
      locationId: location.locationId,
      locationName: location.locationName,
      // rentSummary отдаёт пропорцию без округления — до копеек округляем здесь.
      amount: Number(location.proratedCost).toFixed(2),
    }))
    .sort((left, right) => Number(right.amount) - Number(left.amount));
  const idle = sumDecimal(idleLocations.map((location) => location.amount), 2);

  return {
    total: summary.total,
    active: sumDecimal([summary.total, `-${idle}`], 2),
    idle,
    activeLocationsCount: summary.locations.length - idleLocations.length,
    idleLocations,
  };
}

/**
 * Отчёт владельца за календарный месяц — единый расчёт для страницы «Отчёт» и xlsx. Доступ только
 * администратору: расходы бизнеса не привязаны к аппаратам и не сужаются областью видимости.
 */
export async function ownerMonthReport(
  client: Client,
  actor: Actor,
  { year, month }: { year: number; month: number },
): Promise<OwnerMonthReport> {
  assertAdmin(actor);
  const range = monthRange(year, month);

  const machines = await loadMachineMonths(client, actor, range);
  const toys = await loadToys(client, range);
  const { lines: expenseLines, cardTotal } = await loadExpenseLines(client, range);
  const rent = await loadRent(client, range);

  const revenue = sumDecimal(machines.map((machine) => machine.revenue), 2);
  const cash = sumDecimal(machines.map((machine) => machine.cash), 2);
  const cashless = sumDecimal(machines.map((machine) => machine.cashless), 2);

  const spentFromCash = sumDecimal(expenseLines.map((line) => line.amount), 2);
  const lines: OwnerMonthExpenseLine[] = [
    ...expenseLines,
    { key: 'rent', label: 'Аренда точек', amount: rent.total, items: [], collapsed: false },
    { key: 'toys', label: 'Игрушки (себестоимость)', amount: toys.totalAmount, items: [], collapsed: false },
  ];
  const expensesTotal = sumDecimal(lines.map((line) => line.amount), 2);

  return {
    year,
    month,
    revenue,
    cash,
    cashless,
    profit: sumDecimal([revenue, `-${expensesTotal}`], 2),
    machines: {
      total: machines.length,
      withTerminal: machines.filter((machine) => machine.hasTerminal).length,
      withoutTerminal: machines.filter((machine) => !machine.hasTerminal).length,
    },
    groups: buildGroups(machines),
    expenses: { lines, total: expensesTotal },
    cashReport: {
      collected: cash,
      spentFromCash,
      transferredToCard: cardTotal,
      onHand: sumDecimal([cash, `-${spentFromCash}`, `-${cardTotal}`], 2),
      cashless,
      reachedOwner: sumDecimal([cashless, cardTotal], 2),
    },
    rent,
    toys,
    machineRows: machines.map((machine) => ({
      machineNumber: machine.machineNumber,
      address: machine.address,
      machineTypeName: machine.machineTypeName,
      gamePrice: machine.gamePrice,
      hasTerminal: machine.hasTerminal,
      games: machine.games,
      cash: machine.cash,
      cashless: machine.cashless,
      revenue: machine.revenue,
    })),
  };
}
