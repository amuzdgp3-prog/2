import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { authHeader, bootstrap, createStaff, installTestMachine, type TestContext } from './helpers.js';

/**
 * A classifier is a plain many-to-many tag on Location, independent of the parent_id tree: the
 * owner wants to group the same address under several unrelated labels at once (e.g. a geographic
 * one and, say, a venue-type one that spans several geographic branches) — something a single-
 * parent tree structurally cannot express. Added after a real production report: moving a
 * technician's territory grant onto a Location subtree kept forcing every reassigned address into
 * one tree, silently turning "reclassify" into "the machine physically moved."
 */
describe('classifiers — grouping locations independently of the parent_id tree', () => {
  let context: TestContext;

  before(async () => {
    context = await bootstrap();
  });

  after(async () => {
    await context.app.close();
  });

  it('makes a machine reachable to a technician granted the classifier, without touching the location tree', async () => {
    const { locationId } = await installTestMachine(context, { machineNumber: 'CL-1', pricePerGame: 10 });

    const created = await context.app.inject({
      method: 'POST', url: '/api/classifiers', headers: authHeader(context.adminToken),
      payload: { name: 'Торговые центры' },
    });
    assert.equal(created.statusCode, 200);
    const classifierId = created.json().id;

    await context.app.inject({
      method: 'POST', url: `/api/classifiers/${classifierId}/locations`, headers: authHeader(context.adminToken),
      payload: { locationId },
    });

    const techId = await createStaff('cl-tech', 'TECHNICIAN');
    const login = await context.app.inject({
      method: 'POST', url: '/api/auth/login', payload: { login: 'cl-tech', password: 'secret' },
    });
    const techToken = login.json().token;

    const before1 = await context.app.inject({ method: 'GET', url: '/api/machines', headers: authHeader(techToken) });
    assert.ok(!before1.json().some((m: { machine_number: string }) => m.machine_number === 'CL-1'), 'not visible before the grant');

    await context.app.inject({
      method: 'POST', url: '/api/staff/scope', headers: authHeader(context.adminToken),
      payload: { staffId: techId, classifierId },
    });

    const after1 = await context.app.inject({ method: 'GET', url: '/api/machines', headers: authHeader(techToken) });
    assert.ok(after1.json().some((m: { machine_number: string }) => m.machine_number === 'CL-1'), 'visible once granted the classifier');

    const scopeView = await context.app.inject({
      method: 'GET', url: `/api/staff/${techId}/scope`, headers: authHeader(context.adminToken),
    });
    assert.ok(scopeView.json().classifiers.some((c: { id: number }) => c.id === classifierId));
    assert.ok(scopeView.json().reachableMachines.includes('CL-1'));
  });

  it('lets one location carry more than one classifier at once', async () => {
    const { locationId } = await installTestMachine(context, { machineNumber: 'CL-2', pricePerGame: 10 });
    const a = await context.app.inject({
      method: 'POST', url: '/api/classifiers', headers: authHeader(context.adminToken), payload: { name: 'Юг' },
    });
    const b = await context.app.inject({
      method: 'POST', url: '/api/classifiers', headers: authHeader(context.adminToken), payload: { name: 'ТЦ' },
    });
    await context.app.inject({
      method: 'POST', url: `/api/classifiers/${a.json().id}/locations`, headers: authHeader(context.adminToken),
      payload: { locationId },
    });
    await context.app.inject({
      method: 'POST', url: `/api/classifiers/${b.json().id}/locations`, headers: authHeader(context.adminToken),
      payload: { locationId },
    });

    const list = await context.app.inject({ method: 'GET', url: '/api/classifiers', headers: authHeader(context.adminToken) });
    const byName = Object.fromEntries(list.json().map((c: { name: string; locations: unknown[] }) => [c.name, c.locations]));
    assert.equal(byName['Юг'].length, 1);
    assert.equal(byName['ТЦ'].length, 1);
  });

  it('revoking a classifier grant removes reachability again', async () => {
    const { locationId } = await installTestMachine(context, { machineNumber: 'CL-3', pricePerGame: 10 });
    const c = await context.app.inject({
      method: 'POST', url: '/api/classifiers', headers: authHeader(context.adminToken), payload: { name: 'Revoke test' },
    });
    const classifierId = c.json().id;
    await context.app.inject({
      method: 'POST', url: `/api/classifiers/${classifierId}/locations`, headers: authHeader(context.adminToken),
      payload: { locationId },
    });
    const techId = await createStaff('cl-tech-2', 'TECHNICIAN');
    await context.app.inject({
      method: 'POST', url: '/api/staff/scope', headers: authHeader(context.adminToken),
      payload: { staffId: techId, classifierId },
    });
    const login = await context.app.inject({
      method: 'POST', url: '/api/auth/login', payload: { login: 'cl-tech-2', password: 'secret' },
    });
    const techToken = login.json().token;
    const before1 = await context.app.inject({ method: 'GET', url: '/api/machines', headers: authHeader(techToken) });
    assert.ok(before1.json().some((m: { machine_number: string }) => m.machine_number === 'CL-3'));

    await context.app.inject({
      method: 'DELETE', url: '/api/staff/scope', headers: authHeader(context.adminToken),
      payload: { staffId: techId, classifierId },
    });
    const after1 = await context.app.inject({ method: 'GET', url: '/api/machines', headers: authHeader(techToken) });
    assert.ok(!after1.json().some((m: { machine_number: string }) => m.machine_number === 'CL-3'));
  });

  it('is admin-only for creation and membership changes', async () => {
    const denied = await context.app.inject({
      method: 'POST', url: '/api/classifiers', headers: authHeader(context.bossToken), payload: { name: 'x' },
    });
    assert.equal(denied.statusCode, 403);
  });
});
