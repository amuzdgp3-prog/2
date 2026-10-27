import type { Client } from '../db/pool.js';

/**
 * Ежедневная сводка по техникам для владельца в Telegram (DECISION-093).
 *
 * Те же правила отбора, что у отчёта по техникам на сайте (domain/reports.ts → technicianReport):
 * только полевые техники — служебная учётка, под которой залита история, в сводку не попадает;
 * только обычные обслуживания (FINAL при закрытии точки — бухгалтерская запись, не выезд);
 * нал — cash_amount, безнал — cashless_amount. Так цифры в Telegram совпадают с сайтом.
 *
 * Сбор и оформление разделены: formatDailySummary — чистая функция, её формат проверяется
 * тестами без базы.
 */
export interface TechnicianDay {
  name: string;
  machines: number;
  /** Московское время первого и последнего обслуживания, 'HH:MM'. */
  start: string;
  finish: string;
  cash: number;
  cashless: number;
}

export interface DailySummary {
  /** Деловая дата по Москве, 'YYYY-MM-DD'. */
  date: string;
  technicians: TechnicianDay[];
}

export async function loadDailySummary(client: Client, date: string): Promise<DailySummary> {
  const result = await client.query<{
    name: string;
    machines: number;
    start: string;
    finish: string;
    cash: string;
    cashless: string;
  }>(
    `SELECT st.full_name AS name,
            COUNT(*)::int AS machines,
            to_char(MIN(s.occurred_at AT TIME ZONE 'Europe/Moscow'), 'HH24:MI') AS start,
            to_char(MAX(s.occurred_at AT TIME ZONE 'Europe/Moscow'), 'HH24:MI') AS finish,
            SUM(s.cash_amount) AS cash,
            SUM(s.cashless_amount) AS cashless
     FROM services s
     JOIN staff st ON st.id = s.technician_id
     WHERE s.service_date = $1::date
       AND s.kind = 'REGULAR'
       AND st.is_field_technician
     GROUP BY st.id, st.full_name`,
    [date],
  );
  return {
    date,
    technicians: result.rows.map((row) => ({
      name: row.name.trim(),
      machines: row.machines,
      start: row.start,
      finish: row.finish,
      cash: Number(row.cash),
      cashless: Number(row.cashless),
    })),
  };
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** Целые рубли с разделителем тысяч. Копейки в сводке не нужны — точные суммы есть на сайте. */
function rub(amount: number): string {
  const rounded = Math.round(amount);
  const sign = rounded < 0 ? '−' : '';
  return sign + String(Math.abs(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function duration(start: string, finish: string): string {
  const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  const total = Math.max(0, toMinutes(finish) - toMinutes(start));
  return `${Math.floor(total / 60)} ч ${String(total % 60).padStart(2, '0')} мин`;
}

const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

function humanDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${weekday}, ${day} ${MONTHS[month - 1]}`;
}

function money(cash: number, cashless: number): string {
  return `💰 ${rub(cash + cashless)} ₽: нал ${rub(cash)} · безнал ${rub(cashless)}`;
}

/**
 * Обычный текст без разметки Telegram: в именах и адресах бывают символы, которые Markdown
 * съел бы или на которых sendMessage отказал бы целиком.
 */
export function formatDailySummary(summary: DailySummary): string {
  const header = `📋 Итоги дня · ${humanDate(summary.date)}`;
  if (summary.technicians.length === 0) {
    return `${header}\n\nОбслуживаний не было.`;
  }

  // Больше всего сделавший — сверху; при равенстве — кто раньше начал.
  const rows = [...summary.technicians].sort(
    (a, b) => b.machines - a.machines || a.start.localeCompare(b.start),
  );

  const blocks = rows.map((t) =>
    [
      `${t.name} — ${t.machines} ${plural(t.machines, 'аппарат', 'аппарата', 'аппаратов')}`,
      `   ${t.start} → ${t.finish}  (${duration(t.start, t.finish)})`,
      `   ${money(t.cash, t.cashless)}`,
    ].join('\n'),
  );

  const machines = rows.reduce((sum, t) => sum + t.machines, 0);
  const cash = rows.reduce((sum, t) => sum + t.cash, 0);
  const cashless = rows.reduce((sum, t) => sum + t.cashless, 0);
  const total = [
    '━━━━━━━━━━━━━━',
    `Всего: ${rows.length} ${plural(rows.length, 'техник', 'техника', 'техников')} · ` +
      `${machines} ${plural(machines, 'аппарат', 'аппарата', 'аппаратов')}`,
    money(cash, cashless),
  ].join('\n');

  return [header, ...blocks, total].join('\n\n');
}
