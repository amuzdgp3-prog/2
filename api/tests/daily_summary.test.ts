import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { formatDailySummary, loadDailySummary } from '../src/domain/dailySummary.js';
import { authHeader, bootstrap, installTestMachine, pool, postService, type TestContext } from './helpers.js';

/** Ежедневная сводка по техникам в Telegram (DECISION-093). */
describe('ежедневная сводка: оформление', () => {
  it('техники по убыванию числа аппаратов, время, длительность, нал и безнал, итог', () => {
    const text = formatDailySummary({
      date: '2026-10-27',
      technicians: [
        { name: 'Катя', machines: 8, start: '09:10', finish: '13:34', cash: 11655, cashless: 9300 },
        { name: 'Федор', machines: 13, start: '09:01', finish: '14:01', cash: 20040, cashless: 26900 },
      ],
    });
    assert.equal(
      text,
      [
        '📋 Итоги дня · вт, 27 октября',
        '',
        'Федор — 13 аппаратов',
        '   09:01 → 14:01  (5 ч 00 мин)',
        '   💰 46 940 ₽: нал 20 040 · безнал 26 900',
        '',
        'Катя — 8 аппаратов',
        '   09:10 → 13:34  (4 ч 24 мин)',
        '   💰 20 955 ₽: нал 11 655 · безнал 9 300',
        '',
        '━━━━━━━━━━━━━━',
        'Всего: 2 техника · 21 аппарат',
        '💰 67 895 ₽: нал 31 695 · безнал 36 200',
      ].join('\n'),
    );
  });

  it('склонения: 1 аппарат, 2 аппарата, 11 аппаратов, 1 техник, 5 техников', () => {
    const one = formatDailySummary({
      date: '2026-10-27',
      technicians: [{ name: 'А', machines: 1, start: '10:00', finish: '10:00', cash: 0, cashless: 0 }],
    });
    assert.match(one, /А — 1 аппарат\n/);
    assert.match(one, /Всего: 1 техник · 1 аппарат\n/);

    const five = formatDailySummary({
      date: '2026-10-27',
      technicians: [2, 11, 1, 1, 1].map((machines, i) => ({
        name: `Т${i}`, machines, start: '10:00', finish: '11:00', cash: 0, cashless: 0,
      })),
    });
    assert.match(five, /Т0 — 2 аппарата\n/);
    assert.match(five, /Т1 — 11 аппаратов\n/);
    assert.match(five, /Всего: 5 техников · 16 аппаратов\n/);
  });

  it('отрицательный нал (безнал больше выручки) показывается со знаком, а не прячется', () => {
    const text = formatDailySummary({
      date: '2026-10-27',
      technicians: [{ name: 'А', machines: 1, start: '10:00', finish: '10:00', cash: -150, cashless: 1150 }],
    });
    assert.match(text, /нал −150 · безнал 1 150/);
  });

  it('день без обслуживаний — короткое сообщение, а не пустой отчёт', () => {
    assert.equal(
      formatDailySummary({ date: '2026-11-01', technicians: [] }),
      '📋 Итоги дня · вс, 1 ноября\n\nОбслуживаний не было.',
    );
  });
});

describe('ежедневная сводка: выборка', () => {
  let context: TestContext;

  before(async () => {
    context = await bootstrap();
    const { locationId } = await installTestMachine(context, {
      machineNumber: 'DS-1',
      pricePerGame: 10,
      initialGameCounter: 0,
      startedAt: '2026-01-01T00:00:00Z',
    });
    await installTestMachine(context, {
      machineNumber: 'DS-2',
      pricePerGame: 10,
      initialGameCounter: 0,
      startedAt: '2026-01-01T00:00:00Z',
    });
    await context.app.inject({
      method: 'POST',
      url: '/api/staff/scope',
      headers: authHeader(context.adminToken),
      payload: { staffId: context.technicianId, locationId },
    });
  });

  after(async () => {
    await context.app.close();
    await pool.end();
  });

  it('считает аппараты, время по Москве и нал/безнал техника; служебная учётка не попадает', async () => {
    // 07:15 и 10:40 UTC = 10:15 и 13:40 по Москве.
    const a = await postService(context, context.technicianToken, 'DS-1', {
      gameCounter: 100, prizeCounter: 0, occurredAt: '2026-01-15T07:15:00Z',
    });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    // Админ в той же дате: в проде под ним залита история, сводка его не считает.
    await pool.query(`UPDATE staff SET is_field_technician = FALSE WHERE login = 'admin'`);
    const b = await postService(context, context.adminToken, 'DS-2', {
      gameCounter: 300, prizeCounter: 0, occurredAt: '2026-01-15T10:40:00Z',
    });
    assert.equal(b.status, 200, JSON.stringify(b.body));

    const client = await pool.connect();
    try {
      const summary = await loadDailySummary(client, '2026-01-15');
      assert.equal(summary.technicians.length, 1, 'служебная учётка в сводку не входит');
      const [tech] = summary.technicians;
      assert.equal(tech.name, 'tech');
      assert.equal(tech.machines, 1);
      assert.equal(tech.start, '10:15');
      assert.equal(tech.finish, '10:15');
      assert.equal(tech.cash + tech.cashless, 1000, '100 игр × 10 ₽');

      const empty = await loadDailySummary(client, '2026-01-16');
      assert.deepEqual(empty.technicians, []);
    } finally {
      client.release();
    }
  });
});
