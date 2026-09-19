import type { Client } from '../db/pool.js';
import { badRequest } from '../lib/errors.js';

/**
 * Понятная причина отказа для техника в поле (DECISION-048).
 *
 * До этого он получал одно из двух: либо общее «расчёт даёт отрицательное количество новых игр:
 * проверьте показания и тестовые игры», где смешаны две разные причины, либо — при показании
 * призов меньше предыдущего — вообще «операция нарушает ограничение целостности данных», потому
 * что этот случай ловила только проверка в базе, не переведённая на человеческий язык.
 *
 * Здесь причина называется ровно одна и ровно та, с конкретными числами и датой предыдущего
 * обслуживания. Именно одна: если техник ошибся при переписывании, у него обычно неверна одна
 * цифра, а список из трёх претензий сразу он читать не станет и, скорее всего, исправит не то.
 * Порядок проверок — от самого вероятного к самому редкому.
 */
const formatDate = (value: Date): string =>
  new Date(value).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

export async function assertCountersMoveForward(
  client: Client,
  input: {
    placementId: number;
    occurredAt: string;
    gameCounter: number;
    prizeCounter: number;
    testGames: number;
    counterDivisor: number;
    /**
     * Подтверждение отката счётчика призов. Счётчик призов не участвует в финансовом расчёте —
     * в отличие от счётчика игр, его откат почти всегда просто ошибка ввода (или сам счётчик на
     * аппарате сбит физически), а не признак подмены аппарата, поэтому его можно подтвердить и
     * отправить, а не переписывать цифру заново.
     */
    confirmPrizeCounterBack?: boolean;
  },
): Promise<void> {
  const previous = await client.query<{
    game_counter: string;
    prize_counter: string;
    occurred_at: Date;
  }>(
    `SELECT s.game_counter, s.prize_counter, s.occurred_at FROM services s
     WHERE s.placement_id = $1 AND s.occurred_at < $2::timestamptz
     ORDER BY s.occurred_at DESC, s.id DESC LIMIT 1`,
    [input.placementId, input.occurredAt],
  );

  // Для первого обслуживания установки роль «предыдущих» играют начальные показания самой
  // установки — та же граница, по которой считает цепочку counterChain.
  const baseline = previous.rowCount
    ? {
        gameCounter: Number(previous.rows[0].game_counter),
        prizeCounter: Number(previous.rows[0].prize_counter),
        at: formatDate(previous.rows[0].occurred_at),
      }
    : await (async () => {
        const placement = await client.query<{
          initial_game_counter: string;
          initial_prize_counter: string;
          started_at: Date;
        }>(
          'SELECT initial_game_counter, initial_prize_counter, started_at FROM machine_placements WHERE id = $1',
          [input.placementId],
        );
        return {
          gameCounter: Number(placement.rows[0].initial_game_counter),
          prizeCounter: Number(placement.rows[0].initial_prize_counter),
          at: `установки ${formatDate(placement.rows[0].started_at)}`,
        };
      })();

  if (input.gameCounter < baseline.gameCounter) {
    throw badRequest(
      'GAME_COUNTER_WENT_BACK',
      `Счётчик игр ${input.gameCounter} меньше предыдущего показания ${baseline.gameCounter} `
      + `от ${baseline.at}. Счётчик не может идти назад — проверьте, тот ли это аппарат и верно ли `
      + 'переписана цифра.',
      { field: 'gameCounter', entered: input.gameCounter, previous: baseline.gameCounter },
    );
  }

  if (input.prizeCounter < baseline.prizeCounter && !input.confirmPrizeCounterBack) {
    throw badRequest(
      'PRIZE_COUNTER_WENT_BACK',
      `Счётчик призов ${input.prizeCounter} меньше предыдущего показания ${baseline.prizeCounter} `
      + `от ${baseline.at}. Проверьте цифру: счётчик призов тоже только растёт.`,
      { field: 'prizeCounter', entered: input.prizeCounter, previous: baseline.prizeCounter },
    );
  }

  const growthInGames = (input.gameCounter - baseline.gameCounter) / input.counterDivisor;
  if (input.testGames > growthInGames) {
    throw badRequest(
      'TEST_GAMES_EXCEED_GROWTH',
      `Тестовых игр указано ${input.testGames}, а счётчик вырос всего на `
      + `${Math.floor(growthInGames)} игр с ${baseline.at}. Тестовых не может быть больше, чем `
      + 'сыграно всего.',
      { field: 'testGames', entered: input.testGames, growth: Math.floor(growthInGames) },
    );
  }
}
