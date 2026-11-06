import assert from 'node:assert/strict';
import { after, before, it } from 'node:test';
import { authHeader, bootstrap, pool, type TestContext } from './helpers.js';

const { config } = await import('../src/config.js');
let context: TestContext;
before(async () => { context = await bootstrap(); });
after(async () => { await context?.app.close(); await pool.end(); });

async function deviceLogin(login: string, cookie?: string) {
  const response = await context.app.inject({
    method: 'POST', url: '/api/auth/login',
    headers: { origin: config.publicOrigin, 'user-agent': 'Test device', ...(cookie ? { cookie } : {}) },
    payload: { login, password: 'secret', deviceSession: true },
  });
  assert.equal(response.statusCode, 200, response.body);
  const setCookie = String(response.headers['set-cookie']);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  assert.match(setCookie, /Max-Age=15552000/i);
  if (process.env.NODE_ENV === 'production') assert.match(setCookie, /Secure/i);
  const { token, user, deviceSession } = response.json();
  assert.equal(deviceSession, true);
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  assert.equal(claims.exp - claims.iat, 900);
  return { token: token as string, user, cookie: setCookie.split(';')[0], sid: claims.sid as string };
}

const refresh = (cookie: string, origin = config.publicOrigin) => context.app.inject({
  method: 'POST', url: '/api/auth/refresh', headers: { cookie, origin },
});
const me = (token: string) => context.app.inject({ url: '/api/auth/me', headers: authHeader(token) });

it('keeps devices independent and revokes only the selected device', async () => {
  const first = await deviceLogin('tech');
  const second = await deviceLogin('tech');
  assert.notEqual(first.sid, second.sid);
  assert.notEqual(first.cookie, second.cookie);
  const sessions = await context.app.inject({ url: '/api/auth/sessions', headers: authHeader(first.token) });
  assert.equal(sessions.statusCode, 200);
  assert.equal(sessions.json().length, 2);
  assert.equal(sessions.json().find((session: { id: string }) => session.id === first.sid).current, true);

  const foreign = await context.app.inject({
    method: 'DELETE', url: `/api/auth/sessions/${first.sid}`, headers: authHeader(context.bossToken),
  });
  assert.equal(foreign.statusCode, 204);
  assert.equal((await me(first.token)).statusCode, 200);

  const refreshed = await refresh(first.cookie);
  assert.equal(refreshed.statusCode, 200);
  assert.equal(String(refreshed.json().userId), String(first.user.id));
  assert.equal((await refresh(first.cookie, 'https://audit.invalid')).statusCode, 403);

  const revoke = await context.app.inject({
    method: 'DELETE', url: `/api/auth/sessions/${second.sid}`, headers: authHeader(first.token),
  });
  assert.equal(revoke.statusCode, 204);
  assert.equal((await refresh(second.cookie)).statusCode, 401);
  assert.equal((await me(second.token)).statusCode, 401);
  assert.equal((await me(first.token)).statusCode, 200);

  const signedOut = await context.app.inject({
    method: 'POST', url: '/api/auth/logout', headers: { cookie: first.cookie, origin: config.publicOrigin },
  });
  assert.equal(signedOut.statusCode, 204);
  assert.equal((await refresh(first.cookie)).statusCode, 401);
});

it('supports a staged cutoff of old access tokens while keeping automation login', async () => {
  const original = config.acceptLegacySessions;
  config.acceptLegacySessions = false;
  try {
    assert.equal((await me(context.adminToken)).statusCode, 401);
    const cli = await context.app.inject({
      method: 'POST', url: '/api/auth/login', payload: { login: 'admin', password: 'secret' },
    });
    assert.equal(cli.statusCode, 200);
    const claims = JSON.parse(Buffer.from(cli.json().token.split('.')[1], 'base64url').toString());
    assert.equal(claims.exp - claims.iat, 900);
    assert.equal((await me(cli.json().token)).statusCode, 200);
    const device = await deviceLogin('tech');
    assert.equal((await me(device.token)).statusCode, 200);
  } finally {
    config.acceptLegacySessions = original;
  }
});
