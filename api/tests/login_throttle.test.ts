import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bootstrap, type TestContext } from './helpers.js';

/**
 * Ограничение неудачных попыток входа (DECISION-043). Ключ — логин, считаются только неудачи,
 * успешный вход сбрасывает счётчик. Состояние живёт в памяти процесса, а раннер Node изолирует
 * каждый тестовый файл в свой процесс, поэтому этот файл не влияет на остальные.
 */
describe('вход: ограничение неудачных попыток', () => {
  let context: TestContext;

  before(async () => {
    context = await bootstrap();
  });

  after(async () => {
    await context.app.close();
  });

  const login = (user: string, password: string) =>
    context.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: user, password } });

  it('после 10 неудачных попыток даже верный пароль отклоняется с 429', async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      assert.equal((await login('tech', 'wrong')).statusCode, 401);
    }
    const blocked = await login('tech', 'secret');
    assert.equal(blocked.statusCode, 429, blocked.body);
    assert.match(blocked.json().message, /слишком много неудачных попыток/);
  });

  it('блокировка одного логина не мешает входить другим сотрудникам', async () => {
    assert.equal((await login('boss', 'secret')).statusCode, 200);
  });

  it('успешный вход сбрасывает счётчик неудач', async () => {
    for (let round = 0; round < 2; round += 1) {
      for (let attempt = 0; attempt < 9; attempt += 1) {
        assert.equal((await login('admin', 'wrong')).statusCode, 401);
      }
      assert.equal((await login('admin', 'secret')).statusCode, 200);
    }
  });
});
