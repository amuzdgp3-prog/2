import { withTransaction } from '../db/pool.js';
import { DAILY_SUMMARY_TIME, enqueueScheduledDailySummary } from '../commands/dailySummary.js';

/**
 * Планировщик ежедневной сводки (DECISION-093). Устроен по образцу планировщика iVend в
 * server.ts (тик раз в минуту, московское время), с одним отличием: iVend срабатывает только в
 * точную минуту, и если контейнер перезапускался ровно в неё, запуск теряется. Сводка
 * срабатывает «в 21:30 или позже, если за сегодня ещё не ставилась» — отметку держит сама
 * очередь (commands/dailySummary.ts), поэтому выкатка или перезапуск в 21:30 сводку не теряют
 * и не дублируют.
 */
const MOSCOW_HHMM = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Moscow',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const MOSCOW_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' });

/** Деловая дата по Москве, если сводку за неё уже пора ставить, иначе null. */
export function dailySummaryDue(nowMs: number): string | null {
  return MOSCOW_HHMM.format(nowMs) >= DAILY_SUMMARY_TIME ? MOSCOW_DATE.format(nowMs) : null;
}

export function startDailySummaryScheduler(): void {
  let running = false;
  // Чтобы после постановки до полуночи не ходить в базу каждую минуту.
  let doneDate: string | null = null;

  setInterval(() => {
    if (running) return;
    const date = dailySummaryDue(Date.now());
    if (!date || date === doneDate) return;
    running = true;
    withTransaction((client) => enqueueScheduledDailySummary(client, date))
      .then((enqueued) => {
        doneDate = date;
        if (enqueued) console.log(`daily summary for ${date} enqueued`);
      })
      .catch((error) => {
        // Следующий тик через минуту попробует снова — doneDate не выставлен.
        console.error('daily summary failed, retrying next minute:', error);
      })
      .finally(() => {
        running = false;
      });
  }, 60_000);
}
