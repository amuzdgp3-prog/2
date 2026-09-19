/**
 * Контракт отчёта владельца за календарный месяц (страница «Отчёт» и ежемесячный xlsx строятся из
 * одного и того же объекта, чтобы экран и файл не расходились).
 *
 * Деньги — строки с двумя знаками (как в остальных отчётах), проценты и доли клиент считает сам.
 * Зеркало серверных типов из api/src/domain/ownerMonthReport.ts — при правке менять оба файла.
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
