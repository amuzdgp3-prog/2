import ExcelJS from 'exceljs';
import type { Client } from '../db/pool.js';
import type { Actor } from '../lib/audit.js';
import { ownerMonthReport, type OwnerMonthReport } from './ownerMonthReport.js';
import { adviceText } from './clawAdvice.js';

const MONTH_NAMES = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

const MONEY_FORMAT = '#,##0 "₽"';
const INT_FORMAT = '#,##0';

const TITLE_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8A9A9' } };
const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF5B8DEF' } };
const THIN_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: 'FFCCCCCC' } },
  left: { style: 'thin', color: { argb: 'FFCCCCCC' } },
  bottom: { style: 'thin', color: { argb: 'FFCCCCCC' } },
  right: { style: 'thin', color: { argb: 'FFCCCCCC' } },
};

function titleCell(cell: ExcelJS.Cell, value: string) {
  cell.value = value;
  cell.font = { bold: true, size: 13 };
  cell.fill = TITLE_FILL;
  cell.alignment = { horizontal: 'center', vertical: 'middle' };
}

function headerCell(cell: ExcelJS.Cell, value: string) {
  cell.value = value;
  cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  cell.fill = HEADER_FILL;
  cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  cell.border = THIN_BORDER;
}

function labelCell(cell: ExcelJS.Cell, value: string) {
  cell.value = value;
  cell.font = { bold: true };
}

function moneyCell(cell: ExcelJS.Cell, value: string | number, bold = false) {
  cell.value = Number(value);
  cell.numFmt = MONEY_FORMAT;
  if (bold) cell.font = { bold: true };
}

function dataCell(cell: ExcelJS.Cell, value: string | number | Date) {
  cell.value = value;
  cell.border = THIN_BORDER;
}

/** Курсор записи: номер следующей свободной строки листа. */
interface Cursor {
  row: number;
}

const LAST_COLUMN = 9;

function sectionTitle(ws: ExcelJS.Worksheet, cursor: Cursor, text: string) {
  cursor.row += 1;
  ws.mergeCells(cursor.row, 1, cursor.row, LAST_COLUMN);
  titleCell(ws.getCell(cursor.row, 1), text);
  cursor.row += 1;
}

/** Строка «подпись — значение», показатели столбцом, а не растянутые в одну строку. */
function labelValueRow(
  ws: ExcelJS.Worksheet,
  cursor: Cursor,
  label: string,
  value: string | number,
  options: { money?: boolean; bold?: boolean; indent?: boolean; level?: number; hidden?: boolean } = {},
) {
  const row = ws.getRow(cursor.row);
  const labelCellRef = row.getCell(1);
  labelCellRef.value = options.indent ? `    ${label}` : label;
  if (options.bold) labelCellRef.font = { bold: true };
  const valueCell = row.getCell(2);
  if (options.money === false) {
    valueCell.value = value;
    valueCell.numFmt = INT_FORMAT;
  } else {
    moneyCell(valueCell, value, options.bold);
  }
  if (options.level) row.outlineLevel = options.level;
  if (options.hidden) row.hidden = true;
  cursor.row += 1;
}

function tableHeader(ws: ExcelJS.Worksheet, cursor: Cursor, headers: string[]) {
  headers.forEach((text, i) => headerCell(ws.getCell(cursor.row, 1 + i), text));
  cursor.row += 1;
}

function writeSummary(ws: ExcelJS.Worksheet, cursor: Cursor, report: OwnerMonthReport) {
  sectionTitle(ws, cursor, 'ВЫРУЧКА И ПРИБЫЛЬ');
  labelValueRow(ws, cursor, 'Общая выручка', report.revenue, { bold: true });
  labelValueRow(ws, cursor, 'Наличные', report.cash);
  labelValueRow(ws, cursor, 'Безнал', report.cashless);
  labelValueRow(ws, cursor, 'Прибыль за вычетом расходов', report.profit, { bold: true });
}

function writeMachineCounts(ws: ExcelJS.Worksheet, cursor: Cursor, report: OwnerMonthReport) {
  sectionTitle(ws, cursor, 'АППАРАТЫ И ТЕРМИНАЛЫ');
  labelValueRow(ws, cursor, 'Аппаратов в отчёте', report.machines.total, { money: false });
  labelValueRow(ws, cursor, 'С терминалом', report.machines.withTerminal, { money: false });
  labelValueRow(ws, cursor, 'Без терминала', report.machines.withoutTerminal, { money: false });
}

