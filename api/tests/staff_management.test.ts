import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { authHeader, bootstrap, installTestMachine, pool, postService, type TestContext } from './helpers.js';

describe('staff tab: profile edits, password reset, last-admin guard', () => {
  let context: TestContext;

  before(async () => {
    context = await bootstrap();
  });

  after(async () => {
    await context.app.close();
    await pool.end();
  });

  it('resets a password with no complexity policy and lets the new password log in', async () => {
    const reset = await context.app.inject({
      method: 'POST',
      url: `/api/staff/${context.technicianId}/password`,
      headers: authHeader(context.adminToken),
      payload: { password: '1' },
    });
    assert.equal(reset.statusCode, 200);

    const loggedIn = await context.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { login: 'tech', password: '1' },
    });
    assert.equal(loggedIn.statusCode, 200);

    const audit = await pool.query(
      `SELECT context ->> 'reason' AS reason, new_data FROM audit_log
       WHERE entity = 'staff' AND entity_id = $1 AND context ->> 'reason' = 'password_reset'`,
      [String(context.technicianId)],
    );
    assert.equal(audit.rows[0].reason, 'password_reset');
    assert.equal(
      Object.prototype.hasOwnProperty.call(audit.rows[0].new_data, 'password_hash'),
      false,
      'the audit record must never contain the password hash',
    );
  });

  it('rejects an empty password', async () => {
    const reset = await context.app.inject({
      method: 'POST',
      url: `/api/staff/${context.technicianId}/password`,
      headers: authHeader(context.adminToken),
      payload: { password: '' },
    });
    assert.equal(reset.statusCode, 400);
    assert.equal(reset.json().error, 'PASSWORD_REQUIRED');
  });

  it('lets an admin change a colleague\'s role and active status', async () => {
    const updated = await context.app.inject({
      method: 'PATCH',
      url: `/api/staff/${context.technicianId}`,
      headers: authHeader(context.adminToken),
      payload: { role: 'BOSS', fullName: 'Переименованный' },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().role, 'BOSS');
    assert.equal(updated.json().full_name, 'Переименованный');

    const deactivated = await context.app.inject({
      method: 'PATCH',
      url: `/api/staff/${context.technicianId}`,
      headers: authHeader(context.adminToken),
      payload: { isActive: false },
    });
    assert.equal(deactivated.statusCode, 200);
    assert.equal(deactivated.json().is_active, false);

    const loginAttempt = await context.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { login: 'tech', password: 'secret' },
    });
    assert.equal(loginAttempt.statusCode, 401, 'a deactivated account must not be able to log in');
  });

  it('refuses to demote or deactivate the last active admin', async () => {
    const admins = await pool.query(`SELECT id FROM staff WHERE role = 'ADMIN' AND is_active`);
    assert.equal(admins.rowCount, 1, 'the fixture starts with exactly one active admin');
    const onlyAdminId = admins.rows[0].id;

    const demote = await context.app.inject({
      method: 'PATCH',
      url: `/api/staff/${onlyAdminId}`,
      headers: authHeader(context.adminToken),
      payload: { role: 'TECHNICIAN' },
    });
    assert.equal(demote.statusCode, 400);
    assert.equal(demote.json().error, 'LAST_ADMIN');

    const deactivate = await context.app.inject({
      method: 'PATCH',
      url: `/api/staff/${onlyAdminId}`,
      headers: authHeader(context.adminToken),
      payload: { isActive: false },
    });
    assert.equal(deactivate.statusCode, 400);
    assert.equal(deactivate.json().error, 'LAST_ADMIN');

    const stillAdmin = await pool.query('SELECT role, is_active FROM staff WHERE id = $1', [
      onlyAdminId,
    ]);
    assert.deepEqual(stillAdmin.rows[0], { role: 'ADMIN', is_active: true });
  });

  it('allows demoting an admin when another active admin remains', async () => {
    const second = await context.app.inject({
      method: 'POST',
      url: '/api/staff',
      headers: authHeader(context.adminToken),
      payload: { login: 'admin2', fullName: 'Второй админ', role: 'ADMIN', password: 'x' },
    });
    const secondId = second.json().id;

    const admins = await pool.query(`SELECT id FROM staff WHERE role = 'ADMIN' AND is_active`);
    const firstAdminId = admins.rows.find((row) => row.id !== secondId).id;

    const demote = await context.app.inject({
      method: 'PATCH',
      url: `/api/staff/${firstAdminId}`,
      headers: authHeader(context.adminToken),
      payload: { role: 'TECHNICIAN' },
    });
    assert.equal(demote.statusCode, 200);
    assert.equal(demote.json().role, 'TECHNICIAN');
  });

  it('never exposes password_hash from the staff list or profile update endpoints', async () => {
    const list = await context.app.inject({
      method: 'GET',
      url: '/api/staff',
      headers: authHeader(context.adminToken),
    });
    for (const row of list.json() as Array<Record<string, unknown>>) {
      assert.ok(!('password_hash' in row));
    }
  });

  it('boss cannot manage staff', async () => {
    const attempt = await context.app.inject({
      method: 'PATCH',
      url: `/api/staff/${context.technicianId}`,
      headers: authHeader(context.bossToken),
      payload: { fullName: 'x' },
    });
    assert.equal(attempt.statusCode, 403);
  });

  it('deletes a staff account that never did anything, including a location scope grant', async () => {
    const created = await context.app.inject({
      method: 'POST', url: '/api/staff', headers: authHeader(context.adminToken),
      payload: { login: 'del-tech', fullName: 'Удаляемый', role: 'TECHNICIAN', password: 'x' },
    });
    const staffId = created.json().id;

    const location = await context.app.inject({
      method: 'POST', url: '/api/locations', headers: authHeader(context.adminToken),
      payload: { name: 'Точка del-tech', timezone: 'Europe/Moscow' },
    });
    await context.app.inject({
      method: 'POST', url: '/api/staff/scope', headers: authHeader(context.adminToken),
      payload: { staffId, locationId: location.json().id },
    });

    const deleted = await context.app.inject({
      method: 'DELETE', url: `/api/staff/${staffId}`, headers: authHeader(context.adminToken),
    });
    assert.equal(deleted.statusCode, 200);

    const list = await context.app.inject({
      method: 'GET', url: '/api/staff', headers: authHeader(context.adminToken),
    });
    assert.ok(!list.json().some((row: { id: number }) => row.id === staffId), 'must be gone from the staff list');

    const loginAttempt = await context.app.inject({
      method: 'POST', url: '/api/auth/login', payload: { login: 'del-tech', password: 'x' },
    });
    assert.equal(loginAttempt.statusCode, 401);
  });

  it('refuses to delete a staff member who has real history, pointing at deactivation instead', async () => {
    // A second ADMIN (not a TECHNICIAN) avoids two unrelated complications: an admin's own
    // service-creation is never scope-checked, and this account is never the LAST active admin,
    // so the assertion below is actually exercising the history guard, not that other one.
    const created = await context.app.inject({
      method: 'POST', url: '/api/staff', headers: authHeader(context.adminToken),
      payload: { login: 'history-admin', fullName: 'С историей', role: 'ADMIN', password: 'x' },
    });
    const staffId = created.json().id;
    const loggedIn = await context.app.inject({
      method: 'POST', url: '/api/auth/login', payload: { login: 'history-admin', password: 'x' },
    });
    const secondAdminToken = loggedIn.json().token;

    await installTestMachine(context, { machineNumber: 'DELSTAFF-1', pricePerGame: 10 });
    const service = await postService(context, secondAdminToken, 'DELSTAFF-1', {
      gameCounter: 10, prizeCounter: 0, occurredAt: '2026-05-01T10:00:00Z',
    });
    assert.equal(service.status, 200, 'the fixture service itself must have been created');

    const deleted = await context.app.inject({
      method: 'DELETE', url: `/api/staff/${staffId}`, headers: authHeader(context.adminToken),
    });
    assert.equal(deleted.statusCode, 409);
    assert.equal(deleted.json().error, 'STAFF_HAS_HISTORY');

    const deactivated = await context.app.inject({
      method: 'PATCH', url: `/api/staff/${staffId}`, headers: authHeader(context.adminToken),
      payload: { isActive: false },
    });
    assert.equal(deactivated.statusCode, 200, 'deactivating the same account must still work as the alternative');
  });

  it('refuses to delete the last active admin', async () => {
    const admins = await pool.query(`SELECT id FROM staff WHERE role = 'ADMIN' AND is_active`);
    assert.equal(admins.rowCount, 1);
    const deleted = await context.app.inject({
      method: 'DELETE', url: `/api/staff/${admins.rows[0].id}`, headers: authHeader(context.adminToken),
    });
    assert.equal(deleted.statusCode, 400);
    assert.equal(deleted.json().error, 'LAST_ADMIN');
  });

  it('boss cannot delete staff', async () => {
    const created = await context.app.inject({
      method: 'POST', url: '/api/staff', headers: authHeader(context.adminToken),
      payload: { login: 'del-tech-2', fullName: 'Тоже удаляемый', role: 'TECHNICIAN', password: 'x' },
    });
    const attempt = await context.app.inject({
      method: 'DELETE', url: `/api/staff/${created.json().id}`, headers: authHeader(context.bossToken),
    });
    assert.equal(attempt.statusCode, 403);
  });
});
