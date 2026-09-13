import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { authHeader, bootstrap, installTestMachine, pool, type TestContext } from './helpers.js';

/**
 * Задачи техникам (DECISION-050). Проверяется не столько CRUD, сколько два свойства, ради которых
 * модель устроена именно так: видимость (техник видит своё и ничьё, но не чужое) и идемпотентность
 * закрытия, без которой офлайн-сценарий ломается при первой же пересинхронизации.
 */
describe('задачи техникам', () => {
  let context: TestContext;
  let openTaskId: number;
  let foreignTaskId: number;

  const createTask = (payload: Record<string, unknown>) =>
    context.app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: authHeader(context.adminToken),
      payload,
    });

  const listAs = async (token: string) => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/tasks',
      headers: authHeader(token),
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as Array<Record<string, unknown>>;
  };

  before(async () => {
    context = await bootstrap();
    await installTestMachine(context, { machineNumber: 'TSK-1', pricePerGame: 10 });

    const unassigned = await createTask({ title: 'Заменить лампу', machineNumber: 'TSK-1' });
    assert.equal(unassigned.statusCode, 200, unassigned.body);
    openTaskId = unassigned.json().id;

    // Чужая задача: назначена другому человеку, техник её видеть не должен.
    const otherStaff = await pool.query(
      `INSERT INTO staff (login, full_name, role, password_hash)
       VALUES ('other-tech', 'Другой техник', 'TECHNICIAN', 'x') RETURNING id`,
    );
    const foreign = await createTask({
      title: 'Чужое поручение',
      assignedTo: otherStaff.rows[0].id,
    });
    foreignTaskId = foreign.json().id;
  });

  after(async () => {
    await context.app.close();
  });

  it('администратор видит все задачи', async () => {
    const all = await listAs(context.adminToken);
    assert.ok(all.length >= 2);
  });

  it('задача по аппарату вне зоны ответственности технику не видна', async () => {
    // Тот же принцип, что и с аппаратами: без назначенного доступа техник не видит ни аппарат, ни
    // поручения по нему. Иначе он получил бы задачу, которую физически не может выполнить.
    const mine = await listAs(context.technicianToken);
    assert.ok(!mine.map((task) => task.id).includes(openTaskId));
  });

  it('после выдачи доступа к аппарату задача появляется, но чужая — нет', async () => {
    const machine = await pool.query(`SELECT location_id FROM machine_placements WHERE machine_number = 'TSK-1'`);
    const granted = await context.app.inject({
      method: 'POST',
      url: '/api/staff/scope',
      headers: authHeader(context.adminToken),
      payload: { staffId: context.technicianId, locationId: machine.rows[0].location_id },
    });
    assert.equal(granted.statusCode, 200, granted.body);

    const mine = await listAs(context.technicianToken);
    const ids = mine.map((task) => task.id);
    assert.ok(ids.includes(openTaskId), 'незакреплённая задача по своему аппарату должна быть видна');
    assert.ok(!ids.includes(foreignTaskId), 'чужая назначенная задача видна быть не должна');
  });

  it('техник не может закрыть задачу, назначенную другому', async () => {
    const denied = await context.app.inject({
      method: 'POST',
      url: `/api/tasks/${foreignTaskId}/close`,
      headers: authHeader(context.technicianToken),
      payload: { note: 'я мимо проходил' },
    });
    assert.equal(denied.statusCode, 400, denied.body);
    assert.equal(denied.json().error, 'TASK_ASSIGNED_TO_OTHER');
  });

  it('техник закрывает незакреплённую задачу с комментарием', async () => {
    const closed = await context.app.inject({
      method: 'POST',
      url: `/api/tasks/${openTaskId}/close`,
      headers: authHeader(context.technicianToken),
      payload: { note: 'Заменил, работает' },
    });
    assert.equal(closed.statusCode, 200, closed.body);
    assert.equal(closed.json().status, 'DONE');
    assert.equal(closed.json().close_note, 'Заменил, работает');
  });

  it('повторное закрытие после офлайна ничего не переписывает', async () => {
    const first = await pool.query('SELECT closed_at, closed_by, close_note FROM technician_tasks WHERE id = $1', [openTaskId]);

    const again = await context.app.inject({
      method: 'POST',
      url: `/api/tasks/${openTaskId}/close`,
      headers: authHeader(context.adminToken),
      payload: { note: 'другой комментарий от другого человека' },
    });
    assert.equal(again.statusCode, 200, again.body);

    const second = await pool.query('SELECT closed_at, closed_by, close_note FROM technician_tasks WHERE id = $1', [openTaskId]);
    assert.deepEqual(second.rows[0], first.rows[0], 'автор, момент и комментарий закрытия не меняются');
  });

  it('техник не может отменить задачу, это решение поручавшего', async () => {
    const created = await createTask({ title: 'Отменяемая' });
    const denied = await context.app.inject({
      method: 'POST',
      url: `/api/tasks/${created.json().id}/close`,
      headers: authHeader(context.technicianToken),
      payload: { cancel: true },
    });
    assert.equal(denied.statusCode, 403, denied.body);
  });

  it('администратор отменяет и возвращает задачу в работу', async () => {
    const created = await createTask({ title: 'Передумали' });
    const id = created.json().id;

    const cancelled = await context.app.inject({
      method: 'POST',
      url: `/api/tasks/${id}/close`,
      headers: authHeader(context.adminToken),
      payload: { cancel: true, note: 'больше не нужно' },
    });
    assert.equal(cancelled.json().status, 'CANCELLED');

    const reopened = await context.app.inject({
      method: 'POST',
      url: `/api/tasks/${id}/reopen`,
      headers: authHeader(context.adminToken),
    });
    assert.equal(reopened.json().status, 'OPEN');
    assert.equal(reopened.json().closed_at, null);
  });

  it('задача без названия отклоняется', async () => {
    const empty = await createTask({ title: '   ' });
    assert.equal(empty.statusCode, 400, empty.body);
  });

  it('техник не может создавать задачи', async () => {
    const denied = await context.app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: authHeader(context.technicianToken),
      payload: { title: 'сам себе поручил' },
    });
    assert.equal(denied.statusCode, 403, denied.body);
  });
});
