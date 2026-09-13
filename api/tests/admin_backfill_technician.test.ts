import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { authHeader, bootstrap, installTestMachine, pool, postService, type TestContext } from './helpers.js';

/**
 * Администратор указывает техника при создании обслуживания (DECISION-055) — нужно для бумажного
 * бланка, внесённого задним числом за отсутствующего техника. Проверяется главное свойство: это
 * право только у администратора, техник указать чужой id не может, что бы ни прислал.
 */
describe('admin backfills a service with an explicit technician', () => {
  let context: TestContext;
  let otherTechId: number;

  before(async () => {
    context = await bootstrap();
    const { locationId } = await installTestMachine(context, { machineNumber: 'BF-1', pricePerGame: 10 });
    const other = await pool.query(
      `INSERT INTO staff (login, full_name, role, password_hash)
       VALUES ('other-bf', 'Другой техник', 'TECHNICIAN', 'x') RETURNING id`,
    );
    otherTechId = other.rows[0].id;

    // Техник должен иметь доступ к аппарату, иначе постановка обслуживания отклонится ещё раньше,
    // на проверке зоны ответственности, и подмена technicianId проверится не тем.
    const granted = await context.app.inject({
      method: 'POST',
      url: '/api/staff/scope',
      headers: authHeader(context.adminToken),
      payload: { staffId: context.technicianId, locationId },
    });
    assert.equal(granted.statusCode, 200, granted.body);
  });

  after(async () => {
    await context.app.close();
  });

  it('администратор указывает техника явно', async () => {
    const posted = await postService(context, context.adminToken, 'BF-1', {
      gameCounter: 100,
      prizeCounter: 10,
      occurredAt: '2026-01-05T10:00:00Z',
      technicianId: context.technicianId,
    } as never);
    assert.equal(posted.status, 200, JSON.stringify(posted.body));

    const stored = await pool.query('SELECT technician_id FROM services WHERE machine_number = $1', ['BF-1']);
    assert.equal(Number(stored.rows[0].technician_id), context.technicianId);
  });

  it('техник не может подставить чужой id — записывается его собственный', async () => {
    const posted = await postService(context, context.technicianToken, 'BF-1', {
      gameCounter: 200,
      prizeCounter: 12,
      occurredAt: '2026-01-06T10:00:00Z',
      technicianId: otherTechId,
    } as never);
    assert.equal(posted.status, 200, JSON.stringify(posted.body));

    const stored = await pool.query(
      'SELECT technician_id FROM services WHERE machine_number = $1 AND occurred_at = $2',
      ['BF-1', '2026-01-06T10:00:00Z'],
    );
    assert.equal(Number(stored.rows[0].technician_id), context.technicianId, 'должен записаться сам вошедший, а не чужой id');
  });

  it('несуществующий или не-техник id отклоняется', async () => {
    const badId = await postService(context, context.adminToken, 'BF-1', {
      gameCounter: 300,
      prizeCounter: 14,
      occurredAt: '2026-01-07T10:00:00Z',
      technicianId: 999999,
    } as never);
    assert.equal(badId.status, 400, JSON.stringify(badId.body));
    assert.equal(badId.body.error, 'INVALID_TECHNICIAN');

    const notTechnician = await postService(context, context.adminToken, 'BF-1', {
      gameCounter: 300,
      prizeCounter: 14,
      occurredAt: '2026-01-07T10:00:00Z',
      technicianId: 1, // системный/админский id в тестовой базе — не техник
    } as never);
    assert.equal(notTechnician.status, 400, JSON.stringify(notTechnician.body));
    assert.equal(notTechnician.body.error, 'INVALID_TECHNICIAN');
  });
});
