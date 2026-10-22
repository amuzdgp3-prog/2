import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  authHeader,
  bootstrap,
  createToy,
  installTestMachine,
  pool,
  postService,
  type TestContext,
} from './helpers.js';

/**
 * Настройки клешни на карточке аппарата (DECISION-090): запись только при изменении, границы
 * типа, своя цель аппарата и совет по итогам с последнего изменения.
 */
describe('настройки клешни: карточка аппарата', () => {
  let context: TestContext;
  let toyId: number;

  before(async () => {
    context = await bootstrap();
    await context.app.inject({
      method: 'POST',
      url: '/api/machine-types',
      headers: authHeader(context.adminToken),
      payload: { name: 'МиникХ' },
    });
    await pool.query(
      `UPDATE machine_types SET has_claw_settings = TRUE, target_payout_percent = 35,
              claw_weak_min = 8, claw_weak_max = 15
       WHERE name = 'МиникХ'`,
    );
    toyId = await createToy(context, 'Мишка', 50);
    // 10 игрушек по 50 ₽ при установке — затраты первого периода 500 ₽.
    await installTestMachine(context, {
      machineNumber: 'CL-1', machineType: 'МиникХ', pricePerGame: 10, initialToys: [{ toyId, quantity: 10 }],
    });
    await installTestMachine(context, { machineNumber: 'CL-2', pricePerGame: 10 });
  });

  after(async () => {
    await context.app.close();
  });

  const card = async (machineNumber = 'CL-1') => {
    const response = await context.app.inject({
      method: 'GET',
      url: `/api/machines/${machineNumber}/claw`,
      headers: authHeader(context.adminToken),
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  const post = (payload: Record<string, unknown>, machineNumber = 'CL-1') =>
    context.app.inject({
      method: 'POST',
      url: `/api/machines/${machineNumber}/claw-settings`,
      headers: authHeader(context.adminToken),
      payload,
    });

  it('до первых показаний совета нет', async () => {
    const result = await card();
    assert.equal(result.current, null);
    assert.equal(result.advice.advice.kind, 'no-settings');
    assert.deepEqual(result.band, { target: 35, low: 31.5, high: 38.5 });
  });

  it('первые показания записываются, повтор тех же значений — нет', async () => {
    const first = await post({ strong: 40, medium: 30, weak: 12.4, prizeSet: 10 });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().changed, true);
    assert.equal(first.json().current.weak, 12.4);

    const same = await post({ weak: 12.4 });
    assert.equal(same.json().changed, false);
    assert.equal((await card()).history.length, 1);
  });

  it('не переданное поле остаётся прежним', async () => {
    const changed = await post({ weak: 12.6 });
    assert.equal(changed.json().changed, true);
    const current = changed.json().current;
    assert.deepEqual([current.strong, current.medium, current.weak, current.prizeSet], [40, 30, 12.6, 10]);
  });

  it('значение за границами типа отклоняется', async () => {
    const response = await post({ weak: 20 });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error, 'CLAW_VALUE_OUT_OF_RANGE');
  });

  it('у типа без меню Claw Set настройки не принимаются', async () => {
    const response = await post({ weak: 12 }, 'CL-2');
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error, 'CLAW_SETTINGS_DISABLED');
  });

  it('совет — по итогам всех обслуживаний с последнего изменения', async () => {
    // Изменение «было» до обслуживаний: обслуживание нельзя датировать будущим, поэтому сдвигаем
    // момент изменения назад.
    await pool.query(
      `UPDATE claw_settings SET effective_at = '2026-01-01T09:00:00Z' WHERE machine_number = 'CL-1'`,
    );
    // 400 игр × 10 ₽ = 4000 ₽ при затратах 500 ₽ — отдача 12,5 %, сильно ниже цели 35 %.
    const first = await postService(context, context.adminToken, 'CL-1', {
      gameCounter: 400, prizeCounter: 0, occurredAt: '2026-01-05T10:00:00Z', toys: [{ toyId, quantity: 10 }],
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    let result = await card();
    assert.equal(result.advice.advice.kind, 'change');
    assert.equal(result.advice.advice.direction, 'raise');
    assert.equal(result.advice.advice.to, 12.8);
    assert.equal(result.since.games, 400);

    // Своя цель аппарата 12 % — та же отдача уже в норме (10,8–13,2 %).
    const target = await context.app.inject({
      method: 'PUT',
      url: '/api/machines/CL-1/target-payout',
      headers: authHeader(context.adminToken),
      payload: { percent: 12 },
    });
    assert.equal(target.statusCode, 200, target.body);
    result = await card();
    assert.equal(result.machineTarget, 12);
    assert.equal(result.advice.advice.kind, 'ok');
  });

  it('цель аппарата задаёт только администратор', async () => {
    const response = await context.app.inject({
      method: 'PUT',
      url: '/api/machines/CL-1/target-payout',
      headers: authHeader(context.technicianToken),
      payload: { percent: 20 },
    });
    assert.equal(response.statusCode, 403, response.body);
  });

  it('история не удаляется', async () => {
    await assert.rejects(pool.query(`DELETE FROM claw_settings WHERE machine_number = 'CL-1'`));
  });
});
