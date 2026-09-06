import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MachineTag } from '../components/ui/MachineTag';
import { readOutbox, removeFromOutbox, type QueuedService } from '../db';
import { syncOutbox } from '../sync';

/** Черновики (docs/design/mockups/03_tech_drafts.html): ожидающие отправки и отклонённые сервером. */
export default function QueueScreen({ onChange }: { onChange: () => void }) {
  const [items, setItems] = useState<QueuedService[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = async () => {
    setItems(await readOutbox());
    onChange();
  };

  useEffect(() => {
    void load();
  }, []);

  const send = async () => {
    setBusy(true);
    setMessage(null);
    const result = await syncOutbox();
    setMessage(
      result.offline
        ? `Нет связи. Отправлено ${result.sent}, осталось ${result.remaining}.`
        : `Отправлено: ${result.sent}. Отклонено сервером: ${result.rejected}.`,
    );
    await load();
    setBusy(false);
  };

  const pending = items.filter((item) => item.status === 'PENDING');
  const rejected = items.filter((item) => item.status === 'REJECTED');

  return (
    <>
      <h2 style={{ fontSize: 18, marginBottom: 2 }}>Черновики</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        {items.length === 0
          ? 'нет черновиков'
          : `${items.length} черновик${items.length === 1 ? '' : 'ов'} · ${pending.length} ожидают, ${rejected.length} с ошибкой`}
      </p>

      {message && <div className="alert ok">{message}</div>}

      {pending.length > 0 && (
        <button className="btn btn-primary btn-block" onClick={send} disabled={busy} style={{ marginBottom: 12 }}>
          {busy ? 'Отправка…' : '↑ Синхронизировать все'}
        </button>
      )}

      <div className="stack">
        {pending.map((item) => (
          <div className="card card-pad" key={item.localId}>
            <div className="row">
              <MachineTag number={item.machineNumber} />
              <span className="badge badge-neutral">
                <span className="badge-dot" />
                ожидает
              </span>
            </div>
            <div className="muted mono" style={{ marginTop: 8, fontSize: 11.5 }}>
              создан {new Date(item.queuedAt).toLocaleString('ru-RU')}
            </div>
            <div className="muted mono" style={{ marginTop: 4 }}>
              счётчик {item.gameCounter} · призы {item.prizeCounter} · тест {item.testGames}
            </div>
            <div className="row" style={{ marginTop: 10, gap: 8 }}>
              <Link
                to={`/service/${encodeURIComponent(item.machineNumber)}/${item.localId}`}
                style={{ flex: 1, textDecoration: 'none' }}
              >
                <button className="btn btn-ghost btn-block">Редактировать</button>
              </Link>
              <button
                className="btn btn-danger-ghost"
                onClick={async () => {
                  await removeFromOutbox(item.localId);
                  await load();
                }}
              >
                Удалить
              </button>
            </div>
          </div>
        ))}

        {rejected.map((item) => (
          <div className="card card-pad" key={item.localId}>
            <div className="row">
              <MachineTag number={item.machineNumber} />
              <span className="badge badge-bad">
                <span className="badge-dot" />
                ошибка
              </span>
            </div>
            <div className="muted mono" style={{ marginTop: 8, fontSize: 11.5 }}>
              создан {new Date(item.queuedAt).toLocaleString('ru-RU')}
            </div>
            <div
              style={{
                background: 'var(--bad-soft)',
                color: 'var(--bad)',
                fontSize: 12,
                borderRadius: 'var(--r-sm)',
                padding: '8px 9px',
                marginTop: 8,
              }}
            >
              {item.error}
            </div>
            <div className="row" style={{ marginTop: 10, gap: 8 }}>
              <Link
                to={`/service/${encodeURIComponent(item.machineNumber)}/${item.localId}`}
                style={{ flex: 1, textDecoration: 'none' }}
              >
                <button className="btn btn-ghost btn-block">Редактировать</button>
              </Link>
              <button
                className="btn btn-danger-ghost"
                onClick={async () => {
                  await removeFromOutbox(item.localId);
                  await load();
                }}
              >
                Удалить
              </button>
            </div>
          </div>
        ))}
      </div>

      {items.length === 0 && <p className="muted">Черновиков нет — всё синхронизировано.</p>}
    </>
  );
}
