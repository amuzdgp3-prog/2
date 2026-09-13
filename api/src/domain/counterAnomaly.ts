import type { Client } from '../db/pool.js';
import { badRequest } from '../lib/errors.js';

/**
 * Защита от ввода показаний не того аппарата (DECISION-048).
 *
 * Реальный случай владельца: техник вписал счётчик чужого аппарата, разница получилась на 200 с
 * лишним тысяч рублей, и система это пропустила — формально показание было больше предыдущего, а
 * другой проверки не существовало. Отрицательную разницу счётчика `recalcMachineChain` ловил и
 * раньше, но ошибка ровно так же часто даёт разницу в плюс, и вот она проходила молча.
 *
 * Проверка сравнивает не абсолютное число, а ТЕМП: сколько игр в сутки получается в этом
 * обслуживании против того, как этот же аппарат работал раньше. Абсолютный порог был бы бесполезен,
 * потому что нормальная выручка аппарата в проходном месте на порядок отличается от аппарата в
 * посёлке.
 *
 * Это предупреждение, а не запрет. Всплеск бывает и настоящим — праздники, новая точка, замена
 * игрушек на ходовые, — поэтому техник может подтвердить ввод, и тогда обслуживание сохраняется как
 * есть. Молча пропускать нельзя, молча запрещать — тоже.
 */

/** Во сколько раз темп должен превысить обычный для этого аппарата, чтобы считаться подозрительным. */
const PACE_FACTOR = 5;
/** Ниже этой суммы расхождение не стоит внимания: на копейках проверка только мешала бы. */
const MIN_SUSPICIOUS_RUB = 20_000;
/** Сколько прошлых обслуживаний берём за «обычный» темп аппарата. */
const HISTORY_DEPTH = 20;

export interface CounterJumpDetails {
  newGames: number;
  expectedGames: number;
  pacePerDay: number;
  usualPacePerDay: number;
  periodDays: number;
  excessRub: number;
}

/**
 * Бросает ошибку с кодом COUNTER_JUMP_SUSPECTED, если показание даёт неправдоподобный скачок.
 * Вызывается до вставки строки, поэтому ничего откатывать не приходится.
 */
export async function assertNoCounterJump(
  client: Client,
  input: {
    placementId: number;
    machineNumber: string;
    occurredAt: string;
    gameCounter: number;
    testGames: number;
    counterDivisor: number;
    pricePerGame: number;
  },
): Promise<void> {
  // Предыдущее обслуживание этой же установки — та же граница, по которой считается вся цепочка.
  const previous = await client.query<{ game_counter: string; occurred_at: Date }>(
    `SELECT game_counter, occurred_at FROM services
     WHERE placement_id = $1 AND occurred_at < $2::timestamptz
     ORDER BY occurred_at DESC, id DESC LIMIT 1`,
    [input.placementId, input.occurredAt],
  );
  if (previous.rowCount === 0) return; // Первое обслуживание — сравнивать не с чем.

  const periodMs = new Date(input.occurredAt).getTime() - new Date(previous.rows[0].occurred_at).getTime();
  const periodDays = periodMs / 86_400_000;
  if (periodDays <= 0) return; // Порядок дат проверяется в другом месте.

  const newGames =
    (input.gameCounter - Number(previous.rows[0].game_counter)) / input.counterDivisor - input.testGames;
  if (newGames <= 0) return; // Отрицательный рост ловит recalcMachineChain отдельной ошибкой.

  // «Обычный» темп аппарата — медиана игр в сутки по его прошлым обслуживаниям. Медиана, а не
  // среднее: одна аномалия в истории не должна поднимать порог и прятать следующую.
  const usual = await client.query<{ pace: string | null }>(
    `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY pace) AS pace FROM (
       SELECT s.new_games / NULLIF(EXTRACT(EPOCH FROM (s.occurred_at - COALESCE(
                LAG(s.occurred_at) OVER (PARTITION BY s.placement_id ORDER BY s.occurred_at, s.id),
                p.started_at))) / 86400, 0) AS pace
       FROM services s
       JOIN machine_placements p ON p.id = s.placement_id
       WHERE s.machine_number = $1 AND s.occurred_at < $2::timestamptz
       ORDER BY s.occurred_at DESC
       LIMIT $3
     ) paces WHERE pace IS NOT NULL AND pace > 0`,
    [input.machineNumber, input.occurredAt, HISTORY_DEPTH],
  );
  const usualPace = Number(usual.rows[0]?.pace ?? 0);
  if (!usualPace) return; // Нет истории темпа — не на чем строить подозрение.

  const pace = newGames / periodDays;
  const expectedGames = usualPace * periodDays;
  const excessRub = (newGames - expectedGames) * input.pricePerGame;

  if (pace > usualPace * PACE_FACTOR && excessRub > MIN_SUSPICIOUS_RUB) {
    const details: CounterJumpDetails = {
      newGames: Math.round(newGames),
      expectedGames: Math.round(expectedGames),
      pacePerDay: Math.round(pace),
      usualPacePerDay: Math.round(usualPace),
      periodDays: Math.round(periodDays * 10) / 10,
      excessRub: Math.round(excessRub),
    };
    throw badRequest(
      'COUNTER_JUMP_SUSPECTED',
      `Показание даёт ${details.newGames} игр за ${details.periodDays} дн. — это `
      + `${details.pacePerDay} игр в сутки против обычных ${details.usualPacePerDay} для этого `
      + `аппарата, то есть примерно на ${details.excessRub.toLocaleString('ru-RU')} ₽ больше `
      + 'ожидаемого. Проверьте, что это счётчик именно этого аппарата и что цифры переписаны верно.',
      details,
    );
  }
}
