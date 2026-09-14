import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

/**
 * Тот же класс бага, что DECISION-041 уже чинил для кабинета iVend, найден и здесь на реальном
 * проде: у Node-глобального fetch нет таймаута по умолчанию, а сеть сервера не пропускает TCP до
 * api.telegram.org (заблокировано на уровне провайдера/файрвола — ping проходит, TCP:443
 * зависает). Без таймаута нажатие «Отправить в Telegram» держало бы открытым соединение к БД из
 * пула (тот же `finally { client.release() }`, что и у iVend) вечно. Отдельный файл — тесты
 * Node запускают каждый файл в своём процессе, поэтому свои переменные окружения (короткий
 * TELEGRAM_SEND_TIMEOUT_MS и подставной TELEGRAM_API_BASE) не пересекаются с другими тестами.
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

test('отправка отчёта в Telegram: зависшее соединение обрывается по таймауту, а не висит вечно', async () => {
  const hanging = await startHangingTelegram();
  process.env.TELEGRAM_API_BASE = hanging.url;
  process.env.TELEGRAM_SEND_TIMEOUT_MS = '300';
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_OWNER_CHAT_ID = 'test-chat';

  const { bootstrap, authHeader } = await import('./helpers.js');
  const context = await bootstrap();
  try {
    const started = Date.now();
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/reports/monthly-excel/send-telegram?year=2026&month=8',
      headers: authHeader(context.adminToken),
    });
    assert.ok(
      Date.now() - started < 5_000,
      'зависшее соединение до Telegram должно обрываться по таймауту, а не висеть вечно',
    );
    assert.equal(response.statusCode, 400, 'деловая ошибка, а не 500 и не бесконечное ожидание');
    assert.equal(response.json().error, 'TELEGRAM_SEND_FAILED');
  } finally {
    await context.app.close();
    hanging.close();
  }
});