function writeGroups(ws: ExcelJS.Worksheet, cursor: Cursor, report: OwnerMonthReport) {
  sectionTitle(ws, cursor, 'АППАРАТЫ ПО ТИПАМ И ЦЕНЕ ИГРЫ');
  tableHeader(ws, cursor, ['Тип', 'Цена игры, ₽', 'Аппаратов', 'Игр', 'Наличные, ₽', 'Безнал, ₽', 'Выручка, ₽']);
  for (const group of report.groups) {
    const r = cursor.row;
    dataCell(ws.getCell(r, 1), group.machineTypeName);
    dataCell(ws.getCell(r, 2), Number(group.gamePrice));
    dataCell(ws.getCell(r, 3), group.machines);
    dataCell(ws.getCell(r, 4), Number(group.games));
    ws.getCell(r, 4).numFmt = INT_FORMAT;
    moneyCell(ws.getCell(r, 5), group.cash);
    moneyCell(ws.getCell(r, 6), group.cashless);
    moneyCell(ws.getCell(r, 7), group.revenue);
    cursor.row += 1;
  }
  const r = cursor.row;
  labelCell(ws.getCell(r, 1), 'Итого');
  ws.getCell(r, 3).value = report.machines.total;
  ws.getCell(r, 3).font = { bold: true };
  moneyCell(ws.getCell(r, 5), report.cash, true);
  moneyCell(ws.getCell(r, 6), report.cashless, true);
  moneyCell(ws.getCell(r, 7), report.revenue, true);
  cursor.row += 1;
}

/** Расходы: список строк приходит из расчёта целиком, новая статья появляется без правок здесь. */
function writeExpenses(ws: ExcelJS.Worksheet, cursor: Cursor, report: OwnerMonthReport) {
  sectionTitle(ws, cursor, 'РАСХОДЫ');
  for (const line of report.expenses.lines) {
    labelValueRow(ws, cursor, line.label, line.amount);
    // Свёрнутая на странице строка сворачивается и в файле (группировка строк Excel).
    for (const item of line.items) {
      labelValueRow(ws, cursor, item.label, item.amount, { indent: true, level: 1, hidden: line.collapsed });
    }
  }
  labelValueRow(ws, cursor, 'Всего расходов', report.expenses.total, { bold: true });
}

function writeCashReport(ws: ExcelJS.Worksheet, cursor: Cursor, report: OwnerMonthReport) {
  const cash = report.cashReport;
  sectionTitle(ws, cursor, 'ОТЧЁТ ПО НАЛИЧКЕ');
  labelValueRow(ws, cursor, 'Собрано наличными', cash.collected);
  labelValueRow(ws, cursor, '− Зарплата, бензин, прочие', cash.spentFromCash);
  labelValueRow(ws, cursor, '− Переведено на карту', cash.transferredToCard);
  labelValueRow(ws, cursor, 'Осталось на руках', cash.onHand, { bold: true });
  labelValueRow(ws, cursor, 'Безнал', cash.cashless);
  labelValueRow(ws, cursor, 'На карту', cash.transferredToCard);
  labelValueRow(ws, cursor, 'Дошло до владельца', cash.reachedOwner, { bold: true });
}

function writeRent(ws: ExcelJS.Worksheet, cursor: Cursor, report: OwnerMonthReport) {
  const rent = report.rent;
  sectionTitle(ws, cursor, 'АРЕНДА');
  labelValueRow(ws, cursor, 'Всего в месяц', rent.total, { bold: true });
  labelValueRow(ws, cursor, `Работают, точек: ${rent.activeLocationsCount}`, rent.active);
  labelValueRow(ws, cursor, `Простой, без аппарата, точек: ${rent.idleLocations.length}`, rent.idle);
  for (const location of rent.idleLocations) {
    labelValueRow(ws, cursor, location.locationName, location.amount, { indent: true, level: 1 });
  }
}

