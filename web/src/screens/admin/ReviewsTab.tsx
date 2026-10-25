import { useEffect, useState } from 'react';
import { api, getToken } from '../../api';
import { PhotoThumbnail } from '../../components/ui/PhotoLightbox';
import {
  describeChange,
  type ReviewDetail,
  type ReviewListItem,
  type ReviewStatus,
} from '../../serviceReviews';
import type { TabProps, Toy } from './types';

/**
 * Обслуживания на проверке у администратора (DECISION-086). Сюда попадает всё, что сервер не
 * принял от техника по сути записи: счётчик назад, скачок, аппарат не установлен и т.п. Техника
 * больше не нужно обзванивать — запись исправляется и сохраняется здесь, визит засчитывается ему.
 */
export function ReviewsTab({ onDone, onError }: TabProps) {
  const [status, setStatus] = useState<ReviewStatus>('PENDING');
  const [rows, setRows] = useState<ReviewListItem[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [toys, setToys] = useState<Toy[]>([]);

  const load = () => {
    api.get<ReviewListItem[]>(`/api/service-reviews?status=${status}`).then(setRows).catch(onError);
  };
  useEffect(load, [status]);
  useEffect(() => {
    api.get<Toy[]>('/api/toys').then(setToys).catch(() => setToys([]));
  }, []);

  const resolved = (message: string) => {
    onDone(message);
    setOpenId(null);
    load();
  };

  return (
    <>
      <div className="tabs">
        {(['PENDING', 'APPROVED', 'REJECTED'] as const).map((value) => (
          <button
            key={value}
            className={status === value ? 'active' : ''}
            onClick={() => {
              setStatus(value);
              setOpenId(null);
            }}
          >
            {value === 'PENDING' ? 'Ждут проверки' : value === 'APPROVED' ? 'Сохранённые' : 'Отклонённые'}
          </button>
        ))}
      </div>

      {rows.length === 0 && (
        <div className="card muted">
          {status === 'PENDING' ? 'Записей на проверке нет.' : 'Пока пусто.'}
        </div>
      )}

      {rows.map((row) => (
        <div className="card" key={row.localId}>
          <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <div>
              <strong>№ {row.machineNumber}</strong>
              {row.machineAddress ? ` — ${row.machineAddress}` : ''}
              <div className="muted">
                {row.technicianName ?? 'техник не указан'} · {new Date(row.occurredAt).toLocaleString('ru-RU')}
              </div>
            </div>
            {status === 'PENDING' && (
              <button onClick={() => setOpenId(openId === row.localId ? null : row.localId)}>
                {openId === row.localId ? 'Свернуть' : 'Разобрать'}
              </button>
            )}
          </div>
          <div style={{ marginTop: 8, color: 'var(--bad)', fontSize: 13 }}>{row.errorMessage}</div>
          {status !== 'PENDING' && <ResolvedSummary row={row} />}
          {openId === row.localId && (
            <ReviewEditor localId={row.localId} toys={toys} onResolved={resolved} onError={onError} />
          )}
        </div>
      ))}
    </>
  );
}

function ResolvedSummary({ row }: { row: ReviewListItem }) {
  return (
    <div style={{ marginTop: 8, fontSize: 13 }}>
      <div className="muted">
        {row.status === 'APPROVED' ? 'Сохранено' : 'Отклонено'}
        {row.resolvedByName ? ` · ${row.resolvedByName}` : ''}
        {row.resolvedAt ? ` · ${new Date(row.resolvedAt).toLocaleString('ru-RU')}` : ''}
      </div>
      {row.changes.length > 0 && (
        <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
          {row.changes.map((change) => <li key={change.field}>{describeChange(change)}</li>)}
        </ul>
      )}
      {row.adminComment && <div style={{ marginTop: 4 }}>{row.adminComment}</div>}
    </div>
  );
}

/** ISO → дата и время для <input type="date"> и <input type="time"> в часовом поясе браузера. */
const toLocalInputs = (iso: string) => {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  };
};

interface EditorForm {
  date: string;
  time: string;
  gameCounter: string;
  prizeCounter: string;
  testGames: string;
  notes: string;
  toys: Array<{ toyId: number; quantity: string }>;
  comment: string;
  confirmCounterJump: boolean;
  confirmPrizeCounterBack: boolean;
}

