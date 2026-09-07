/**
 * Reference calculation shared with the PWA. The server chain in counterChain.ts stays the only
 * source of truth for stored values; this function produces the same numbers for client-side
 * previews and technician warnings, using exact integer math instead of floats.
 *
 * Scale: divisor has 2 decimals, new games are kept at 4 decimals like NUMERIC(14,4).
 */
const DIVISOR_SCALE = 100n;
const GAMES_SCALE = 10_000n;

export function normalizeDivisor(input: unknown): number {
  const value = typeof input === 'string' ? Number(input) : (input as number);
  if (!Number.isFinite(value) || value <= 0) return 1;
  return value;
}

function toScaledDivisor(divisor: number): bigint {
  const scaled = BigInt(Math.round(divisor * Number(DIVISOR_SCALE)));
  return scaled > 0n ? scaled : DIVISOR_SCALE;
}

/** Returns new games as a decimal string with 4 decimals, half-up rounded. */
export function calcNewGames(growth: number, divisorInput: unknown, testGames: number): string {
  const divisor = toScaledDivisor(normalizeDivisor(divisorInput));
  const numerator = BigInt(Math.trunc(growth)) * DIVISOR_SCALE * GAMES_SCALE;

  let quotient = numerator / divisor;
  const remainder = numerator % divisor;
  if (remainder !== 0n) {
    const twiceRemainder = 2n * (remainder < 0n ? -remainder : remainder);
    if (twiceRemainder >= divisor) quotient += numerator < 0n ? -1n : 1n;
  }

  const scaled = quotient - BigInt(Math.trunc(testGames)) * GAMES_SCALE;
  return formatScaled(scaled, GAMES_SCALE, 4);
}

/**
 * Parses a decimal string (or number) into an exact scaled BigInt, without ever round-tripping
 * through a JS float — `Number(str) * scale` loses exactness for values whose decimal expansion
 * doesn't fit a double's 53-bit mantissa, which matters here because Postgres NUMERIC values
 * arrive as text precisely to avoid that (see db/pool.ts's NUMERIC type parser).
 */
function parseDecimalToBigInt(value: string | number, scale: bigint): bigint {
  const str = typeof value === 'number' ? value.toString() : value;
  const negative = str.startsWith('-');
  const unsigned = negative ? str.slice(1) : str;
  const [wholePart, fractionPart = ''] = unsigned.split('.');
  const scaleDigits = scale.toString().length - 1;
  const paddedFraction = (fractionPart + '0'.repeat(scaleDigits)).slice(0, scaleDigits);
  const combined = BigInt(wholePart || '0') * scale + BigInt(paddedFraction || '0');
  return negative ? -combined : combined;
}

/** Returns revenue as a decimal string with 2 decimals, half-away-from-zero rounded. */
export function calcRevenue(newGames: string, pricePerGame: string | number): string {
  const games = parseDecimalToBigInt(newGames, GAMES_SCALE);
  const price = parseDecimalToBigInt(pricePerGame, 100n);
  const product = games * price; // scale 10^6
  const divisorToKopecks = 10_000n;
  let quotient = product / divisorToKopecks;
  const remainder = product % divisorToKopecks;
  if (remainder !== 0n && 2n * (remainder < 0n ? -remainder : remainder) >= divisorToKopecks) {
    quotient += product < 0n ? -1n : 1n;
  }
  return formatScaled(quotient, 100n, 2);
}

function formatScaled(scaled: bigint, scale: bigint, decimals: number): string {
  const negative = scaled < 0n;
  const absolute = negative ? -scaled : scaled;
  const whole = absolute / scale;
  const fraction = (absolute % scale).toString().padStart(decimals, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}
