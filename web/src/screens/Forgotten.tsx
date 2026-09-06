import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { computeOverdue } from '../calc';
import { MachineTag } from '../components/ui/MachineTag';
import { readCachedMachines, type CachedMachine } from '../db';

/**
 * Забытые аппараты (docs/design/mockups/04_tech_forgotten.html): только просроченные,
 * отсортированы по величине просрочки. Данные — из локального кэша аппаратов, тот же
 * источник, что и список на главном экране, так что экран работает и без сети.
 */
export default function ForgottenScreen() {
  const [machines, setMachines] = useState<CachedMachine[]>([]);

  useEffect(() => {
    void readCachedMachines().then(setMachines);
  }, []);

  const overdue = useMemo(
    () =>
      machines
        .map((machine) => ({ machine, info: computeOverdue(machine) }))
        .filter((row) => row.info.isOverdue)
        .sort((a, b) => (b.info.daysOverdue ?? 0) - (a.info.daysOverdue ?? 0)),
    [machines],
  );

  return (
    <>
      <div className="row" style={{ marginBottom: 4 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Забытые аппараты</h2>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        {overdue.length === 0
          ? 'просроченных нет'
          : `просрочено: ${overdue.length} · сортировка по дням просрочки`}
      </p>

      {overdue.length === 0 && (
        <div className="card card-pad" style={{ textAlign: 'center', padding: '48px 20px' }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>✓</div>
          <div className="muted">Все аппараты обслужены вовремя</div>
        </div>
      )}

      <div className="stack">
        {overdue.map(({ machine, info }) => (
          <Link
            key={machine.machine_number}
            to={`/service/${encodeURIComponent(machine.machine_number)}`}
            style={{ textDecoration: 'none', color: 'inherit' }}
          >
            <div
              className="card card-pad"
              style={{ borderLeft: `4px solid ${info.severity === 'bad' ? 'var(--bad)' : 'var(--warn)'}` }}
            >
              <div className="row">
                <div style={{ fontWeight: 600, fontSize: 14 }}>{machine.model || machine.machine_type}</div>
                <div
                  className="mono"
                  style={{ fontWeight: 700, fontSize: 15, color: info.severity === 'bad' ? 'var(--bad)' : 'var(--warn)' }}
                >
                  +{info.daysOverdue} дн.
                </div>
              </div>
              <div style={{ marginTop: 6 }}>
                <MachineTag number={machine.machine_number} />
              </div>
              <div className="mono muted" style={{ fontSize: 11.5, marginTop: 6 }}>
                посл. обслуживание {info.daysSinceService} дн. назад · максимум {machine.max_service_days} дней ·{' '}
                {machine.location_name}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </>
  );
}
