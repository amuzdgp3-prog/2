import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bootstrap, installTestMachine, postService, type TestContext } from './helpers.js';

/**
 * Понятная причина отказа для техника (DECISION-048). Проверяется не только то, что отказ
 * происходит, но и что названа ровно одна конкретная причина: раньше показание призов меньше
 * предыдущего давало «операция нарушает ограничение целостности данных», а ошибка по играм и по
 * тестовым играм приходила одним общим текстом, в котором смешаны две разные причины.
 */
describe('монотонность счётчиков: по одной причине за раз', () => {
  let context: TestContext;

  before(async () => {
    context = await bootstrap();
    await installTestMachine(context, {
      machineNumber: 'MONO-1',
      pricePerGame: 10,
      startedAt: '2026-01-01T08:00:00Z',
      initialGameCounter: 1000,
      initialPrizeCounter: 100,
    });
    const first = await postService(context, context.adminToken, 'MONO-1', {
      gameCounter: 2000,
      prizeCounter: 150,
      occurredAt: '2026-01-10T12:00:00Z',
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));
  });

  after(async () => {
    await context.app.close();
  });

  it('счётчик игр назад — названы обе цифры и дата, без упоминания тестовых игр', async () => {
    const back = await postService(context, context.adminToken, 'MONO-1', {
      gameCounter: 1500,
      prizeCounter: 200,
      occurredAt: '2026-01-20T12:00:00Z',
    });
    assert.equal(back.status, 400, JSON.stringify(back.body));
    assert.equal(back.body.error, 'GAME_COUNTER_WENT_BACK');
    assert.match(String(back.body.message), /1500/);
    assert.match(String(back.body.message), /2000/);
    assert.doesNotMatch(String(back.body.message), /[Тт]естов/);
  });

  it('счётчик призов назад — отдельная причина, а не общая ошибка целостности', async () => {
    const back = await postService(context, context.adminToken, 'MONO-1', {
      gameCounter: 2500,
      prizeCounter: 120,
      occurredAt: '2026-01-20T12:00:00Z',
    });
    assert.equal(back.status, 400, JSON.stringify(back.body));
    assert.equal(back.body.error, 'PRIZE_COUNTER_WENT_BACK');
    assert.match(String(back.body.message), /призов/);
    assert.doesNotMatch(String(back.body.message), /целостности/);
  });

  it('тестовых игр больше, чем прирост — своя причина со своими числами', async () => {
    const tooMany = await postService(context, context.adminToken, 'MONO-1', {
      gameCounter: 2050,
      prizeCounter: 160,
      testGames: 500,
      occurredAt: '2026-01-20T12:00:00Z',
    });
    assert.equal(tooMany.status, 400, JSON.stringify(tooMany.body));
    assert.equal(tooMany.body.error, 'TEST_GAMES_EXCEED_GROWTH');
    assert.match(String(tooMany.body.message), /500/);
    assert.match(String(tooMany.body.message), /50/);
  });

  it('корректное обслуживание проходит', async () => {
    const fine = await postService(context, context.adminToken, 'MONO-1', {
      gameCounter: 2400,
      prizeCounter: 170,
      testGames: 5,
      occurredAt: '2026-01-20T12:00:00Z',
    });
    assert.equal(fine.status, 200, JSON.stringify(fine.body));
  });
});
