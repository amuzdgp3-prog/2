import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

/**
 * Тот же класс бага, что уже нашли и починили для Telegram (DECISION-074) и раньше для iVend
 * (DECISION-041) — у Node-глобального fetch нет таймаута по умолчанию. Отдельный файл — тесты
 * Node запускают каждый файл в своём процессе, поэтому свои переменные окружения (короткий
 * EMAIL_SEND_TIMEOUT_MS и подставной RESEND_API_BASE) не пересекаются с другими тестами.
 */
async function startHangingResend(): Promise<{ close: () => void; url: string }> {
  const server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { close: () => server.close(), url: `http://127.0.0.1:${port}` };
}

test('отправка отчёта на почту: зависшее соединение обрывается по таймауту, а не висит вечно', async () => {
  const hanging = await startHangingResend();
  process.env.RESEND_API_BASE = hanging.url;
  process.env.EMAIL_SEND_TIMEOUT_MS = '300';
  process.env.RESEND_API_KEY = 'test-key';
  process.env.RESEND_FROM = 'onboarding@resend.dev';
  process.env.REPORT_OWNER_EMAIL = 'owner@example.com';

  const { bootstrap, authHeader } = await import('./helpers.js');
  const context = await bootstrap();
  try {
    const started = Date.now();
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/reports/monthly-excel/send-email?year=2026&month=8',
      headers: authHeader(context.adminToken),
    });
    assert.ok(
      Date.now() - started < 5_000,
      'зависшее соединение до почтового сервиса должно обрываться по таймауту, а не висеть вечно',
    );
    assert.equal(response.statusCode, 400, 'деловая ошибка, а не 500 и не бесконечное ожидание');
    assert.equal(response.json().error, 'EMAIL_SEND_FAILED');
  } finally {
    await context.app.close();
    hanging.close();
  }
});

test('отправка на почту без настройки RESEND_API_KEY/FROM/REPORT_OWNER_EMAIL — понятная ошибка', async () => {
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM;
  delete process.env.REPORT_OWNER_EMAIL;

  const { bootstrap, authHeader } = await import('./helpers.js');
  const context = await bootstrap();
  try {
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/reports/monthly-excel/send-email?year=2026&month=8',
      headers: authHeader(context.adminToken),
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'EMAIL_NOT_CONFIGURED');
  } finally {
    await context.app.close();
  }
});
