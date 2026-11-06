import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bootstrap, type TestContext } from './helpers.js';
import { assertLoginAllowed, recordLoginFailure } from '../src/lib/loginThrottle.js';

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

  it('после серии ошибок возвращает 429 и Retry-After', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await login('tech', 'wrong')).statusCode, 401);
    }
    const blocked = await login('tech', 'secret');
    assert.equal(blocked.statusCode, 429, blocked.body);
    assert.match(blocked.json().message, /слишком много неудачных попыток/);
    assert.equal(blocked.headers['retry-after'], '1');
  });

  it('увеличивает паузу, а после десяти ошибок держит блокировку до конца окна', () => {
    const now = Date.now();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const time = now + attempt * 35_000;
      assert.doesNotThrow(() => assertLoginAllowed('test-backoff', time));
      recordLoginFailure('test-backoff', time);
      if (attempt === 5) assert.throws(() => assertLoginAllowed('test-backoff', time + 1500), /через 1 сек/);
    }
    assert.throws(() => assertLoginAllowed('test-backoff', now + 600_000), /слишком много/);
    assert.doesNotThrow(() => assertLoginAllowed('test-backoff', now + 900_001));
  });

  it('блокировка одного логина не мешает входить другим сотрудникам', async () => {
    assert.equal((await login('boss', 'secret')).statusCode, 200);
  });

  it('успешный вход сбрасывает счётчик неудач', async () => {
    for (let round = 0; round < 2; round += 1) {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        assert.equal((await login('admin', 'wrong')).statusCode, 401);
      }
      assert.equal((await login('admin', 'secret')).statusCode, 200);
    }
  });
});
