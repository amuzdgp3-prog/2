import { useState, type FormEvent } from 'react';
import { api } from '../../api';
import { PhotoThumbnail } from '../../components/ui/PhotoLightbox';
import { formatDateTime } from '../../dateFormat';

export interface CounterPhotoReviewRow {
  id: number;
  status: 'MISMATCH' | 'UNREADABLE';
  enteredGames: number;
  enteredPrizes: number | null;
  detectedGames: number | null;
  detectedPrizes: number | null;
  currentGames: number;
  currentPrizes: number;
  machineNumber: string;
  machineAddress: string | null;
  occurredAt: string;
  technicianName: string | null;
  photoObjectKey: string;
}

export function CounterPhotoReview({ row, onResolved, onError }: {
  row: CounterPhotoReviewRow;
  onResolved: (message: string) => void;
  onError: (error: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const [games, setGames] = useState(String(row.currentGames));
  const [prizes, setPrizes] = useState(String(row.currentPrizes));
  const [busy, setBusy] = useState(false);
  const gamesChanged = Number(games) !== row.currentGames;
  const prizesChanged = Number(prizes) !== row.currentPrizes;

  const resolve = async (edit: boolean) => {
    setBusy(true);
    try {
      const patch: { gameCounter?: number; prizeCounter?: number } = {};
      if (edit && gamesChanged) patch.gameCounter = Number(games);
      if (edit && prizesChanged) patch.prizeCounter = Number(prizes);
      if (Object.keys(patch).length) await api.patch(`/api/services/${row.id}`, patch);
      await api.post(`/api/counter-photo-checks/${row.id}/resolve`, {});
      onResolved(Object.keys(patch).length ? 'Показания исправлены' : 'Проверка закрыта');
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    void resolve(true);
  };

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <div>
          <strong>№ {row.machineNumber}</strong>
          {row.machineAddress ? ` — ${row.machineAddress}` : ''}
          <div className="muted">
            {row.technicianName ?? 'техник не указан'} · {formatDateTime(row.occurredAt)}
          </div>
        </div>
        <button type="button" onClick={() => setOpen(!open)}>
          {open ? 'Свернуть' : 'Сверить фото'}
        </button>
      </div>
      <div style={{ color: 'var(--bad)', marginTop: 8 }}>
        {row.status === 'MISMATCH' ? 'Расхождение с фото счётчиков' : 'Не удалось прочитать два показания'}
      </div>
      {open && (
        <form className="stack" onSubmit={save} style={{ marginTop: 12 }}>
          <div className="row" style={{ alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
            <PhotoThumbnail objectKey={row.photoObjectKey} alt="Фото счётчиков" />
            <div className="stack">
              <div>Игры · техник {row.enteredGames} · на фото {row.detectedGames ?? '—'}</div>
              <div>Призы · техник {row.enteredPrizes ?? 'не ввёл'} · на фото {row.detectedPrizes ?? '—'}</div>
            </div>
          </div>
          <div className="grid-2">
            <label>Сохранённый счётчик игр
              <input type="number" min={0} max={Number.MAX_SAFE_INTEGER} required value={games}
                onChange={(event) => setGames(event.target.value)} />
            </label>
            <label>Сохранённый счётчик призов
              <input type="number" min={0} max={Number.MAX_SAFE_INTEGER} required value={prizes}
                onChange={(event) => setPrizes(event.target.value)} />
            </label>
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-primary" disabled={busy || (!gamesChanged && !prizesChanged)}>
              Сохранить показания
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void resolve(false)}>
              Закрыть без правки
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
