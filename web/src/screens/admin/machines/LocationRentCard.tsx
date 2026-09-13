import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../../../api';
import { formatMoney } from '../../../calc';
import type { Location, TabProps } from '../types';
import type { RentPeriod } from './types';

export function LocationRentCard({ locationId, onDone, onError }: TabProps & { locationId: number }) {
  const [history, setHistory] = useState<RentPeriod[]>([]);
  const [amount, setAmount] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [showHistory, setShowHistory] = useState(false);

  const load = () => {
    api.get<RentPeriod[]>(`/api/locations/${locationId}/rent`).then(setHistory).catch(onError);
  };
  useEffect(load, [locationId]);

  const current = history.find((p) => p.ended_at === null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api.post(`/api/locations/${locationId}/rent`, {
        monthlyAmount: amount,
        effectiveFrom: new Date(effectiveFrom).toISOString(),
      });
      onDone('Ставка аренды сохранена');
      setAmount('');
      load();
    } catch (caught) {
      onError(caught);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 0, background: 'var(--paper-deep)' }}>
      <div className="muted" style={{ marginBottom: 8 }}>Аренда точки</div>
      <p className="muted" style={{ marginTop: 0 }}>
        Ставка привязана к адресу, а не к этому аппарату — замена аппарата на этом месте её
        унаследует. Новая ставка действует только начиная с указанной даты, прошлые месяцы в
        отчётах не пересчитываются.
      </p>
      <div className="row">
        <div>
          <strong>{current ? `${formatMoney(current.monthly_amount)} ₽/мес` : 'не задана'}</strong>
          {current && <div className="muted" style={{ fontSize: 11 }}>с {new Date(current.started_at).toLocaleDateString('ru-RU')}</div>}
        </div>
        {history.length > 0 && (
          <button type="button" onClick={() => setShowHistory(!showHistory)}>
            {showHistory ? 'Скрыть историю' : `История (${history.length})`}
          </button>
        )}
      </div>

      {showHistory && (
        <div className="stack" style={{ marginTop: 8 }}>
          {history.map((p) => (
            <div className="muted" key={p.id} style={{ fontSize: 12 }}>
              {formatMoney(p.monthly_amount)} ₽/мес: {new Date(p.started_at).toLocaleDateString('ru-RU')}
              {' — '}
              {p.ended_at ? new Date(p.ended_at).toLocaleDateString('ru-RU') : 'по настоящее время'}
            </div>
          ))}
        </div>
      )}

      <form onSubmit={submit} className="grid-2" style={{ marginTop: 10 }}>
        <div>
          <label>Новая ставка, ₽/мес</label>
          <input type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </div>
        <div>
          <label>Действует с</label>
          <input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} required />
        </div>
        <button className="btn btn-primary" type="submit" style={{ gridColumn: '1 / -1' }}>Сохранить ставку</button>
      </form>
    </div>
  );
}

/**
 * Flattens a self-referencing tree (Location's parent_id, or Каталог's classifier parent_id)
 * into a depth-first list for rendering — a plain unordered list becomes unusable once there are
 * many leaf items, because a handful of organisational folders get buried among them. Within each
 * sibling group, nodes that themselves have children (folders) sort before leaves, so structure
 * surfaces at the top of each branch instead of being scattered alphabetically among plain items.
 */
