import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth';

export default function LoginScreen() {
  const { login } = useAuth();
  const [loginName, setLoginName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(loginName, password);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form onSubmit={submit}>
        <h1 style={{ marginBottom: 4 }}>Apixspb</h1>
        <p className="muted" style={{ marginTop: 0, marginBottom: 20 }}>
          Мониторинг игровых аппаратов
        </p>

        {error && <div className="alert error">{error}</div>}

        <div className="stack">
          <div>
            <label htmlFor="login">Логин</label>
            <input
              id="login"
              value={loginName}
              autoComplete="username"
              onChange={(event) => setLoginName(event.target.value)}
              required
            />
          </div>
          <div>
            <label htmlFor="password">Пароль</label>
            <input
              id="password"
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </div>
          <button className="primary" type="submit" disabled={busy}>
            {busy ? 'Вход…' : 'Войти'}
          </button>
        </div>
      </form>
    </div>
  );
}
