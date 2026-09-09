import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { computeOverdue } from '../calc';
import { MachineTag } from '../components/ui/MachineTag';
import { extractMachineNumber, QrScannerButton } from '../components/ui/QrScanner';
import { RoiBadge } from '../components/ui/RoiBadge';
import { getMeta, readCachedMachines, type CachedMachine } from '../db';
import { refreshCatalog } from '../sync';

export default function MachinesScreen() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [machines, setMachines] = useState<CachedMachine[]>([]);
  const [query, setQuery] = useState('');
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  const load = async () => {
    setMachines(await readCachedMachines());
    setSyncedAt((await getMeta<string>('machines_synced_at')) ?? null);
  };

  useEffect(() => {
    // The cache renders instantly and keeps the list usable with no connection; the network
    // refresh then updates it in place.
    void load().then(async () => {
      try {
        await refreshCatalog();
        await load();
        setStatus(null);
      } catch {
        setStatus('Показан сохранённый список: сервер недоступен');
      }
    });
  }, []);

  const filtered = useMemo(() => {
    // Retired equipment has nothing left to service and would just clutter the technician's list.
    const inService = machines.filter((machine) => machine.status !== 'RETIRED');
    const needle = query.trim().toLowerCase();
    if (!needle) return inService;
    return inService.filter((machine) =>
      [machine.machine_number, machine.address ?? '', machine.location_name ?? '', machine.machine_type]
        .join(' ')
        .toLowerCase()
        .includes(needle),
    );
  }, [machines, query]);

  const groups = useMemo(() => {
    const byLocation = new Map<string, CachedMachine[]>();
    for (const machine of filtered) {
      const key = machine.location_name ?? 'Без точки';
      const bucket = byLocation.get(key) ?? [];
      bucket.push(machine);
      byLocation.set(key, bucket);
    }
    return [...byLocation.entries()];
  }, [filtered]);

  const overdueCount = useMemo(
    () => machines.filter((machine) => computeOverdue(machine).isOverdue).length,
    [machines],
  );

  return (
    <>
      {status && <div className="alert warn">{status}</div>}
      {scanError && <div className="alert error">{scanError}</div>}

      <div className="row" style={{ gap: 8, marginBottom: 12 }}>
        <input
          type="text"
          className="search-big"
          placeholder="Номер или адрес аппарата"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <QrScannerButton
          onDetect={(scanned) => {
            const machineNumber = extractMachineNumber(scanned);
            if (machineNumber === null) {
              setScanError('QR-код не распознан.');
              return;
            }
            const known = machines.some((machine) => machine.machine_number === machineNumber);
            if (!known) {
              setScanError(`Аппарат № ${machineNumber} не найден в вашем списке.`);
              return;
            }
            setScanError(null);
            navigate(`/service/${encodeURIComponent(machineNumber)}`);
          }}
        />
      </div>

      {user?.role === 'TECHNICIAN' && overdueCount > 0 && (
        <Link to="/forgotten" style={{ textDecoration: 'none' }}>
          <div className="card card-pad row" style={{ background: 'var(--warn-soft)', borderColor: '#D8C387' }}>
            <div style={{ color: 'var(--brass-deep)', fontSize: 13 }}>
              ⏰ {overdueCount} {overdueCount === 1 ? 'аппарат не обслуживался' : 'аппарата не обслуживались'} вовремя
            </div>
            <span style={{ color: 'var(--brass-deep)', fontWeight: 700, fontSize: 12.5 }}>Открыть →</span>
          </div>
        </Link>
      )}

      {syncedAt && (
        <p className="muted" style={{ marginTop: 0 }}>
          Каталог обновлён: {new Date(syncedAt).toLocaleString('ru-RU')}
        </p>
      )}

      {groups.length === 0 && machines.length === 0 && (
        <div className="card card-pad">
          <strong>Вам пока не открыт ни один аппарат</strong>
          <p className="muted" style={{ marginBottom: 0 }}>
            {user?.role === 'TECHNICIAN'
              ? 'Техник видит только аппараты на закреплённых за ним точках. Попросите администратора выдать доступ к точке в разделе «Админ → Сотрудники».'
              : 'Аппараты появятся здесь после установки в разделе «Админ → Аппараты».'}
          </p>
        </div>
      )}
      {groups.length === 0 && machines.length > 0 && (
        <p className="muted">По запросу ничего не найдено.</p>
      )}

      {groups.map(([locationName, rows]) => (
        <div key={locationName}>
          <div className="section-label">{locationName.toUpperCase()}</div>
          <div className="stack" style={{ marginBottom: 16 }}>
            {rows.map((machine) => {
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
                    Тип: {machine.machine_type}
                    {Number(machine.counter_divisor) !== 1 && (
                      <span className="divisor-tag" style={{ marginLeft: 6 }}>
                        делитель {Number(machine.counter_divisor)}
                      </span>
                    )}
                  </div>
                  <div className="mono" style={{ fontSize: 11.5, color: 'var(--ink-faint)', marginTop: 8 }}>
                    {machine.last_service_at
                      ? `посл. обслуживание — ${overdue.daysSinceService} дн. назад`
                      : 'обслуживаний ещё не было'}
                    {overdue.isOverdue && (
                      <span style={{ color: overdue.severity === 'bad' ? 'var(--bad)' : 'var(--warn)' }}>
                        {' '}
                        · просрочено на {overdue.daysOverdue} дн.
                      </span>
                    )}
                  </div>

                  <div className="row" style={{ marginTop: 12, gap: 8 }}>
                    <Link
                      to={`/service/${encodeURIComponent(machine.machine_number)}`}
                      style={{ flex: 1, textDecoration: 'none' }}
                    >
                      <button className="btn btn-primary btn-block">Обслужить</button>
                    </Link>
                    <Link
                      to={`/history/${encodeURIComponent(machine.machine_number)}`}
                      style={{ textDecoration: 'none' }}
                    >
                      <button className="btn btn-ghost">История</button>
                    </Link>
                  </div>

                  {machine.location_status && machine.location_status !== 'ACTIVE' && (
                    <div className="alert warn" style={{ marginTop: 10, marginBottom: 0 }}>
                      Точка в статусе {machine.location_status}: обслуживание запрещено
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </>
  );
}
