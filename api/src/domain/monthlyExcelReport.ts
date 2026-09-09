import ExcelJS from 'exceljs';
import type { Client } from '../db/pool.js';
import type { Actor } from '../lib/audit.js';
import { expensesSummary } from './reports.js';
import { queryMachineRows, sumDecimal } from './reports.js';
import { toyMonthlyTrend } from './toyAnalysis.js';

const MONTH_NAMES = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

const CATEGORY_LABELS: Record<string, string> = {
  FUEL: 'Бензин',
  SALARY: 'Аванс / ЗП',
  CARD: 'На карту',
  OTHER: 'Прочие расходы',
};

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

/**
 * Собирает тот же ежемесячный xlsx-отчёт, формат которого был вручную согласован с владельцем в
 * рабочей сессии (шапка тремя колонками — Финансы / Расход на игрушки / Прогноз на след. месяц;
 * детализация по аппаратам; раздел «РАСХОДЫ» по категориям) — но теперь из реальных данных БД, а
 * не разовым Python-скриптом. Прогноз игрушек берётся из уже существующего toyMonthlyTrend
 * (DECISION-031), а не пересчитывается заново наивной эвристикой.
 */
export async function buildMonthlyReportWorkbook(
  client: Client,
  actor: Actor,
  { year, month }: { year: number; month: number },
): Promise<ExcelJS.Workbook> {
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const toDate = new Date(Date.UTC(year, month, 0));
  const to = toDate.toISOString().slice(0, 10);

  const machineRows = await queryMachineRows(client, actor, { from, to, limit: 2000 });
  const machineNumbers = machineRows.map((row) => row.machineNumber);

  const toyRows = machineNumbers.length
    ? await client.query(
        `SELECT s.machine_number, t.id AS toy_id, t.name,
                SUM(td.quantity)::int AS quantity,
                SUM(td.quantity * td.unit_cost_snapshot) AS cost
         FROM toy_distributions td
         JOIN services s ON s.id = td.service_id
         JOIN toys t ON t.id = td.toy_id
         WHERE s.machine_number = ANY($1::text[])
           AND s.service_date >= $2::date AND s.service_date <= $3::date
         GROUP BY s.machine_number, t.id, t.name`,
        [machineNumbers, from, to],
      )
    : { rows: [] as Array<Record<string, unknown>> };

  const counterRows = machineNumbers.length
    ? await client.query(
        `SELECT DISTINCT ON (s.machine_number) s.machine_number, s.game_counter, s.test_games
         FROM services s
         WHERE s.machine_number = ANY($1::text[])
           AND s.service_date >= $2::date AND s.service_date <= $3::date
         ORDER BY s.machine_number, s.occurred_at DESC`,
        [machineNumbers, from, to],
      )
    : { rows: [] as Array<Record<string, unknown>> };
  const currentCounterByMachine = new Map<string, number>(
    counterRows.rows.map((row) => [String(row.machine_number), Number(row.game_counter)]),
  );

  const toys = await client.query('SELECT id, name FROM toys ORDER BY id');
  const toyList = toys.rows.map((row) => ({ id: Number(row.id), name: String(row.name) }));

  const toyQuantityByMachine = new Map<string, Map<number, number>>();
  const toyCostTotalByToy = new Map<number, { quantity: number; cost: number }>();
  for (const row of toyRows.rows) {
    const machineNumber = String(row.machine_number);
    const toyId = Number(row.toy_id);
    const quantity = Number(row.quantity);
    const cost = Number(row.cost);
    if (!toyQuantityByMachine.has(machineNumber)) toyQuantityByMachine.set(machineNumber, new Map());
    toyQuantityByMachine.get(machineNumber)!.set(toyId, quantity);
    const totalEntry = toyCostTotalByToy.get(toyId) ?? { quantity: 0, cost: 0 };
    totalEntry.quantity += quantity;
    totalEntry.cost += cost;
    toyCostTotalByToy.set(toyId, totalEntry);
  }

  const totalRevenue = sumDecimal(machineRows.map((row) => row.revenue), 2);
  const totalCash = sumDecimal(machineRows.map((row) => row.cash), 2);
  const totalCashless = sumDecimal(machineRows.map((row) => row.cashless), 2);
  const totalNewGames = sumDecimal(machineRows.map((row) => row.newGames), 4);
  const totalToyCost = sumDecimal(machineRows.map((row) => row.toyCost), 2);
  const totalToyQuantity = [...toyCostTotalByToy.values()].reduce((sum, t) => sum + t.quantity, 0);

  const forecast = await toyMonthlyTrend(client, actor, 3);
  const expenses = await expensesSummary(client, { from, to });

  const workbook = new ExcelJS.Workbook();
  const monthName = MONTH_NAMES[month - 1];
  const ws = workbook.addWorksheet(monthName, { properties: { defaultColWidth: 16 } });
  ws.getColumn('A').width = 42;
  ws.getColumn('B').width = 18;
  ws.getColumn('C').width = 18;
  ws.getColumn('D').width = 18;
  ws.getColumn('E').width = 18;
  ws.getColumn('F').width = 18;
  ws.getColumn('G').width = 18;

  ws.mergeCells('A1:I1');
  titleCell(ws.getCell('A1'), `ОБЩЕЕ ЗА ${monthName.toUpperCase()} ${year}`);

  labelCell(ws.getCell('A2'), 'Период с:');
  ws.getCell('B2').value = new Date(from);
  ws.getCell('B2').numFmt = 'dd/mm/yyyy';
  labelCell(ws.getCell('A3'), 'по:');
  ws.getCell('B3').value = new Date(to);
  ws.getCell('B3').numFmt = 'dd/mm/yyyy';
  labelCell(ws.getCell('A4'), 'Сформировано:');
  ws.getCell('B4').value = new Date();
  ws.getCell('B4').numFmt = 'dd/mm/yyyy hh:mm';

  ws.mergeCells('D5:F5');
  titleCell(ws.getCell('D5'), 'РАСХОД НА ИГРУШКИ');
  ws.mergeCells('H5:J5');
  titleCell(ws.getCell('H5'), 'ПРОГНОЗ НА СЛЕДУЮЩИЙ МЕСЯЦ');

  labelCell(ws.getCell('A6'), 'НОВЫЕ ИГРЫ:');
  ws.getCell('B6').value = Number(totalNewGames);
  ws.getCell('B6').numFmt = INT_FORMAT;
  headerCell(ws.getCell('D6'), 'Тип');
  headerCell(ws.getCell('E6'), 'Кол-во, шт');
  headerCell(ws.getCell('F6'), 'Сумма, ₽');
  headerCell(ws.getCell('H6'), 'Тип');
  headerCell(ws.getCell('I6'), 'Кол-во, шт');

  labelCell(ws.getCell('A7'), 'ВЫРУЧКА:');
  moneyCell(ws.getCell('B7'), totalRevenue, true);
  labelCell(ws.getCell('A8'), 'НАЛ:');
  moneyCell(ws.getCell('B8'), totalCash);
  labelCell(ws.getCell('A9'), 'БЕЗНАЛ:');
  moneyCell(ws.getCell('B9'), totalCashless);

  let toyRow = 7;
  for (const toy of toyList) {
    const totals = toyCostTotalByToy.get(toy.id) ?? { quantity: 0, cost: 0 };
    dataCell(ws.getCell(`D${toyRow}`), toy.name);
    dataCell(ws.getCell(`E${toyRow}`), totals.quantity);
    moneyCell(ws.getCell(`F${toyRow}`), totals.cost);

    const forecastRow = forecast.find((f) => f.toyId === toy.id);
    dataCell(ws.getCell(`H${toyRow}`), toy.name);
    dataCell(ws.getCell(`I${toyRow}`), forecastRow?.forecastNextMonth.quantity ?? 0);
    toyRow += 1;
  }
  labelCell(ws.getCell(`D${toyRow}`), 'Всего:');
  ws.getCell(`E${toyRow}`).value = totalToyQuantity;
  moneyCell(ws.getCell(`F${toyRow}`), totalToyCost, true);
  const toyBlockEnd = toyRow;

  const detailTitleRow = Math.max(11, toyBlockEnd + 2);
  labelCell(ws.getCell(`A${detailTitleRow}`), 'ДЕТАЛИЗАЦИЯ ПО АППАРАТАМ');
  ws.getRow(detailTitleRow).font = { bold: true, size: 12 };

  const headerRow = detailTitleRow + 1;
  const startRow = headerRow + 1;
  const baseHeaders = ['Аппарат', 'Текущий счётчик игр', 'Новые игры за период', 'Выручка, ₽', 'Нал, ₽', 'Безнал, ₽', 'Сумма за игрушки, ₽'];
  baseHeaders.forEach((text, i) => headerCell(ws.getCell(headerRow, 1 + i), text));
  toyList.forEach((toy, i) => headerCell(ws.getCell(headerRow, baseHeaders.length + 1 + i), `${toy.name}, шт`));
  ws.getRow(headerRow).height = 30;

  const sortedMachines = [...machineRows].sort((a, b) => Number(b.revenue) - Number(a.revenue));
  sortedMachines.forEach((row, i) => {
    const r = startRow + i;
    dataCell(ws.getCell(r, 1), `${row.machineNumber}: ${row.locationName}`);
    dataCell(ws.getCell(r, 2), currentCounterByMachine.get(row.machineNumber) ?? 0);
    dataCell(ws.getCell(r, 3), Number(row.newGames));
    ws.getCell(r, 3).numFmt = INT_FORMAT;
    moneyCell(ws.getCell(r, 4), row.revenue);
    moneyCell(ws.getCell(r, 5), row.cash);
    moneyCell(ws.getCell(r, 6), row.cashless);
    moneyCell(ws.getCell(r, 7), row.toyCost);
    const quantities = toyQuantityByMachine.get(row.machineNumber);
    toyList.forEach((toy, ti) => {
      dataCell(ws.getCell(r, baseHeaders.length + 1 + ti), quantities?.get(toy.id) ?? 0);
    });
  });
  const lastMachineRow = startRow + sortedMachines.length - 1;

  const expTitleRow = lastMachineRow + 3;
  ws.mergeCells(`A${expTitleRow}:J${expTitleRow}`);
  titleCell(ws.getCell(`A${expTitleRow}`), 'РАСХОДЫ');

  const blockHeaderRow = expTitleRow + 1;
  const colHeaderRow = blockHeaderRow + 1;
  const expStartRow = colHeaderRow + 1;

  const blockColumns = ['A', 'D', 'G', 'J'];
  let maxBlockRows = 0;
  expenses.byCategory.forEach((bucket, i) => {
    const startCol = blockColumns[i] ?? blockColumns[blockColumns.length - 1];
    const endColIndex = ws.getColumn(startCol).number + 2;
    const endCol = ws.getColumn(endColIndex).letter;
    ws.mergeCells(`${startCol}${blockHeaderRow}:${endCol}${blockHeaderRow}`);
    headerCell(ws.getCell(`${startCol}${blockHeaderRow}`), CATEGORY_LABELS[bucket.category] ?? bucket.category);

    const dateCol = startCol;
    const amountCol = ws.getColumn(ws.getColumn(startCol).number + 1).letter;
    const commentCol = ws.getColumn(ws.getColumn(startCol).number + 2).letter;
    headerCell(ws.getCell(`${dateCol}${colHeaderRow}`), 'Дата');
    headerCell(ws.getCell(`${amountCol}${colHeaderRow}`), 'Сумма, ₽');
    headerCell(ws.getCell(`${commentCol}${colHeaderRow}`), 'Комментарий');

    bucket.rows.forEach((row, ri) => {
      const r = expStartRow + ri;
      dataCell(ws.getCell(`${dateCol}${r}`), new Date(row.expenseDate));
      ws.getCell(`${dateCol}${r}`).numFmt = 'dd/mm/yyyy';
      moneyCell(ws.getCell(`${amountCol}${r}`), row.amount);
      dataCell(ws.getCell(`${commentCol}${r}`), row.comment);
    });
    const totalRow = expStartRow + bucket.rows.length;
    labelCell(ws.getCell(`${dateCol}${totalRow}`), 'Итого:');
    moneyCell(ws.getCell(`${amountCol}${totalRow}`), bucket.total, true);
    maxBlockRows = Math.max(maxBlockRows, bucket.rows.length + 1);
  });

  const grandTotalRow = expStartRow + maxBlockRows + 1;
  labelCell(ws.getCell(`A${grandTotalRow}`), 'ВСЕГО РАСХОДОВ:');
  moneyCell(ws.getCell(`B${grandTotalRow}`), expenses.total, true);

  return workbook;
}
