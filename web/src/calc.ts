/**
 * Client-side reference calculation. It mirrors the server chain exactly, but its result is only
 * a preview for the technician: the value stored in the database is always the one the server
 * computes (10_ТЗ §9, §22.2 + DECISION-001 counter divisor).
 */
const DIVISOR_SCALE = 100n;
const GAMES_SCALE = 10_000n;

export function normalizeDivisor(input: unknown): number {
  const value = Number(input);
  if (!Number.isFinite(value) || value <= 0) return 1;
  return value;
}

function formatScaled(scaled: bigint, scale: bigint, decimals: number): string {
  const negative = scaled < 0n;
  const absolute = negative ? -scaled : scaled;
  const whole = absolute / scale;
  const fraction = (absolute % scale).toString().padStart(decimals, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/** growth / divisor - testGames, kept at 4 decimals like the stored NUMERIC(14,4). */
export function calcNewGames(growth: number, divisorInput: unknown, testGames: number): string {
  const divisor = BigInt(Math.round(normalizeDivisor(divisorInput) * Number(DIVISOR_SCALE)));
  const numerator = BigInt(Math.trunc(growth)) * DIVISOR_SCALE * GAMES_SCALE;

  let quotient = numerator / divisor;
  const remainder = numerator % divisor;
  if (remainder !== 0n) {
    const doubled = 2n * (remainder < 0n ? -remainder : remainder);
    if (doubled >= divisor) quotient += numerator < 0n ? -1n : 1n;
  }

  return formatScaled(quotient - BigInt(Math.trunc(testGames)) * GAMES_SCALE, GAMES_SCALE, 4);
}

export function calcRevenue(newGames: string, pricePerGame: string | number): string {
  const games = BigInt(Math.round(Number(newGames) * Number(GAMES_SCALE)));
  const price = BigInt(Math.round(Number(pricePerGame) * 100));
  const product = games * price;
  let quotient = product / GAMES_SCALE;
  const remainder = product % GAMES_SCALE;
  if (remainder !== 0n && 2n * (remainder < 0n ? -remainder : remainder) >= GAMES_SCALE) {
    quotient += product < 0n ? -1n : 1n;
  }
  return formatScaled(quotient, 100n, 2);
}

export function formatMoney(value: string | number): string {
  return Number(value).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Trims the stored 4-decimal games value down to what a human wants to read. */
export function formatGames(value: string | number): string {
  const numeric = Number(value);
  return Number.isInteger(numeric)
    ? numeric.toLocaleString('ru-RU')
    : numeric.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

export function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

export interface OverdueInfo {
  isOverdue: boolean;
  daysSinceService: number | null;
  daysOverdue: number | null;
  /** Насколько просрочено — только сигнал срочности, не ROI и не рабочий статус аппарата. */
  severity: 'warn' | 'bad' | null;
}

/**
 * «Забытый» аппарат: последнее обслуживание старше max_service_days. Тяжесть просрочки —
 * warn пока превышение небольшое (≤ 2 дня либо ≤ 20% от максимума), иначе bad. Порог не задан
 * нормативными документами — выбран как разумное значение по умолчанию (см. DECISIONS.md).
 */
export function computeOverdue(machine: {
  last_service_at: string | null;
  max_service_days: number | null;
}): OverdueInfo {
  const days = daysSince(machine.last_service_at);
  if (days === null || machine.max_service_days === null) {
    return { isOverdue: false, daysSinceService: days, daysOverdue: null, severity: null };
  }

  const overdueBy = days - machine.max_service_days;
  if (overdueBy <= 0) {
    return { isOverdue: false, daysSinceService: days, daysOverdue: null, severity: null };
  }

  const mildThreshold = Math.max(2, Math.round(machine.max_service_days * 0.2));
  return {
    isOverdue: true,
    daysSinceService: days,
    daysOverdue: overdueBy,
    severity: overdueBy <= mildThreshold ? 'warn' : 'bad',
  };
}
