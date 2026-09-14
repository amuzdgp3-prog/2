import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  authHeader,
  bootstrap,
  createStaff,
  createToy,
  installTestMachine,
  pool,
  postService,
  type TestContext,
} from './helpers.js';

/**
 * Эндпоинт эффективности техников на настоящей базе. Главное, что здесь проверяется, — привязка
 * выручки к тому, кто ПОДГОТОВИЛ аппарат, а не к тому, кто снял деньги (решение владельца от
 * 14.09.2026), и то, что цепочка пар строится по установке, а не по номеру аппарата.
 */
describe('/api/reports/technician-effectiveness', () => {
  let context: TestContext;
  let firstId: number;
  let secondId: number;
  let toyId: number;

  const service = async (
    machineNumber: string,
    technicianId: number,
    occurredAt: string,
    gameCounter: number,
    toys?: Array<{ toyId: number; quantity: number }>,
  ) => {
    const posted = await postService(context, context.adminToken, machineNumber, {
      gameCounter,
      prizeCounter: 0,
      occurredAt,
      technicianId,
      ...(toys ? { toys } : {}),
    } as never);
    assert.equal(posted.status, 200, JSON.stringify(posted.body));
  };

  before(async () => {
    context = await bootstrap();
    firstId = await createStaff('eff-one', 'TECHNICIAN');
    secondId = await createStaff('eff-two', 'TECHNICIAN');
    toyId = await createToy(context, 'Мягкая игрушка', 15);

    const { locationId } = await installTestMachine(context, {
      machineNumber: 'EFF-1',
      pricePerGame: 10,
      startedAt: '2026-01-01T00:00:00Z',
      initialGameCounter: 0,
      initialPrizeCounter: 0,
    });
    await installTestMachine(context, {
      machineNumber: 'EFF-2',
      pricePerGame: 10,
      startedAt: '2026-01-01T00:00:00Z',
      initialGameCounter: 0,
      initialPrizeCounter: 0,
      locationId,
    });

    // Первый техник готовит аппарат, второй через 10 дней снимает выручку за этот период.
    // Все выезды заводит администратор, явно указывая техника (DECISION-055).
    await service('EFF-1', firstId, '2026-02-01T08:00:00Z', 100, [{ toyId, quantity: 10 }]);
    await service('EFF-1', secondId, '2026-02-11T08:00:00Z', 1100, [{ toyId, quantity: 10 }]);
    await service('EFF-1', firstId, '2026-02-21T08:00:00Z', 2100, [{ toyId, quantity: 10 }]);
    await service('EFF-1', secondId, '2026-03-03T08:00:00Z', 3100, [{ toyId, quantity: 10 }]);

    await service('EFF-2', firstId, '2026-02-01T08:00:00Z', 100, [{ toyId, quantity: 10 }]);
    await service('EFF-2', secondId, '2026-02-11T08:00:00Z', 1100, [{ toyId, quantity: 10 }]);
  });

  after(async () => {
    await context.app.close();
  });

  const fetchReport = async (query = ''): Promise<Record<string, never>> => {
    const response = await context.app.inject({
      method: 'GET',
      url: `/api/reports/technician-effectiveness${query}`,
      headers: authHeader(context.adminToken),
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };

  it('выручка периода достаётся технику подготовки, а не тому, кто снял деньги', async () => {
    const report = await fetchReport() as never as {
      rows: Array<{ technicianId: number; pairs: number; totalRevenue: number }>;
    };
    const first = report.rows.find((row) => row.technicianId === firstId);
    const second = report.rows.find((row) => row.technicianId === secondId);

    // Первый подготовил три раза (два на EFF-1 и один на EFF-2), и все три периода закрыты.
    assert.equal(first?.pairs, 3);
    // Второй тоже выезжал, но после его визитов закрывающего выезда либо не было, либо он сам
    // и есть закрывающий — засчитанных периодов у него один (EFF-1, 11.02 → 21.02).
    assert.equal(second?.pairs, 1);

    // 1000 + 1000 игр по 10 ₽ на EFF-1 и 1000 игр на EFF-2 — вся эта выручка у первого.
    assert.equal(first?.totalRevenue, 30000);
  });

  it('ниже порога в три пары оценка не выдаётся', async () => {
    const report = await fetchReport() as never as {
      rows: Array<{ technicianId: number; enoughData: boolean; index: number | null }>;
      meta: { minPairs: number };
    };
    assert.equal(report.meta.minPairs, 3);

    const first = report.rows.find((row) => row.technicianId === firstId);
    const second = report.rows.find((row) => row.technicianId === secondId);
    assert.equal(first?.enoughData, true);
    assert.equal(second?.enoughData, false);
    assert.equal(second?.index, null, 'с одной парой оценка не показывается вовсе');
  });

  it('период фильтруется по дате подготовки, а не по дате сбора денег', async () => {
    // Пара 21.02 → 03.03 принадлежит февралю: подготовка была в феврале, деньги сняты в марте.
    const february = await fetchReport('?from=2026-02-01&to=2026-02-28') as never as {
      rows: Array<{ technicianId: number; pairs: number }>;
    };
    const first = february.rows.find((row) => row.technicianId === firstId);
    assert.equal(first?.pairs, 3, 'все три подготовки первого техника пришлись на февраль');

    const march = await fetchReport('?from=2026-03-01&to=2026-03-31') as never as {
      rows: Array<{ technicianId: number }>;
    };
    assert.equal(march.rows.length, 0, 'в марте подготовок не было, только закрывающий выезд');
  });

  it('переезд аппарата на другую точку не склеивает пару через границу установки', async () => {
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/locations',
      headers: authHeader(context.adminToken),
      payload: { name: 'Точка переезда', timezone: 'Europe/Moscow' },
    });
    assert.equal(created.statusCode, 200, created.body);

    const moved = await context.app.inject({
      method: 'POST',
      url: '/api/machines/EFF-2/move',
      headers: authHeader(context.adminToken),
      payload: {
        locationId: created.json().id,
        movedAt: '2026-03-20T00:00:00Z',
        detachTerminal: false,
      },
    });
    assert.equal(moved.statusCode, 200, moved.body);

    // Выезд уже на новой установке: он не должен образовать пару с последним выездом на старой.
    await service('EFF-2', secondId, '2026-04-01T08:00:00Z', 5000, [{ toyId, quantity: 10 }]);

    const report = await fetchReport() as never as {
      rows: Array<{ technicianId: number; pairs: number }>;
    };
    const first = report.rows.find((row) => row.technicianId === firstId);
    assert.equal(first?.pairs, 3, 'пар у первого техника не прибавилось');

    const pairs = await pool.query(
      `SELECT count(*)::int AS count FROM services s
       WHERE s.machine_number = 'EFF-2'`,
    );
    assert.equal(pairs.rows[0].count, 3, 'выезды на аппарате есть, но они в разных установках');
  });
});