function writeToys(ws: ExcelJS.Worksheet, cursor: Cursor, report: OwnerMonthReport) {
  sectionTitle(ws, cursor, 'ЗАТРАТЫ НА ИГРУШКИ');
  tableHeader(ws, cursor, ['Вид', 'Цена, ₽', 'Количество, шт', 'Сумма, ₽']);
  for (const toy of report.toys.rows) {
    const r = cursor.row;
    dataCell(ws.getCell(r, 1), toy.toyName);
    moneyCell(ws.getCell(r, 2), toy.price);
    dataCell(ws.getCell(r, 3), toy.quantity);
    moneyCell(ws.getCell(r, 4), toy.amount);
    cursor.row += 1;
  }
  const r = cursor.row;
  labelCell(ws.getCell(r, 1), 'Итого');
  ws.getCell(r, 3).value = report.toys.totalQuantity;
  ws.getCell(r, 3).font = { bold: true };
  moneyCell(ws.getCell(r, 4), report.toys.totalAmount, true);
  cursor.row += 1;
}

const PERCENT_FORMAT = '0.0"%"';

function percentCell(cell: ExcelJS.Cell, value: number | null) {
  cell.value = value === null ? '—' : Math.round(value * 10) / 10;
  if (value !== null) cell.numFmt = PERCENT_FORMAT;
  cell.border = THIN_BORDER;
}

/** Отдача и настройки клешни (DECISION-090) — тот же раздел, что на странице отчёта. */
function writePayout(ws: ExcelJS.Worksheet, cursor: Cursor, report: OwnerMonthReport) {
  const payout = report.payout;
  if (payout.types.length === 0) return;
  sectionTitle(ws, cursor, 'ОТДАЧА И НАСТРОЙКИ КЛЕШНИ');
  tableHeader(ws, cursor, [
    'Тип', 'Цель, %', 'Норма, %', 'Отдача за месяц, %', 'Прошлый месяц, %',
    'Мало / норма / много / рано', 'После игрушек, ₽/сут на аппарат', 'Прошлый месяц, ₽/сут',
  ]);
  for (const type of payout.types) {
    const r = cursor.row;
    dataCell(ws.getCell(r, 1), type.machineTypeName);
    percentCell(ws.getCell(r, 2), type.target);
    dataCell(ws.getCell(r, 3), `${String(type.low).replace('.', ',')}–${String(type.high).replace('.', ',')}`);
    percentCell(ws.getCell(r, 4), type.payoutPercent);
    percentCell(ws.getCell(r, 5), type.payoutPercentPrev);
    dataCell(ws.getCell(r, 6), `${type.lowCount} / ${type.okCount} / ${type.highCount} / ${type.earlyCount}`);
    moneyCell(ws.getCell(r, 7), type.netPerDay ?? 0);
    moneyCell(ws.getCell(r, 8), type.netPerDayPrev ?? 0);
    cursor.row += 1;
  }

  cursor.row += 1;
  labelValueRow(ws, cursor, 'Изменений Weak за месяц', payout.changes.total, { money: false, bold: true });
  labelValueRow(ws, cursor, 'По совету', payout.changes.follow, { money: false });
  labelValueRow(ws, cursor, 'Без совета', payout.changes.free, { money: false });
  labelValueRow(ws, cursor, 'Против совета', payout.changes.against, { money: false });
  labelValueRow(ws, cursor, 'Совет висит, настройку не меняли — аппаратов', payout.changes.pendingAdvice, { money: false });

  cursor.row += 1;
  tableHeader(ws, cursor, ['Шаг', 'Изменений', 'Прошло 14 дней', 'Игр в сутки, п.п. к фону типа', 'После игрушек, %']);
  for (const effect of payout.changes.effects) {
    const r = cursor.row;
    dataCell(ws.getCell(r, 1), effect.direction === 'raise' ? 'Weak прибавили' : 'Weak убавили');
    dataCell(ws.getCell(r, 2), effect.count);
    dataCell(ws.getCell(r, 3), effect.complete);
    percentCell(ws.getCell(r, 4), effect.paceAdjustedPercent);
    percentCell(ws.getCell(r, 5), effect.netChangePercent);
    cursor.row += 1;
  }

  if (payout.attention.length) {
    cursor.row += 1;
    tableHeader(ws, cursor, ['Требуют внимания', 'Тип', 'Отдача, %', 'Цель, %', 'Игр с изменения', 'Совет']);
    for (const item of payout.attention) {
      const r = cursor.row;
      dataCell(ws.getCell(r, 1), `${item.machineNumber}: ${item.address}`);
      dataCell(ws.getCell(r, 2), item.machineTypeName);
      percentCell(ws.getCell(r, 3), item.payoutPercent);
      percentCell(ws.getCell(r, 4), item.target);
      dataCell(ws.getCell(r, 5), Math.round(item.games));
      dataCell(ws.getCell(r, 6), adviceText(item.advice));
      cursor.row += 1;
    }
  }
}

