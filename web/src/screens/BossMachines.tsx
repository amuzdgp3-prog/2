import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { computeOverdue, formatMoney } from '../calc';
import { MachineTag } from '../components/ui/MachineTag';
import { RoiBadge } from '../components/ui/RoiBadge';

interface BossMachine {
  machine_number: string;
  machine_type: string;
  model: string;
  price_per_game: string;
  counter_divisor: string;
  status: string;
  min_service_days: number | null;
  max_service_days: number | null;
  location_name: string | null;
  address: string | null;
  placement_id: number | null;
  terminal_serial: string | null;
  default_toy_set_name: string | null;
  last_service_at: string | null;
  last_revenue: string | null;
  last_revenue_to_cost_ratio: string | null;
}

/** Аппараты для руководителя: те же сведения, что в карточке администратора (Админ → Аппараты),
 * но только для чтения — без правки, списания, привязки терминала, переноса и обслуживания. */
export default function BossMachinesScreen() {
  const [machines, setMachines] = useState<BossMachine[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<BossMachine[]>('/api/machines').then(setMachines).catch((caught) => setError((caught as Error).message));
  }, []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const active = machines.filter((machine) => machine.status !== 'RETIRED');
    if (!needle) return active;
    return active.filter((machine) =>
      [machine.machine_number, machine.address ?? '', machine.location_name ?? '', machine.machine_type]
        .join(' ')
        .toLowerCase()
        .includes(needle),
    );
  }, [machines, query]);

  return (
    <>
      {error && <div className="alert error">{error}</div>}
      <div className="row" style={{ gap: 8, marginBottom: 12 }}>
        <input
          type="text"
          className="search-big"
          placeholder="Номер или адрес аппарата"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <p className="muted" style={{ marginTop: 0 }}>Показано {filtered.length}</p>

      {filtered.map((machine) => {
        const overdue = computeOverdue(machine);
        const inactive = !machine.placement_id;
        return (
          <div className="card card-pad" key={machine.machine_number} style={inactive ? { opacity: 0.55 } : undefined}>
            <div className="row">
              <MachineTag number={machine.machine_number} />
              <RoiBadge value={machine.last_revenue_to_cost_ratio} />
            </div>
            <div style={{ marginTop: 8, fontWeight: 600, fontSize: 14 }}>
              {machine.address || machine.model || machine.machine_type}
              {inactive && <span className="muted" style={{ fontWeight: 400 }}> · снят с точки</span>}
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
              {machine.location_name ?? 'нет активной установки'} · {machine.machine_type}
            </div>
            <div className="muted mono" style={{ marginTop: 8 }}>
              цена игры {machine.price_per_game} ₽ ·{' '}
              <span className="divisor-tag">коэффициент счётчика {machine.counter_divisor}</span>
              {' · '}статус {machine.status}
            </div>
            <div className="muted" style={{ marginTop: 8 }}>Терминал: {machine.terminal_serial ?? 'не привязан'}</div>
            <div className="muted" style={{ marginTop: 4 }}>
              Набор игрушек: {machine.default_toy_set_name ?? 'не назначен'}
            </div>
            <div className="muted" style={{ marginTop: 4 }}>
              Норма обслуживания: {machine.min_service_days ?? '—'}–{machine.max_service_days ?? '—'} дн.
            </div>
            <div className="mono" style={{ fontSize: 11.5, color: 'var(--ink-faint)', marginTop: 8 }}>
              {machine.last_service_at
                ? `посл. обслуживание — ${overdue.daysSinceService} дн. назад, выручка ${formatMoney(machine.last_revenue ?? '0')} ₽`
                : 'обслуживаний ещё не было'}
              {overdue.isOverdue && (
                <span style={{ color: overdue.severity === 'bad' ? 'var(--bad)' : 'var(--warn)' }}>
                  {' '}· просрочено на {overdue.daysOverdue} дн.
                </span>
              )}
            </div>
            <div style={{ marginTop: 12 }}>
              <Link to={`/history/${encodeURIComponent(machine.machine_number)}`} style={{ textDecoration: 'none' }}>
                <button className="btn btn-ghost">История</button>
              </Link>
            </div>
          </div>
        );
      })}
      {filtered.length === 0 && machines.length > 0 && <p className="muted">По запросу ничего не найдено.</p>}
    </>
  );
}
