/**
 * «Обычный» темп аппарата в журнале обслуживаний — медиана игр в сутки по его последним
 * обслуживаниям ДО данного. То же определение, что в проверке скачков счётчика (DECISION-048,
 * counterAnomaly.ts): медиана, а не среднее, чтобы одна аномалия не сдвигала норму.
 *
 * Нужен журналу, чтобы отличать «в прошлый раз игрушки не докладывали, а игры шли как обычно»
 * (аппарат отдаёт мало) от «игр почти не было» (судить об отдаче нельзя).
 */
export const USUAL_PACE_HISTORY_DEPTH = 20;

/**
 * LATERAL-подзапрос для строки `alias` таблицы services: колонка usual_games_per_day (numeric или
 * NULL, если истории темпа нет). Глубина истории — константа, подставляется литералом, чтобы не
 * сдвигать нумерацию параметров вызывающего запроса.
 */
export function usualPaceLateralSql(alias: string): string {
  return `LEFT JOIN LATERAL (
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY pace) AS usual_games_per_day FROM (
      SELECT h.new_games / NULLIF(EXTRACT(EPOCH FROM (h.occurred_at - COALESCE(
               LAG(h.occurred_at) OVER (PARTITION BY h.placement_id ORDER BY h.occurred_at, h.id),
               hp.started_at))) / 86400, 0) AS pace
      FROM services h
      JOIN machine_placements hp ON hp.id = h.placement_id
      WHERE h.machine_number = ${alias}.machine_number AND h.occurred_at < ${alias}.occurred_at
      ORDER BY h.occurred_at DESC
      LIMIT ${USUAL_PACE_HISTORY_DEPTH}
    ) paces WHERE pace IS NOT NULL AND pace > 0
  ) usual_pace ON true`;
}
