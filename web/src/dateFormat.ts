/** Display only: API values and native date/datetime inputs keep their ISO contracts. */
type DateValue = string | number | Date | null | undefined;

const dateFormatter = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit', month: '2-digit', year: '2-digit',
});
const timeFormatter = new Intl.DateTimeFormat('ru-RU', {
  hour: '2-digit', minute: '2-digit', hour12: false,
});

function parsed(value: DateValue): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDate(value: DateValue): string {
  // A business calendar date must not shift when the device is west of UTC.
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-');
    return `${day}.${month}.${year.slice(-2)}`;
  }
  const date = parsed(value);
  return date ? dateFormatter.format(date) : '—';
}

export function formatTime(value: DateValue): string {
  const date = parsed(value);
  return date ? timeFormatter.format(date) : '—';
}

export function formatDateTime(value: DateValue): string {
  const date = parsed(value);
  return date ? `${formatDate(date)} ${formatTime(date)}` : '—';
}
