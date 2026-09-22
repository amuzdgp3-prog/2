import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { authHeader, bootstrap, installTestMachine, pool, type TestContext } from './helpers.js';

/**
 * Предупреждение о похожем терминале (DECISION-084). Номер на сайте iVend — 50264785, владелец
 * называет его 264785; заведённая короткая форма становится мёртвой записью, которая не получает
 * ни одной транзакции, а настоящий терминал продолжает числиться за прежним аппаратом.
 */
describe('поиск похожего терминала по последним цифрам', () => {
  let context: TestContext;

  before(async () => {
    context = await bootstrap();
    await installTestMachine(context, { machineNumber: 'SIM-62', pricePerGame: 10 });

    for (const serial of ['50264785', '50111111']) {
      const created = await context.app.inject({
        method: 'POST',
        url: '/api/terminals',
        headers: authHeader(context.adminToken),
        payload: { serial, provider: 'demo' },
      });
      assert.equal(created.statusCode, 200, created.body);
    }

    const bound = await context.app.inject({
      method: 'POST',
      url: '/api/terminals/bind',
      headers: authHeader(context.adminToken),
      payload: {
        terminalId: (
          await pool.query(`SELECT id FROM terminals WHERE serial = '50264785'`)
        ).rows[0].id,
        machineNumber: 'SIM-62',
        startedAt: '2026-02-01T00:00:00Z',
      },
    });
    assert.equal(bound.statusCode, 200, bound.body);
  });

  after(async () => {
    await context.app.close();
  });

  const similar = async (serial: string) => {
    const response = await context.app.inject({
      method: 'GET',
      url: `/api/terminals/similar?serial=${encodeURIComponent(serial)}`,
      headers: authHeader(context.adminToken),
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as Array<Record<string, string | null>>;
  };

  it('короткая форма номера находит терминал с префиксом и его аппарат', async () => {
    const found = await similar('264785');
    assert.equal(found.length, 1);
    assert.equal(found[0].serial, '50264785');
    assert.equal(found[0].bound_machine, 'SIM-62');
    assert.equal(found[0].location_name, 'Точка SIM-62', 'адрес нужен, чтобы владелец узнал точку');
  });

  it('точное совпадение не показывается: его и так отсечёт UNIQUE', async () => {
    assert.deepEqual(await similar('50264785'), []);
  });

  it('терминал с другими последними цифрами не считается похожим', async () => {
    assert.deepEqual(await similar('50999999'), []);
  });

  it('слишком короткий ввод не поднимает весь список', async () => {
    assert.deepEqual(await similar('785'), []);
  });

  it('серийный номер сохраняется без пробелов по краям', async () => {
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/terminals',
      headers: authHeader(context.adminToken),
      payload: { serial: '  50777777  ', provider: 'demo' },
    });
    assert.equal(created.statusCode, 200, created.body);
    assert.equal(created.json().serial, '50777777');
  });
});
