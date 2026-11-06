import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatDateTime } from '../dateFormat';

type DeviceSession = {
  id: string;
  deviceLabel: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  current: boolean;
};

function describeDevice(agent: string): string {
  const platform = /iPhone|iPad/.test(agent) ? 'iPhone / iPad'
    : /Android/.test(agent) ? 'Android'
    : /Windows/.test(agent) ? 'Windows'
    : /Macintosh/.test(agent) ? 'Mac' : 'Устройство';
  const browser = /Edg\//.test(agent) ? 'Edge'
    : /Firefox\//.test(agent) ? 'Firefox'
    : /Chrome\//.test(agent) ? 'Chrome'
    : /Safari\//.test(agent) ? 'Safari' : '';
  return browser ? `${platform} · ${browser}` : platform;
}

export default function DeviceSessionsScreen() {
  const [sessions, setSessions] = useState<DeviceSession[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void api.get<DeviceSession[]>('/api/auth/sessions').then((rows) => {
      if (active) setSessions(rows);
    }).catch((caught: Error) => { if (active) setError(caught.message); });
    return () => { active = false; };
  }, []);

  async function revoke(id: string) {
    if (!window.confirm('Завершить сессию на этом устройстве?')) return;
    setBusy(id);
    setError('');
    try {
      await api.delete(`/api/auth/sessions/${id}`);
      setSessions((rows) => rows?.filter((row) => row.id !== id) ?? null);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <h2>Сессии устройств</h2>
      {error && <p className="alert error" role="alert">{error}</p>}
      {!sessions && !error && <p className="muted">Загрузка…</p>}
      {sessions?.length === 0 && <p className="muted">Сессия устройства появится здесь после следующего входа.</p>}
      {sessions?.map((session) => (
        <div className="card card-pad" key={session.id} style={{ marginTop: 10 }}>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <div>
              <b>{describeDevice(session.deviceLabel)}</b>
              {session.current && <span className="muted"> · это устройство</span>}
              <div className="muted">Вход {formatDateTime(session.createdAt)} · активность {formatDateTime(session.lastUsedAt)}</div>
              <div className="muted">До {formatDateTime(session.expiresAt)}</div>
            </div>
            {!session.current && (
              <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={() => void revoke(session.id)}>
                {busy === session.id ? 'Завершаем…' : 'Завершить'}
              </button>
            )}
          </div>
        </div>
      ))}
    </>
  );
}
