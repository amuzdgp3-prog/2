import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bootstrap, installTestMachine, postService, type TestContext } from './helpers.js';

/**
 * Предупреждение о неправдоподобном скачке счётчика (DECISION-048). Реальный случай владельца:
 * техник вписал показание чужого аппарата, разница вышла на 200 с лишним тысяч рублей и прошла
 * молча, потому что формально показание было больше предыдущего.
 */
describe('скачок показаний счётчика', () => {
  let context: TestContext;

  before(async () => {
    context = await bootstrap();
    await installTestMachine(context, {
      machineNumber: 'JUMP-1',
      pricePerGame: 10,
      startedAt: '2026-01-01T08:00:00Z',
      initialGameCounter: 0,
    });

    // Ровный темп около 100 игр в сутки на протяжении четырёх обслуживаний — это и станет
    // «обычным» для аппарата.
    let counter = 0;
    for (const [day, games] of [[5, 500], [10, 500], [15, 500], [20, 500]] as const) {
      counter += games;
      const posted = await postService(context, context.adminToken, 'JUMP-1', {
        gameCounter: counter,
        prizeCounter: 0,
        occurredAt: `2026-01-${String(day).padStart(2, '0')}T12:00:00Z`,
      });
      assert.equal(posted.status, 200, JSON.stringify(posted.body));
    }
  });

  after(async () => {
    await context.app.close();
  });

  it('обычное обслуживание проходит без предупреждения', async () => {
    const normal = await postService(context, context.adminToken, 'JUMP-1', {
      gameCounter: 2500,
      prizeCounter: 0,
      occurredAt: '2026-01-25T12:00:00Z',
    });
    assert.equal(normal.status, 200, JSON.stringify(normal.body));
  });

  it('показание чужого аппарата отклоняется с объяснением, а не проходит молча', async () => {
    const wrong = await postService(context, context.adminToken, 'JUMP-1', {
      gameCounter: 60_000,
      prizeCounter: 0,
      occurredAt: '2026-01-30T12:00:00Z',
    });
    assert.equal(wrong.status, 400, JSON.stringify(wrong.body));
    assert.equal(wrong.body.error, 'COUNTER_JUMP_SUSPECTED');
    assert.match(String(wrong.body.message), /игр в сутки против обычных/);
    // Подробности нужны интерфейсу, чтобы показать технику конкретные числа, а не общий текст.
    const details = wrong.body.details as { usualPacePerDay: number; excessRub: number };
    assert.ok(details.usualPacePerDay > 0);
    assert.ok(details.excessRub > 20_000);
  });

  it('техник может подтвердить показание, и оно сохраняется как есть', async () => {
    const confirmed = await postService(context, context.adminToken, 'JUMP-1', {
      gameCounter: 60_000,
      prizeCounter: 0,
      occurredAt: '2026-01-30T12:00:00Z',
      confirmCounterJump: true,
    } as never);
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  });

  it('первое обслуживание аппарата не с чем сравнивать и не предупреждает', async () => {
    await installTestMachine(context, {
      machineNumber: 'JUMP-2',
      pricePerGame: 10,
      startedAt: '2026-01-01T08:00:00Z',
      initialGameCounter: 0,
    });
    const first = await postService(context, context.adminToken, 'JUMP-2', {
      gameCounter: 99_000,
      prizeCounter: 0,
      occurredAt: '2026-01-05T12:00:00Z',
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));
  });
});
