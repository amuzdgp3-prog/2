import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { authHeader, bootstrap, createStaff, installTestMachine, pool, postService, type TestContext } from './helpers.js';

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

  it('a location tag only reaches the machine currently placed there — it does not travel when the machine moves away', async () => {
    const { locationId } = await installTestMachine(context, { machineNumber: 'CL-6', pricePerGame: 10 });
    const otherLocation = await context.app.inject({
      method: 'POST', url: '/api/locations', headers: authHeader(context.adminToken),
      payload: { name: 'CL-6 elsewhere', timezone: 'Europe/Moscow' },
    });

    const c = await context.app.inject({
      method: 'POST', url: '/api/classifiers', headers: authHeader(context.adminToken), payload: { name: 'CL-6 tag' },
    });
    const classifierId = c.json().id;
    await context.app.inject({
      method: 'POST', url: `/api/classifiers/${classifierId}/locations`, headers: authHeader(context.adminToken),
      payload: { locationId },
    });

    const techId = await createStaff('cl-move-tech', 'TECHNICIAN');
    await context.app.inject({
      method: 'POST', url: '/api/staff/scope', headers: authHeader(context.adminToken),
      payload: { staffId: techId, classifierId },
    });
    const login = await context.app.inject({
      method: 'POST', url: '/api/auth/login', payload: { login: 'cl-move-tech', password: 'secret' },
    });
    const techToken = login.json().token;

    const before1 = await context.app.inject({ method: 'GET', url: '/api/machines', headers: authHeader(techToken) });
    assert.ok(before1.json().some((m: { machine_number: string }) => m.machine_number === 'CL-6'));

    await context.app.inject({
      method: 'POST', url: '/api/machines/CL-6/move', headers: authHeader(context.adminToken),
      payload: { locationId: otherLocation.json().id },
    });

    const after1 = await context.app.inject({ method: 'GET', url: '/api/machines', headers: authHeader(techToken) });
    assert.ok(
      !after1.json().some((m: { machine_number: string }) => m.machine_number === 'CL-6'),
      'the tag stayed on the address, the machine that moved away lost it',
    );
  });

  it('filters /api/reports/financial by a Каталог node, including its subtree', async () => {
    const { locationId } = await installTestMachine(context, { machineNumber: 'CL-7', pricePerGame: 10 });
    await installTestMachine(context, { machineNumber: 'CL-8', pricePerGame: 10 });

    const root = await context.app.inject({
      method: 'POST', url: '/api/classifiers', headers: authHeader(context.adminToken), payload: { name: 'Report-root' },
    });
    const child = await context.app.inject({
      method: 'POST', url: '/api/classifiers', headers: authHeader(context.adminToken),
      payload: { name: 'Report-child', parentId: root.json().id },
    });
    await context.app.inject({
      method: 'POST', url: `/api/classifiers/${child.json().id}/locations`, headers: authHeader(context.adminToken),
      payload: { locationId },
    });

    await postService(context, context.adminToken, 'CL-7', { gameCounter: 10, prizeCounter: 0, occurredAt: new Date().toISOString() });
    await postService(context, context.adminToken, 'CL-8', { gameCounter: 10, prizeCounter: 0, occurredAt: new Date().toISOString() });

    const filtered = await context.app.inject({
      method: 'GET', url: `/api/reports/financial?classifierId=${root.json().id}`, headers: authHeader(context.adminToken),
    });
    const machineNumbers = filtered.json().locations.flatMap(
      (l: { machines: Array<{ machineNumber: string }> }) => l.machines.map((m) => m.machineNumber),
    );
    assert.ok(machineNumbers.includes('CL-7'), 'machine tagged via the child node is included');
    assert.ok(!machineNumbers.includes('CL-8'), 'an unrelated machine is excluded');
  });

  it('is admin-only for creation and membership changes', async () => {
    const denied = await context.app.inject({
      method: 'POST', url: '/api/classifiers', headers: authHeader(context.bossToken), payload: { name: 'x' },
    });
    assert.equal(denied.statusCode, 403);
  });

  it('reaches a location tagged on a descendant node when granted an ancestor (Каталог tree)', async () => {
    const { locationId } = await installTestMachine(context, { machineNumber: 'CL-4', pricePerGame: 10 });

    const root = await context.app.inject({
      method: 'POST', url: '/api/classifiers', headers: authHeader(context.adminToken), payload: { name: 'СПб' },
    });
    const child = await context.app.inject({
      method: 'POST', url: '/api/classifiers', headers: authHeader(context.adminToken),
      payload: { name: 'СПб Юг', parentId: root.json().id },
    });
    await context.app.inject({
      method: 'POST', url: `/api/classifiers/${child.json().id}/locations`, headers: authHeader(context.adminToken),
      payload: { locationId },
    });

    const techId = await createStaff('cl-tree-tech', 'TECHNICIAN');
    await context.app.inject({
      method: 'POST', url: '/api/staff/scope', headers: authHeader(context.adminToken),
      payload: { staffId: techId, classifierId: root.json().id },
    });
    const login = await context.app.inject({
      method: 'POST', url: '/api/auth/login', payload: { login: 'cl-tree-tech', password: 'secret' },
    });
    const machines = await context.app.inject({
      method: 'GET', url: '/api/machines', headers: authHeader(login.json().token),
    });
    assert.ok(
      machines.json().some((m: { machine_number: string }) => m.machine_number === 'CL-4'),
      'a grant on the root reaches a location tagged two levels down',
    );
  });

  it('refuses to move a Каталог node into its own descendant', async () => {
    const root = await context.app.inject({
      method: 'POST', url: '/api/classifiers', headers: authHeader(context.adminToken), payload: { name: 'Root-cycle' },
    });
    const child = await context.app.inject({
      method: 'POST', url: '/api/classifiers', headers: authHeader(context.adminToken),
      payload: { name: 'Child-cycle', parentId: root.json().id },
    });
    const selfParent = await context.app.inject({
      method: 'PATCH', url: `/api/classifiers/${root.json().id}`, headers: authHeader(context.adminToken),
      payload: { parentId: root.json().id },
    });
    assert.equal(selfParent.statusCode, 400);
    assert.equal(selfParent.json().error, 'CLASSIFIER_CYCLE');

    const intoOwnChild = await context.app.inject({
      method: 'PATCH', url: `/api/classifiers/${root.json().id}`, headers: authHeader(context.adminToken),
      payload: { parentId: child.json().id },
    });
    assert.equal(intoOwnChild.statusCode, 400);
    assert.equal(intoOwnChild.json().error, 'CLASSIFIER_CYCLE');
  });

  it('refuses to delete a Каталог node that still has children', async () => {
    const root = await context.app.inject({
      method: 'POST', url: '/api/classifiers', headers: authHeader(context.adminToken), payload: { name: 'Root-delete' },
    });
    await context.app.inject({
      method: 'POST', url: '/api/classifiers', headers: authHeader(context.adminToken),
      payload: { name: 'Child-delete', parentId: root.json().id },
    });
    const deleted = await context.app.inject({
      method: 'DELETE', url: `/api/classifiers/${root.json().id}`, headers: authHeader(context.adminToken),
    });
    assert.equal(deleted.statusCode, 409);
    assert.equal(deleted.json().error, 'CLASSIFIER_HAS_CHILDREN');
  });

  it('tags a machine directly, independent of its address', async () => {
    await installTestMachine(context, { machineNumber: 'CL-5', pricePerGame: 10 });
    const c = await context.app.inject({
      method: 'POST', url: '/api/classifiers', headers: authHeader(context.adminToken), payload: { name: 'Прищепки' },
    });
    const classifierId = c.json().id;
    await context.app.inject({
      method: 'POST', url: `/api/classifiers/${classifierId}/machines`, headers: authHeader(context.adminToken),
      payload: { machineNumber: 'CL-5' },
    });

    const techId = await createStaff('cl-direct-tech', 'TECHNICIAN');
    await context.app.inject({
      method: 'POST', url: '/api/staff/scope', headers: authHeader(context.adminToken),
      payload: { staffId: techId, classifierId },
    });
    const login = await context.app.inject({
      method: 'POST', url: '/api/auth/login', payload: { login: 'cl-direct-tech', password: 'secret' },
    });
    const machines = await context.app.inject({
      method: 'GET', url: '/api/machines', headers: authHeader(login.json().token),
    });
    assert.ok(
      machines.json().some((m: { machine_number: string }) => m.machine_number === 'CL-5'),
      'a direct machine tag makes it reachable with no location tag at all',
    );

    const removed = await context.app.inject({
      method: 'DELETE', url: `/api/classifiers/${classifierId}/machines`, headers: authHeader(context.adminToken),
      payload: { machineNumber: 'CL-5' },
    });
    assert.equal(removed.statusCode, 200);
    const afterRemove = await context.app.inject({
      method: 'GET', url: '/api/machines', headers: authHeader(login.json().token),
    });
    assert.ok(!afterRemove.json().some((m: { machine_number: string }) => m.machine_number === 'CL-5'));
  });
});

