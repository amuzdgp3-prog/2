import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../../../api';
import type { RentPeriod } from './types';
import type { Terminal, Location, TabProps } from '../types';
import { Section } from '../shared/Section';

export function InstallMachineForm({
  locations,
  terminals,
  onDone,
  onError,
}: TabProps & { locations: Location[]; terminals: Terminal[] }) {
  const [form, setForm] = useState({
    machineNumber: '',
    machineType: 'CRANE',
    model: '',
    pricePerGame: '100',
    counterDivisor: '1.00',
    locationId: '',
    address: '',
    initialGameCounter: '0',
    initialPrizeCounter: '0',
    terminalId: '',
    monthlyRent: '',
  });
  const [currentRent, setCurrentRent] = useState<RentPeriod | null | undefined>(undefined);

  useEffect(() => {
    if (!form.locationId) { setCurrentRent(undefined); return; }
    api.get<RentPeriod[]>(`/api/locations/${form.locationId}/rent`)
      .then((history) => setCurrentRent(history.find((p) => p.ended_at === null) ?? null))
      .catch(() => setCurrentRent(undefined));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.locationId]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const startedAt = new Date().toISOString();
    try {
      await api.post('/api/machines/install', {
        machineNumber: form.machineNumber,
        machineType: form.machineType,
        model: form.model,
        pricePerGame: form.pricePerGame,
        counterDivisor: form.counterDivisor,
        locationId: Number(form.locationId),
        address: form.address || null,
        startedAt,
        initialGameCounter: Number(form.initialGameCounter),
        initialPrizeCounter: Number(form.initialPrizeCounter),
      });

      // Привязка терминала — отдельная операция со своей историей интервалов, поэтому она
      // выполняется после установки, а не внутри неё.
      if (form.terminalId) {
        await api.post('/api/terminals/bind', {
          terminalId: Number(form.terminalId),
          machineNumber: form.machineNumber,
          startedAt,
        });
      }

      // Аренда привязана к точке, не к аппарату: если поле не заполнено — ставку не трогаем
      // (у точки может быть уже действующая ставка, которую не нужно случайно перезаписать).
      if (form.monthlyRent) {
        await api.post(`/api/locations/${form.locationId}/rent`, { monthlyAmount: form.monthlyRent });
      }

      onDone(
        form.terminalId
          ? `Аппарат ${form.machineNumber} установлен, терминал привязан`
          : `Аппарат ${form.machineNumber} установлен`,
      );
    } catch (caught) {
      onError(caught);
    }
  };

  const set = (key: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm({ ...form, [key]: event.target.value });

  return (
    <form onSubmit={submit}>
      <Section title="Установка аппарата — отдельная операция, не обслуживание">
        <div className="stack">
          <div className="grid-2">
            <div>
              <label>Номер аппарата</label>
              <input value={form.machineNumber} onChange={set('machineNumber')} required />
            </div>
            <div>
              <label>Тип</label>
              <input value={form.machineType} onChange={set('machineType')} />
            </div>
          </div>
          <div className="grid-2">
            <div>
              <label>Цена игры, ₽</label>
              <input type="number" step="0.01" value={form.pricePerGame} onChange={set('pricePerGame')} required />
            </div>
            <div>
              <label>Коэффициент счётчика</label>
              <input
                type="number"
                step="0.01"
                min="0.01"
                value={form.counterDivisor}
                onChange={set('counterDivisor')}
              />
            </div>
          </div>
          <p className="muted" style={{ margin: 0 }}>
            Коэффициент 1.00 — одна единица счётчика равна одной игре. При 2.00 прирост счётчика
            делится на 2 до вычета тестовых игр.
          </p>
          <div className="grid-2">
            <div>
              <label>Точка</label>
              <select value={form.locationId} onChange={set('locationId')} required>
                <option value="">— выберите —</option>
                {locations.filter((location) => location.status === 'ACTIVE').map((location) => (
                  <option key={location.id} value={location.id}>{location.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label>Адрес</label>
              <input value={form.address} onChange={set('address')} placeholder="улица, дом" />
            </div>
          </div>
          <div>
            <label>Аренда точки, ₽/мес (необязательно)</label>
            <input
              type="number" step="0.01" min="0" value={form.monthlyRent} onChange={set('monthlyRent')}
              placeholder={
                currentRent === undefined ? 'выберите точку' :
                currentRent === null ? 'у точки ещё не задана' :
                `сейчас: ${currentRent.monthly_amount} ₽/мес — оставьте пустым, если менять не нужно`
              }
            />
            <p className="muted" style={{ margin: '4px 0 0' }}>
              Аренда привязана к точке, а не к этому аппарату — если тут уже стоит ставка, замена
              аппарата на этом месте её унаследует автоматически.
            </p>
          </div>
          <div className="grid-2">
            <div>
              <label>Начальный счётчик игр</label>
              <input type="number" value={form.initialGameCounter} onChange={set('initialGameCounter')} />
            </div>
            <div>
              <label>Начальный счётчик призов</label>
              <input type="number" value={form.initialPrizeCounter} onChange={set('initialPrizeCounter')} />
            </div>
          </div>
          <div>
            <label>Терминал (необязательно)</label>
            <select value={form.terminalId} onChange={set('terminalId')}>
              <option value="">— без терминала —</option>
              {terminals.map((terminal) => (
                <option key={terminal.id} value={terminal.id}>{terminal.serial}</option>
              ))}
            </select>
            {terminals.length === 0 && (
              <p className="muted" style={{ marginBottom: 0 }}>
                Свободных терминалов нет — добавьте их во вкладке «Терминалы».
              </p>
            )}
          </div>
          <button className="primary" type="submit">Установить</button>
        </div>
      </Section>
    </form>
  );
}