const RATIO_FORMAT = '0.00';

function writeMachineRows(ws: ExcelJS.Worksheet, cursor: Cursor, report: OwnerMonthReport) {
  sectionTitle(ws, cursor, 'ДЕТАЛИЗАЦИЯ ПО АППАРАТАМ');
  tableHeader(ws, cursor, ['Аппарат', 'Тип', 'Цена игры, ₽', 'Терминал', 'Игр', 'Наличные, ₽', 'Безнал, ₽', 'Выручка, ₽', 'ROI (3 обсл.)']);
  for (const machine of report.machineRows) {
    const r = cursor.row;
    dataCell(ws.getCell(r, 1), `${machine.machineNumber}: ${machine.address}`);
    dataCell(ws.getCell(r, 2), machine.machineTypeName);
    dataCell(ws.getCell(r, 3), Number(machine.gamePrice));
    dataCell(ws.getCell(r, 4), machine.hasTerminal ? 'есть' : 'нет');
    dataCell(ws.getCell(r, 5), Number(machine.games));
    ws.getCell(r, 5).numFmt = INT_FORMAT;
    moneyCell(ws.getCell(r, 6), machine.cash);
    moneyCell(ws.getCell(r, 7), machine.cashless);
    moneyCell(ws.getCell(r, 8), machine.revenue);
    dataCell(ws.getCell(r, 9), machine.roi3 === null ? 'нет данных' : Number(machine.roi3));
    if (machine.roi3 !== null) ws.getCell(r, 9).numFmt = RATIO_FORMAT;
    cursor.row += 1;
  }
  const r = cursor.row;
  labelCell(ws.getCell(r, 1), 'Итого');
  moneyCell(ws.getCell(r, 6), report.cash, true);
  moneyCell(ws.getCell(r, 7), report.cashless, true);
  moneyCell(ws.getCell(r, 8), report.revenue, true);
  cursor.row += 1;
}

/**
 * Ежемесячный xlsx-отчёт. Повторяет страницу «Отчёт» владельца блок в блок и строится из того же
 * расчёта `ownerMonthReport`, поэтому цифры в файле и на экране не могут разойтись. Сводка сверху,
 * детализация по аппаратам в конце.
 */
export async function buildMonthlyReportWorkbook(
  client: Client,
  actor: Actor,
  { year, month }: { year: number; month: number },
): Promise<ExcelJS.Workbook> {
  const report = await ownerMonthReport(client, actor, { year, month });

  const workbook = new ExcelJS.Workbook();
  const monthName = MONTH_NAMES[month - 1];
  const ws = workbook.addWorksheet(monthName, { properties: { defaultColWidth: 16 } });
  ws.getColumn(1).width = 44;
  for (let column = 2; column <= LAST_COLUMN; column += 1) ws.getColumn(column).width = 18;
  // Кнопка раскрытия группы стоит над сгруппированными строками.
  ws.properties.outlineProperties = { summaryBelow: false, summaryRight: true };

  ws.mergeCells(1, 1, 1, LAST_COLUMN);
  titleCell(ws.getCell(1, 1), `ОТЧЁТ ЗА ${monthName.toUpperCase()} ${year}`);
  labelCell(ws.getCell(2, 1), 'Сформировано:');
  ws.getCell(2, 2).value = new Date();
  ws.getCell(2, 2).numFmt = 'dd/mm/yyyy hh:mm';

  const cursor: Cursor = { row: 3 };
  writeSummary(ws, cursor, report);
  writeMachineCounts(ws, cursor, report);
  writeGroups(ws, cursor, report);
  writeExpenses(ws, cursor, report);
  writeCashReport(ws, cursor, report);
  writeRent(ws, cursor, report);
  writeToys(ws, cursor, report);
  writePayout(ws, cursor, report);
  writeMachineRows(ws, cursor, report);

  return workbook;
}
