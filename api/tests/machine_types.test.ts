import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { authHeader, bootstrap, installTestMachine, pool, type TestContext } from './helpers.js';

/**
 * Справочник типов аппаратов (015_machine_types.sql, DECISION-047). Ключ справочника — само
 * название типа, поэтому проверяется главное следствие этого решения: переименование разъезжается
 * по аппаратам внешним ключом, а используемый тип нельзя удалить, только отключить.
 */
describe('справочник типов аппаратов', () => {
  let context: TestContext;

  before(async () => {
    context = await bootstrap();
  });

  after(async () => {
    await context.app.close();
  });

  const list = async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/machine-types',
      headers: authHeader(context.adminToken),
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as Array<{ name: string; is_active: boolean; machines_count: number }>;
  };

  it('существующие типы аппаратов перенесены миграцией в справочник', async () => {
    const types = await list();
    assert.ok(types.some((row) => row.name === 'CRANE'), 'дефолтный тип CRANE должен быть в справочнике');
  });

  it('заводит новый тип и отклоняет повтор', async () => {
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/machine-types',
      headers: authHeader(context.adminToken),
      payload: { name: '  Прищепка  ' },
    });
    assert.equal(created.statusCode, 200, created.body);
    // Пробелы по краям срезаются, иначе «Прищепка» и « Прищепка » стали бы разными типами.
    assert.equal(created.json().name, 'Прищепка');

    const again = await context.app.inject({
      method: 'POST',
      url: '/api/machine-types',
      headers: authHeader(context.adminToken),
      payload: { name: 'Прищепка' },
    });
    assert.equal(again.statusCode, 409, again.body);
  });

  it('пустое название отклоняется', async () => {
    const empty = await context.app.inject({
      method: 'POST',
      url: '/api/machine-types',
      headers: authHeader(context.adminToken),
      payload: { name: '   ' },
    });
    assert.equal(empty.statusCode, 400, empty.body);
  });

  it('аппарат нельзя установить с типом, которого нет в справочнике', async () => {
    // Точку нужно создать заранее: её проверка срабатывает раньше внешнего ключа по типу, и без
    // неё тест упал бы на «точка не существует», ничего не сказав про справочник типов.
    const location = await context.app.inject({
      method: 'POST',
      url: '/api/locations',
      headers: authHeader(context.adminToken),
      payload: { name: 'Точка для теста типов', timezone: 'Europe/Moscow' },
    });
    assert.equal(location.statusCode, 200, location.body);

    const installed = await context.app.inject({
      method: 'POST',
      url: '/api/machines/install',
      headers: authHeader(context.adminToken),
      payload: {
        machineNumber: 'MT-X', machineType: 'Неведомый', pricePerGame: 10,
        counterDivisor: 1, locationId: location.json().id, startedAt: '2026-01-01T08:00:00Z',
        initialGameCounter: 0, initialPrizeCounter: 0, initialToys: [],
      },
    });
    assert.notEqual(installed.statusCode, 200);
    assert.match(installed.json().message, /справочнике/);
  });

  it('переименование типа само разъезжается по аппаратам', async () => {
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/machine-types',
      headers: authHeader(context.adminToken),
      payload: { name: 'Хват' },
    });
    assert.equal(created.statusCode, 200, created.body);
    await installTestMachine(context, { machineNumber: 'MT-1', pricePerGame: 10, machineType: 'Хват' });

    const renamed = await context.app.inject({
      method: 'PATCH',
      url: '/api/machine-types/' + encodeURIComponent('Хват'),
      headers: authHeader(context.adminToken),
      payload: { name: 'Хват-2' },
    });
    assert.equal(renamed.statusCode, 200, renamed.body);

    const machine = await pool.query(`SELECT machine_type FROM machines WHERE machine_number = 'MT-1'`);
    assert.equal(machine.rows[0].machine_type, 'Хват-2', 'внешний ключ ON UPDATE CASCADE должен перенести имя');
  });

  it('используемый тип нельзя удалить, но можно отключить', async () => {
    const removal = await context.app.inject({
      method: 'DELETE',
      url: '/api/machine-types/' + encodeURIComponent('Хват-2'),
      headers: authHeader(context.adminToken),
    });
    assert.equal(removal.statusCode, 400, removal.body);
    assert.match(removal.json().message, /можно отключить/);

    const disabled = await context.app.inject({
      method: 'PATCH',
      url: '/api/machine-types/' + encodeURIComponent('Хват-2'),
      headers: authHeader(context.adminToken),
      payload: { isActive: false },
    });
    assert.equal(disabled.statusCode, 200, disabled.body);
    assert.equal(disabled.json().is_active, false);

    // Отключение не трогает сам аппарат: история и отчёты по нему остаются как были.
    const machine = await pool.query(`SELECT machine_type FROM machines WHERE machine_number = 'MT-1'`);
    assert.equal(machine.rows[0].machine_type, 'Хват-2');
  });

  it('неиспользуемый тип удаляется', async () => {
    const removal = await context.app.inject({
      method: 'DELETE',
      url: '/api/machine-types/' + encodeURIComponent('Прищепка'),
      headers: authHeader(context.adminToken),
    });
    assert.equal(removal.statusCode, 200, removal.body);
    assert.ok(!(await list()).some((row) => row.name === 'Прищепка'));
  });

  it('техник не имеет доступа к справочнику', async () => {
    const forbidden = await context.app.inject({
      method: 'GET',
      url: '/api/machine-types',
      headers: authHeader(context.technicianToken),
    });
    assert.equal(forbidden.statusCode, 403, forbidden.body);
  });
});

describe('machine types list access', () => {
  it('BOSS can read the list, TECHNICIAN cannot, BOSS cannot create', async () => {
    const context = await bootstrap();
    const get = (token: string) =>
      context.app.inject({ method: 'GET', url: '/api/machine-types', headers: authHeader(token) });
    assert.equal((await get(context.bossToken)).statusCode, 200);
    assert.equal((await get(context.technicianToken)).statusCode, 403);
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/machine-types',
      headers: authHeader(context.bossToken),
      payload: { name: 'Новый тип' },
    });
    assert.equal(created.statusCode, 403);
  });
});
