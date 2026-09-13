import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

/**
 * 13.09.2026 в 04:00 кабинет iVend ответил HTML-страницей шлюза вместо JSON, и в админке это
 * выглядело как «Unexpected token '<', "<html>..." is not valid JSON» без намёка на причину. Здесь
 * фальшивый шлюз отвечает 502 с HTML, и проверяется, что ошибка теперь называет HTTP-код.
 * Отдельный файл по той же причине, что и ivend_timeout.test.ts: адрес GraphQL читается один раз
 * при загрузке модуля, а раннер Node даёт каждому файлу свой процесс.
 */
async function startHtmlGateway(): Promise<{ close: () => void; url: string }> {
  const server = createServer((_request, response) => {
    response.statusCode = 502;
    response.setHeader('content-type', 'text/html');
    response.end('<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { close: () => server.close(), url: `http://127.0.0.1:${port}/graphql` };
}

test('iVend sync: HTML-ответ шлюза даёт понятную ошибку с HTTP-кодом', async () => {
  const gateway = await startHtmlGateway();
  process.env.IVEND_GRAPHQL_URL = gateway.url;

  const { bootstrap, authHeader, pool } = await import('./helpers.js');
  const context = await bootstrap();
  try {
    const saved = await context.app.inject({
      method: 'PUT',
      url: '/api/parser/ivend/settings',
      headers: authHeader(context.adminToken),
      payload: { login: '9990000000', password: 'irrelevant', isEnabled: true },
    });
    assert.equal(saved.json().ok, false);
    assert.match(saved.json().message, /HTTP 502/);

    const run = await context.app.inject({
      method: 'POST',
      url: '/api/parser/ivend/run',
      headers: authHeader(context.adminToken),
    });
    assert.match(run.json().error, /HTTP 502/);
    assert.doesNotMatch(run.json().error, /Unexpected token/);

    const runs = await pool.query(
      `SELECT status, error_message FROM parser_runs WHERE provider = 'ivend' ORDER BY id DESC LIMIT 1`,
    );
    assert.equal(runs.rows[0].status, 'ERROR');
    assert.match(runs.rows[0].error_message, /HTTP 502/);
  } finally {
    await context.app.close();
    gateway.close();
  }
});
