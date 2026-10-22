import { toyCostStatus, TOY_COST_HIGH_ABOVE, TOY_COST_LOW_BELOW, type ToyCostStatus } from './toyCostStatus';

/**
 * Что показать в колонке «Затраты» журнала для одного обслуживания. Помимо обычной доли затрат
 * (toyCostStatus по ROI) различает случаи, где ROI пустой:
 *  - в прошлый раз игрушки не докладывали, а игры шли как обычно для этого аппарата — значит призы
 *    почти не выпадали: «0 % · отдаёт мало»;
 *  - игрушки не докладывали, но и игр было заметно меньше обычного — аппарат мог стоять, судить
 *    об отдаче нельзя: «мало игр»;
 *  - первое обслуживание на точке — сравнивать не с чем.
 * Обычный темп аппарата приходит с сервера (usual_games_per_day, медиана игр в сутки, DECISION-048).
 */
export type ToyCostView =
  | ToyCostStatus
  | { level: 'idle' | 'none'; percent: null; label: string; hint: string };

export interface ServiceToyCost {
  view: ToyCostView;
  /** Одна фраза для раскрытой строки: что произошло и что делать. */
  explanation: string;
}

/** Ниже этой доли обычного темпа игр считаем, что аппарат почти не играл. */
export const IDLE_PACE_SHARE = 0.5;

export interface ServiceToyCostInput {
  ratio: string | null;
  hasPrevious: boolean;
  prevToyCost: string | null;
  gamesPerDay: number | null;
  usualGamesPerDay: string | number | null;
}

const NORM = `норма ${TOY_COST_LOW_BELOW}–${TOY_COST_HIGH_ABOVE} %`;
const pace = (value: number) => Math.round(value).toLocaleString('ru-RU');

export function serviceToyCost(input: ServiceToyCostInput): ServiceToyCost {
  const status = toyCostStatus(input.ratio);
  if (status) {
    const action =
      status.level === 'ok' ? 'Аппарат в целевой вилке.' : `${status.hint}.`;
    return {
      view: status,
      explanation: `Игрушки прошлой загрузки — ${status.percent} % от выручки этого периода (${NORM}). ${action}`,
    };
  }

  if (!input.hasPrevious) {
    return {
      view: { level: 'none', percent: null, label: 'первое обсл.', hint: 'Первое обслуживание на точке' },
      explanation: 'Первое обслуживание на этой точке — прошлой загрузки нет, сравнивать не с чем.',
    };
  }

  const usual = input.usualGamesPerDay === null ? null : Number(input.usualGamesPerDay);
  const games = input.gamesPerDay;
  const prevCost = Number(input.prevToyCost ?? 0);

  // ROI пустой при прошлом обслуживании — значит прошлая загрузка нулевая (или не внесена).
  if (prevCost <= 0 && games !== null && usual !== null && usual > 0) {
    if (games >= usual * IDLE_PACE_SHARE) {
      return {
        view: {
          percent: 0,
          level: 'low',
          label: 'отдаёт мало',
          hint: 'В прошлый раз игрушки не докладывали, а игры шли как обычно. Настроить аппарат на большую отдачу',
        },
        explanation:
          `В прошлый раз игрушки не докладывали, а игр было как обычно — ${pace(games)} в сутки при обычных ${pace(usual)}. `
          + 'Призы почти не выпадают: настроить аппарат на большую отдачу.',
      };
    }
    return {
      view: {
        level: 'idle',
        percent: null,
        label: 'мало игр',
        hint: 'Игр заметно меньше обычного — об отдаче судить нельзя',
      },
      explanation:
        `В прошлый раз игрушки не докладывали, но и игр было мало — ${pace(games)} в сутки при обычных ${pace(usual)}. `
        + 'Об отдаче судить нельзя: проверьте, работал ли аппарат.',
    };
  }

  return {
    view: { level: 'none', percent: null, label: 'нет данных', hint: 'Не с чем сравнить' },
    explanation: 'Прошлая загрузка не внесена, а обычного темпа игр у аппарата ещё нет — сравнивать не с чем.',
  };
}
