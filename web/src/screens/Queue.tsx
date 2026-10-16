import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MachineTag } from '../components/ui/MachineTag';
import { readOutbox, removeFromOutbox, type QueuedService } from '../db';
import { syncOutbox } from '../sync';
import { api } from '../api';
import { describeChange, type MyReviewItem } from '../serviceReviews';

/**
 * Черновики (docs/design/mockups/03_tech_drafts.html): ожидающие отправки и отклонённые сервером,
 * а ниже — записи на проверке у администратора и итог их разбора (DECISION-086).
 */
export default function QueueScreen({ onChange }: { onChange: () => void }) {
  const [items, setItems] = useState<QueuedService[]>([]);
  const [reviews, setReviews] = useState<MyReviewItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = async () => {
    setItems(await readOutbox());
    onChange();
    // Без связи список проверки просто не обновляется — черновики выше от него не зависят.
    try {
      setReviews(await api.get<MyReviewItem[]>('/api/service-reviews/mine'));
    } catch {
      /* офлайн или сессия истекла — оставляем то, что было */
    }
  };

  const markSeen = async (localId: string) => {
    await api.post(`/api/service-reviews/${localId}/seen`, {}).catch(() => undefined);
    setReviews((current) => current.filter((review) => review.localId !== localId));
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
        : [
            `Отправлено: ${result.sent}.`,
            result.inReview.length ? `Из них на проверку администратору: ${result.inReview.length}.` : '',
            result.rejected ? `Отклонено сервером: ${result.rejected}.` : '',
          ].filter(Boolean).join(' '),
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
                  // Черновик удалён самим техником — снимаем жалобу у администратора, иначе он
                  // будет разбираться с проблемой, которой уже нет.
                  await api.delete(`/api/draft-issues/${item.localId}`).catch(() => undefined);
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
                  // Черновик удалён самим техником — снимаем жалобу у администратора, иначе он
                  // будет разбираться с проблемой, которой уже нет.
                  await api.delete(`/api/draft-issues/${item.localId}`).catch(() => undefined);
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

      {reviews.length > 0 && (
        <>
          <h3 style={{ fontSize: 15, margin: '20px 0 8px' }}>На проверке у администратора</h3>
          <div className="stack">
            {reviews.map((review) => (
              <ReviewCard key={review.localId} review={review} onSeen={() => void markSeen(review.localId)} />
            ))}
          </div>
        </>
      )}
    </>
  );
}

function ReviewCard({ review, onSeen }: { review: MyReviewItem; onSeen: () => void }) {
  const badge =
    review.status === 'PENDING'
      ? { className: 'badge-warn', text: 'ждёт проверки' }
      : review.status === 'APPROVED'
        ? { className: 'badge-good', text: review.changes.length ? 'исправлено и сохранено' : 'сохранено' }
        : { className: 'badge-bad', text: 'отклонено' };

  return (
    <div className="card card-pad">
      <div className="row">
        <MachineTag number={review.machineNumber} />
        <span className={`badge ${badge.className}`}>
          <span className="badge-dot" />
          {badge.text}
        </span>
      </div>
      <div className="muted mono" style={{ marginTop: 8, fontSize: 11.5 }}>
        {review.machineAddress ? `${review.machineAddress} · ` : ''}
        {new Date(review.occurredAt).toLocaleString('ru-RU')}
      </div>
      {review.status === 'PENDING' && (
        // Причину отказа технику намеренно не показываем: она написана как указание «проверьте
        // цифру», а делать ему как раз ничего не нужно — разбирает администратор.
        <div className="muted" style={{ marginTop: 6, fontSize: 12.5 }}>
          Администратор проверит запись — ничего делать не нужно.
        </div>
      )}
      {review.changes.length > 0 && (
        <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13 }}>
          {review.changes.map((change) => (
            <li key={change.field}>{describeChange(change)}</li>
          ))}
        </ul>
      )}
      {review.adminComment && (
        <div style={{ marginTop: 8, fontSize: 13 }}>
          <span className="muted">Комментарий администратора:</span> {review.adminComment}
        </div>
      )}
      {review.status !== 'PENDING' && (
        <button className="btn btn-ghost btn-block" style={{ marginTop: 10 }} onClick={onSeen}>
          Понятно
        </button>
      )}
    </div>
  );
}
