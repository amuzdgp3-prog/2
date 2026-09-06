import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { authHeader, bootstrap, createToy, installTestMachine, postService, type TestContext } from './helpers.js';

/**
 * Toy consumption analysis (owner-requested): next-month purchase forecasting per toy, and a
 * per-machine consumption-vs-revenue view that flags statistical outliers in EITHER direction —
 * "too generous" (low revenue per unit of toy cost) and "too stingy" (the opposite, a real risk
 * signal too: players who never win stop coming back) — relative to the fleet's own MEDIAN (and
 * MAD, "modified z-score") for the same period, not a fixed threshold like RoiBadge and not a
 * plain mean/stddev z-score (which the outliers being searched for would themselves skew).
 */
describe('toy consumption analysis', () => {
  let context: TestContext;

  before(async () => {
    context = await bootstrap();
  });

  after(async () => {
    await context.app.close();
  });

  it('flags a machine as an outlier in both directions relative to the fleet mean', async () => {
    const toyId = await createToy(context, 'Игрушка', '10.00');

    // Four "normal" machines: 3 services each, 10 games growth (=1000 revenue) and 5 toys
    // (=50 cost) per visit -> ratio 20 for every one of them.
    for (const num of ['CA', 'CB', 'CC', 'CD']) {
      await installTestMachine(context, { machineNumber: num, pricePerGame: 100, initialGameCounter: 0 });
      let counter = 0;
      for (const day of [1, 8, 15]) {
        counter += 10;
        await postService(context, context.adminToken, num, {
          gameCounter: counter, prizeCounter: 0,
          occurredAt: `2026-03-${String(day).padStart(2, '0')}T10:00:00Z`,
          toys: [{ toyId, quantity: 5 }],
        });
      }
    }

    // One "too generous" outlier: same revenue, ten times the toy cost -> ratio 2.
    await installTestMachine(context, { machineNumber: 'CE', pricePerGame: 100, initialGameCounter: 0 });
    {
      let counter = 0;
      for (const day of [1, 8, 15]) {
        counter += 10;
        await postService(context, context.adminToken, 'CE', {
          gameCounter: counter, prizeCounter: 0,
          occurredAt: `2026-03-${String(day).padStart(2, '0')}T10:00:00Z`,
          toys: [{ toyId, quantity: 50 }],
        });
      }
    }

    const response = await context.app.inject({
      method: 'GET',
      url: '/api/reports/toy-consumption?from=2026-03-01&to=2026-03-31',
      headers: authHeader(context.adminToken),
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      machines: Array<{
        machineNumber: string; ratio: number | null; anomaly: string | null; modifiedZScore: number | null;
        newGames: string; quantities: Record<string, number>;
      }>;
      toyTotals: Array<{ name: string; quantity: number; cost: string }>;
      fleetStats: { meanRatio: number; medianRatio: number; mad: number; sampleSize: number };
    };

    const byNumber = Object.fromEntries(body.machines.map((m) => [m.machineNumber, m]));
    assert.equal(byNumber.CA.ratio, 20);
    assert.equal(byNumber.CA.anomaly, null, 'a machine at the fleet median must not be flagged');
    assert.equal(byNumber.CA.newGames, '30.0000', 'games-played is threaded through as a traffic proxy');
    assert.equal(byNumber.CE.ratio, 2);
    assert.equal(byNumber.CE.anomaly, 'HIGH_CONSUMPTION', 'far below the fleet median ratio means too much toy cost per revenue');
    assert.ok(byNumber.CE.modifiedZScore! <= -3.5);
    assert.equal(body.fleetStats.sampleSize, 5);
    assert.equal(body.fleetStats.medianRatio, 20);

    // 4 normal machines x 3 visits x 5 toys + the outlier's 3 visits x 50 toys = 60 + 150 = 210.
    const totals = Object.fromEntries(body.toyTotals.map((t) => [t.name, t]));
    assert.equal(totals['Игрушка'].quantity, 210);
    assert.equal(totals['Игрушка'].cost, (210 * 10).toFixed(2));
  });

  it('never flags a machine with too few services to be statistically meaningful', async () => {
    const toyId = await createToy(context, 'Редкая игрушка', '10.00');
    await installTestMachine(context, { machineNumber: 'CF', pricePerGame: 100, initialGameCounter: 0 });
    // Only one visit, wildly different ratio than anything else — must not skew or be flagged.
    await postService(context, context.adminToken, 'CF', {
      gameCounter: 10, prizeCounter: 0, occurredAt: '2026-03-01T10:00:00Z',
      toys: [{ toyId, quantity: 500 }],
    });

    const response = await context.app.inject({
      method: 'GET',
      url: '/api/reports/toy-consumption?from=2026-03-01&to=2026-03-31',
      headers: authHeader(context.adminToken),
    });
    const body = response.json() as { machines: Array<{ machineNumber: string; anomaly: string | null }> };
    const cf = body.machines.find((m) => m.machineNumber === 'CF');
    assert.equal(cf!.anomaly, null, 'one visit is not enough evidence to call it an anomaly');
  });

  it('forecasts next month purchase quantity as the average of the recent months with data', async () => {
    const toyId = await createToy(context, 'Прогнозная игрушка', '15.00');
    await installTestMachine(context, { machineNumber: 'CG', pricePerGame: 100, initialGameCounter: 0 });

    const now = new Date();
    const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 2, 10));
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 2, 10));

    await postService(context, context.adminToken, 'CG', {
      gameCounter: 10, prizeCounter: 0, occurredAt: lastMonth.toISOString(),
      toys: [{ toyId, quantity: 20 }],
    });
    await postService(context, context.adminToken, 'CG', {
      gameCounter: 20, prizeCounter: 0, occurredAt: thisMonth.toISOString(),
      toys: [{ toyId, quantity: 40 }],
    });

    const response = await context.app.inject({
      method: 'GET',
      url: '/api/reports/toy-forecast?months=3',
      headers: authHeader(context.adminToken),
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as Array<{ name: string; monthly: Array<{ quantity: number }>; forecastNextMonth: { quantity: number; cost: string } }>;
    const row = body.find((r) => r.name === 'Прогнозная игрушка');
    assert.ok(row, 'the toy must appear in the trend even with only two months of data');
    // Average of 20 and 40 (only two months had any data at all) = 30.
    assert.equal(row!.forecastNextMonth.quantity, 30);
    assert.equal(row!.forecastNextMonth.cost, (30 * 15).toFixed(2));
  });
});
