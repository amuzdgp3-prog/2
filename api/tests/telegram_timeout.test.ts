import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

/**
 * Тот же класс бага, что DECISION-041 уже чинил для кабинета iVend, найден и здесь на реальном
 * проде: у Node-глобального fetch нет таймаута по умолчанию, а сеть сервера не пропускает TCP до
 * api.telegram.org (заблокировано на уровне провайдера/файрвола — ping проходит, TCP:443
 * зависает). Без таймаута отправка держала бы соединение открытым вечно.
 *
 * DECISION-092 убрал прямой вызов sendTelegramDocument из API-роута: теперь роут только ставит
 * запись в telegram_outbox, а отправляет внешний релей (scripts/telegram-relay.mjs), у которого
 * своя — намеренно независимая от api/ — реализация с тем же AbortSignal.timeout. Поэтому тест
 * бьёт по sendTelegramDocument напрямую, а не через HTTP-роут отчёта: сама функция в api/
 * остаётся как рабочий путь на случай, если сеть прода когда-нибудь починят, и защита от
 * зависания в ней должна держаться тестом.
 */
async function startHangingTelegram(): Promise<{ close: () => void; url: string }> {
  // Соединение принимается и никогда не отвечает — именно так выглядит зависшее TCP-соединение
  // до заблокированного IP, а не отказ (connection refused), который отработал бы мгновенно.
  const server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { close: () => server.close(), url: `http://127.0.0.1:${port}` };
}

test('sendTelegramDocument: зависшее соединение обрывается по таймауту, а не висит вечно', async () => {
  const hanging = await startHangingTelegram();
  process.env.TELEGRAM_API_BASE = hanging.url;
  process.env.TELEGRAM_SEND_TIMEOUT_MS = '300';

  const { sendTelegramDocument } = await import('../src/integrations/telegram.js');
  const started = Date.now();
  await assert.rejects(
    () => sendTelegramDocument('test-token', 'test-chat', Buffer.from('x'), 'file.xlsx'),
    (error: unknown) => {
      assert.ok(error instanceof Error && 'code' in error);
      assert.equal((error as { code: string }).code, 'TELEGRAM_SEND_FAILED');
      return true;
    },
  );
  assert.ok(
    Date.now() - started < 5_000,
    'зависшее соединение до Telegram должно обрываться по таймауту, а не висеть вечно',
  );
  hanging.close();
});
