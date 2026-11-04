import ExcelJS from 'exceljs';
import type { Client } from '../db/pool.js';
import type { Actor } from '../lib/audit.js';
import { ownerMonthReport, type OwnerMonthReport } from './ownerMonthReport.js';
import { sumDecimal } from './reports.js';
import { groupMonthlyExpenseItems } from './monthlyExpenseItems.js';

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

const LAST_COLUMN = 7;

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
}

/** Расходы: список строк приходит из расчёта целиком, новая статья появляется без правок здесь. */
function writeExpenses(ws: ExcelJS.Worksheet, cursor: Cursor, report: OwnerMonthReport) {
  sectionTitle(ws, cursor, 'РАСХОДЫ');
  const lines = report.expenses.lines.filter((line) => line.key !== 'rent' && line.key !== 'toys');
  for (const line of lines) {
    labelValueRow(ws, cursor, line.label, line.amount);
    const isOther = line.key === 'other';
    const items = isOther ? groupMonthlyExpenseItems(line.items) : line.items;
    for (const item of items) {
      labelValueRow(ws, cursor, item.label, item.amount, { indent: true, level: 1, hidden: isOther ? false : line.collapsed });
      if (isOther) {
        const row = ws.getRow(cursor.row - 1);
        row.getCell(1).alignment = { vertical: 'top', wrapText: true };
        row.getCell(2).alignment = { vertical: 'top' };
        row.height = 15 * Math.max(1, Math.ceil((item.label.length + 4) / 38));
      }
    }
  }
  labelValueRow(ws, cursor, 'Всего расходов', sumDecimal(lines.map((line) => line.amount), 2), { bold: true });
}

function writeCashReport(ws: ExcelJS.Worksheet, cursor: Cursor, report: OwnerMonthReport) {
  const cash = report.cashReport;
  sectionTitle(ws, cursor, 'ОТЧЁТ ПО НАЛИЧКЕ');
  labelValueRow(ws, cursor, 'Собрано наличными', cash.collected);
  labelValueRow(ws, cursor, '− Зарплата, бензин, прочие', cash.spentFromCash);
  labelValueRow(ws, cursor, '− Переведено на карту', cash.transferredToCard);
  labelValueRow(ws, cursor, 'Осталось на руках', cash.onHand, { bold: true });
}

function writeToys(ws: ExcelJS.Worksheet, cursor: Cursor, report: OwnerMonthReport) {
  sectionTitle(ws, cursor, 'ЗАТРАТЫ НА ИГРУШКИ');
  tableHeader(ws, cursor, ['Вид', 'Количество, шт']);
  for (const toy of report.toys.rows) {
    const r = cursor.row;
    dataCell(ws.getCell(r, 1), toy.toyName);
    dataCell(ws.getCell(r, 2), toy.quantity);
    ws.getCell(r, 2).numFmt = INT_FORMAT;
    cursor.row += 1;
  }
  const r = cursor.row;
  labelCell(ws.getCell(r, 1), 'Итого');
  ws.getCell(r, 2).value = report.toys.totalQuantity;
  ws.getCell(r, 2).numFmt = INT_FORMAT;
  ws.getCell(r, 2).font = { bold: true };
  cursor.row += 1;
}

const RATIO_FORMAT = '0.00';

function writeMachineRows(ws: ExcelJS.Worksheet, cursor: Cursor, report: OwnerMonthReport) {
  sectionTitle(ws, cursor, 'ДЕТАЛИЗАЦИЯ ПО АППАРАТАМ');
  tableHeader(ws, cursor, ['Аппарат', 'Тип', 'Игр', 'Наличные, ₽', 'Безнал, ₽', 'Выручка, ₽', 'ROI (3 обсл.)']);
  for (const machine of report.machineRows) {
    const r = cursor.row;
    dataCell(ws.getCell(r, 1), `${machine.machineNumber}: ${machine.address}`);
    dataCell(ws.getCell(r, 2), machine.machineTypeName);
    dataCell(ws.getCell(r, 3), Number(machine.games));
    ws.getCell(r, 3).numFmt = INT_FORMAT;
    moneyCell(ws.getCell(r, 4), machine.cash);
    moneyCell(ws.getCell(r, 5), machine.cashless);
    moneyCell(ws.getCell(r, 6), machine.revenue);
    dataCell(ws.getCell(r, 7), machine.roi3 === null ? 'нет данных' : Number(machine.roi3));
    if (machine.roi3 !== null) ws.getCell(r, 7).numFmt = RATIO_FORMAT;
    cursor.row += 1;
  }
  const r = cursor.row;
  labelCell(ws.getCell(r, 1), 'Итого');
  moneyCell(ws.getCell(r, 4), report.cash, true);
  moneyCell(ws.getCell(r, 5), report.cashless, true);
  moneyCell(ws.getCell(r, 6), report.revenue, true);
  cursor.row += 1;
}

/**
 * Ежемесячный xlsx-отчёт. Содержит сокращённую сводку и детализацию по аппаратам. Строится из того же
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
  writeExpenses(ws, cursor, report);
  writeCashReport(ws, cursor, report);
  writeToys(ws, cursor, report);
  writeMachineRows(ws, cursor, report);

  return workbook;
}
