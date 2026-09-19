import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { authHeader, bootstrap, type TestContext } from './helpers.js';

/** GET /api/staff: руководитель получает только техников (id, full_name, role) для фильтра журнала. */
describe('staff list for BOSS', () => {
  let context: TestContext;

  before(async () => {
    context = await bootstrap();
  });

  const list = (token: string) =>
    context.app.inject({ method: 'GET', url: '/api/staff', headers: authHeader(token) });

  it('BOSS sees technicians only, without logins', async () => {
    const response = await list(context.bossToken);
    assert.equal(response.statusCode, 200);
    const rows = response.json() as Array<Record<string, unknown>>;
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), ['full_name', 'id', 'role']);
      assert.equal(row.role, 'TECHNICIAN');
    }
  });

  it('ADMIN still gets the full list', async () => {
    const response = await list(context.adminToken);
    assert.equal(response.statusCode, 200);
    const rows = response.json() as Array<Record<string, unknown>>;
    assert.ok(rows.some((row) => row.role === 'ADMIN' && 'login' in row));
  });

  it('TECHNICIAN is still forbidden', async () => {
    assert.equal((await list(context.technicianToken)).statusCode, 403);
  });
});