function ReviewEditor({
  localId,
  toys,
  onResolved,
  onError,
}: {
  localId: string;
  toys: Toy[];
  onResolved: (message: string) => void;
  onError: (error: unknown) => void;
}) {
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [form, setForm] = useState<EditorForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<ReviewDetail>(`/api/service-reviews/${localId}`)
      .then((loaded) => {
        setDetail(loaded);
        const sent = loaded.payload;
        setForm({
          ...toLocalInputs(sent.occurredAt),
          gameCounter: String(sent.gameCounter),
          prizeCounter: String(sent.prizeCounter),
          testGames: String(sent.testGames ?? 0),
          notes: sent.notes ?? '',
          toys: (sent.toys ?? []).map((line) => ({ toyId: line.toyId, quantity: String(line.quantity) })),
          comment: '',
          confirmCounterJump: false,
          confirmPrizeCounterBack: false,
        });
      })
      .catch(onError);
  }, [localId]);

  if (!detail || !form) return <div className="muted" style={{ marginTop: 10 }}>Загрузка…</div>;

  const toyName = (id: number) => toys.find((toy) => toy.id === id)?.name ?? `игрушка № ${id}`;

  const approve = async () => {
    setBusy(true);
    setSaveError(null);
    try {
      await api.post(`/api/service-reviews/${localId}/approve`, {
        occurredAt: new Date(`${form.date}T${form.time}`).toISOString(),
        gameCounter: Number(form.gameCounter),
        prizeCounter: Number(form.prizeCounter),
        testGames: Number(form.testGames) || 0,
        notes: form.notes,
        toys: form.toys
          .filter((line) => Number(line.quantity) > 0)
          .map((line) => ({ toyId: line.toyId, quantity: Number(line.quantity) })),
        comment: form.comment || undefined,
        ...(form.confirmCounterJump ? { confirmCounterJump: true } : {}),
        ...(form.confirmPrizeCounterBack ? { confirmPrizeCounterBack: true } : {}),
      });
      onResolved('Обслуживание сохранено, техник увидит итог у себя');
    } catch (caught) {
      // Отказ показывается прямо в форме: запись остаётся на проверке, можно поправить и повторить.
      setSaveError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    if (!form.comment.trim()) {
      setSaveError('Чтобы отклонить, напишите причину в поле «Комментарий» — её увидит техник.');
      return;
    }
    if (!confirm('Отклонить запись? Обслуживание не будет сохранено.')) return;
    setBusy(true);
    setSaveError(null);
    try {
      await api.post(`/api/service-reviews/${localId}/reject`, { comment: form.comment });
      onResolved('Запись отклонена');
    } catch (caught) {
      setSaveError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm('Удалить запись без следа? Обслуживание не сохранится, техник эту запись не увидит.')) return;
    setBusy(true);
    setSaveError(null);
    try {
      await api.delete(`/api/service-reviews/${localId}`);
      onResolved('Запись удалена');
    } catch (caught) {
      setSaveError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack" style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
      <div className="row" style={{ gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <PhotoThumbnail src={`/api/photos/${detail.photoObjectKey}?token=${getToken() ?? ''}`} alt="Фото счётчика" />
        <div className="muted" style={{ fontSize: 12.5, flex: 1, minWidth: 180 }}>
          Прислал техник: счётчик игр {detail.payload.gameCounter}, призов {detail.payload.prizeCounter},
          тестовых {detail.payload.testGames ?? 0}. Сверьте с фото и поправьте, что нужно. Если дело в
          установке аппарата (не установлен, точка не активна, дата раньше установки) — сначала
          поправьте её на вкладке «Аппараты», потом сохраните здесь.
        </div>
      </div>

      <div className="grid-2">
        <div>
          <label>Дата визита</label>
          <input
            type="date"
            value={form.date}
            onChange={(event) => setForm({ ...form, date: event.target.value })}
          />
        </div>
        <div>
          <label>Время</label>
          <input
            type="time"
            value={form.time}
            onChange={(event) => setForm({ ...form, time: event.target.value })}
          />
        </div>
        <div>
          <label>Тестовые игры</label>
          <input
            type="number"
            min={0}
            value={form.testGames}
            onChange={(event) => setForm({ ...form, testGames: event.target.value })}
          />
        </div>
        <div>
          <label>Счётчик игр</label>
          <input
            type="number"
            min={0}
            value={form.gameCounter}
            onChange={(event) => setForm({ ...form, gameCounter: event.target.value })}
          />
        </div>
        <div>
          <label>Счётчик призов</label>
          <input
            type="number"
            min={0}
            value={form.prizeCounter}
            onChange={(event) => setForm({ ...form, prizeCounter: event.target.value })}
          />
        </div>
      </div>

      {form.toys.length > 0 && (
        <div>
          <label>Игрушки</label>
          {form.toys.map((line, index) => (
            <div className="row" key={line.toyId} style={{ gap: 8, marginTop: 4 }}>
              <span style={{ flex: 1 }}>{toyName(line.toyId)}</span>
              <input
                type="number"
                min={0}
                style={{ width: 90 }}
                value={line.quantity}
                onChange={(event) => {
                  const next = [...form.toys];
                  next[index] = { ...line, quantity: event.target.value };
                  setForm({ ...form, toys: next });
                }}
              />
            </div>
          ))}
        </div>
      )}

      <div>
        <label>Заметка техника</label>
        <input type="text" value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} />
      </div>

      {detail.errorCode === 'COUNTER_JUMP_SUSPECTED' && (
        <label className="row" style={{ gap: 8 }}>
          <input
            type="checkbox"
            checked={form.confirmCounterJump}
            onChange={(event) => setForm({ ...form, confirmCounterJump: event.target.checked })}
          />
          Показание проверено по фото — скачок настоящий
        </label>
      )}
      {detail.errorCode === 'PRIZE_COUNTER_WENT_BACK' && (
        <label className="row" style={{ gap: 8 }}>
          <input
            type="checkbox"
            checked={form.confirmPrizeCounterBack}
            onChange={(event) => setForm({ ...form, confirmPrizeCounterBack: event.target.checked })}
          />
          Сохранить с откатом счётчика призов как есть
        </label>
      )}

      <div>
        <label>Комментарий для техника</label>
        <input
          type="text"
          value={form.comment}
          placeholder="необязательно при сохранении, обязательно при отклонении"
          onChange={(event) => setForm({ ...form, comment: event.target.value })}
        />
      </div>

      {saveError && <div className="alert error">{saveError}</div>}

      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button className="primary" disabled={busy} onClick={approve}>
          {busy ? 'Сохранение…' : 'Сохранить обслуживание'}
        </button>
        <button disabled={busy} onClick={reject}>Отклонить</button>
        <button disabled={busy} onClick={remove} title="Для записей, где исправлять нечего: например, техник перепутал аппарат">
          Удалить
        </button>
      </div>
    </div>
  );
}