describe('BOSS scoping — unrestricted until a Каталог grant exists', () => {
  let context: TestContext;

  before(async () => {
    context = await bootstrap();
  });

  after(async () => {
    await context.app.close();
  });

  it('an ungranted BOSS sees every machine (backward compatible default)', async () => {
    await installTestMachine(context, { machineNumber: 'BOSS-1', pricePerGame: 10 });
    const machines = await context.app.inject({
      method: 'GET', url: '/api/machines', headers: authHeader(context.bossToken),
    });
    assert.ok(machines.json().some((m: { machine_number: string }) => m.machine_number === 'BOSS-1'));
  });

  it('granting a BOSS one Каталог node narrows them to only its subtree', async () => {
    const { id: bossId } = (await pool.query<{ id: number }>(`SELECT id FROM staff WHERE login = 'boss'`)).rows[0];

    const { locationId } = await installTestMachine(context, { machineNumber: 'BOSS-2', pricePerGame: 10 });
    await installTestMachine(context, { machineNumber: 'BOSS-3', pricePerGame: 10 });

    const region = await context.app.inject({
      method: 'POST', url: '/api/classifiers', headers: authHeader(context.adminToken), payload: { name: 'Астрахань' },
    });
    await context.app.inject({
      method: 'POST', url: `/api/classifiers/${region.json().id}/locations`, headers: authHeader(context.adminToken),
      payload: { locationId },
    });
    await context.app.inject({
      method: 'POST', url: '/api/staff/scope', headers: authHeader(context.adminToken),
      payload: { staffId: bossId, classifierId: region.json().id },
    });

    const machines = await context.app.inject({
      method: 'GET', url: '/api/machines', headers: authHeader(context.bossToken),
    });
    const numbers = machines.json().map((m: { machine_number: string }) => m.machine_number);
    assert.ok(numbers.includes('BOSS-2'), 'granted region machine is visible');
    assert.ok(!numbers.includes('BOSS-3'), 'a machine outside the granted region is no longer visible');

    await context.app.inject({
      method: 'DELETE', url: '/api/staff/scope', headers: authHeader(context.adminToken),
      payload: { staffId: bossId, classifierId: region.json().id },
    });
    const afterRevoke = await context.app.inject({
      method: 'GET', url: '/api/machines', headers: authHeader(context.bossToken),
    });
    assert.ok(
      afterRevoke.json().some((m: { machine_number: string }) => m.machine_number === 'BOSS-3'),
      'revoking the last grant restores full visibility',
    );
  });
});
