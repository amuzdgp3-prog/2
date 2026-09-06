/**
 * Механический счётчик-одометр — показания игрового/призового счётчика
 * (docs/design/mockups/00_design_system.html, .odometer).
 *
 * Мокап показывает 6-значное число с ведущими нулями (018732) как
 * иллюстративный пример. Реальные показания (game_counter/prize_counter,
 * BIGINT) со временем превышают 6 знаков — паддинг только достраивает
 * младшие разряды до минимальной ширины, но никогда не обрезает значение.
 */
export function Odometer({
  value,
  minDigits = 6,
}: {
  value: number | string;
  minDigits?: number;
}) {
  const digits = String(value);
  const padded = digits.padStart(minDigits, '0');

  return <span className="odometer mono">{padded}</span>;
}
