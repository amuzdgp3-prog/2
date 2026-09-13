import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../../api';
import { formatMoney } from '../../calc';
import type { Machine, TabProps } from './types';
import { Section } from './shared/Section';

/**
 * datetime-local принимает местное время без секунд. Обрезка до минуты всегда даёт момент не
 * позже исходного, поэтому первая непривязанная транзакция остаётся внутри новой привязки.
 */
function toLocalInput(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function TerminalsTab({ onDone, onError }: TabProps) {
  const [terminals, setTerminals] = useState<Array<Record<string, string | number | null>>>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [serial, setSerial] = useState('');
  const [provider, setProvider] = useState('');
  const [bindTo, setBindTo] = useState<Record<number, string>>({});
  const [bindFrom, setBindFrom] = useState<Record<number, string>>({});

  const load = () => {
    api.get<Array<Record<string, string | number | null>>>('/api/terminals').then(setTerminals).catch(onError);
    api.get<Machine[]>('/api/machines').then(setMachines).catch(onError);
  };
  useEffect(load, []);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api.post('/api/terminals', { serial, provider });
      onDone(`Терминал ${serial} добавлен`);
      setSerial('');
      load();
    } catch (caught) {
      onError(caught);
    }
  };

  return (
    <>
      <form onSubmit={create}>
        <Section title="Новый терминал">
          <div className="stack">
            <div className="grid-2">
              <div>
                <label>Серийный номер</label>
                <input value={serial} onChange={(event) => setSerial(event.target.value)} required />
              </div>
              <div>
                <label>Провайдер</label>
                <input value={provider} onChange={(event) => setProvider(event.target.value)} required />
              </div>
            </div>
            <button className="primary" type="submit">Добавить</button>
          </div>
        </Section>
      </form>

      {terminals.map((terminal) => (
        <div className="card" key={terminal.id as number}>
          <div className="row">
            <div>
              <strong>{terminal.serial}</strong>
              <div className="muted">
                {terminal.bound_machine ? `на аппарате № ${terminal.bound_machine}` : 'на складе'}
              </div>
              {Number(terminal.unmatched_count ?? 0) > 0 && (
                <div className="alert error" style={{ marginTop: 6 }}>
                  Непривязанный безнал: {terminal.unmatched_count} транз. на{' '}
                  {formatMoney(terminal.unmatched_amount ?? 0)} ₽, первая —{' '}
                  {new Date(String(terminal.earliest_unmatched)).toLocaleString('ru-RU')}.
                  {terminal.bound_machine
                    ? ' Эти деньги пришли до текущей привязки.'
                    : ' При привязке поставьте дату начала не позже первой транзакции.'}
                </div>
              )}
            </div>
            {terminal.bound_machine ? (
              <button
                onClick={async () => {
                  try {
                    await api.post('/api/terminals/unbind', {
                      terminalId: terminal.id,
                      endedAt: new Date().toISOString(),
                    });
                    onDone('Терминал снят, транзакции перепривязаны');
                    load();
                  } catch (caught) {
                    onError(caught);
                  }
                }}
              >
                Снять
              </button>
            ) : (
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                <select
                  value={bindTo[terminal.id as number] ?? ''}
                  onChange={(event) =>
                    setBindTo({ ...bindTo, [terminal.id as number]: event.target.value })
                  }
                >
                  <option value="">— аппарат —</option>
                  {machines.map((machine) => (
                    <option key={machine.machine_number} value={machine.machine_number}>
                      № {machine.machine_number}{machine.address ? ` — ${machine.address}` : ''}
                    </option>
                  ))}
                </select>
                <input
                  type="datetime-local"
                  title="Дата начала привязки; пусто — с текущего момента"
                  value={bindFrom[terminal.id as number] ?? ''}
                  onChange={(event) =>
                    setBindFrom({ ...bindFrom, [terminal.id as number]: event.target.value })
                  }
                />
                {terminal.earliest_unmatched && (
                  <button
                    type="button"
                    onClick={() =>
                      setBindFrom({
                        ...bindFrom,
                        [terminal.id as number]: toLocalInput(String(terminal.earliest_unmatched)),
                      })
                    }
                  >
                    с первой транзакции
                  </button>
                )}
                <button
                  onClick={async () => {
                    try {
                      await api.post('/api/terminals/bind', {
                        terminalId: terminal.id,
                        machineNumber: bindTo[terminal.id as number],
                        // Пусто — «с этого момента», как было всегда. Дата из поля — привязка
                        // задним числом, чтобы забрать безнал, пришедший до заведения терминала.
                        startedAt: bindFrom[terminal.id as number]
                          ? new Date(bindFrom[terminal.id as number]).toISOString()
                          : new Date().toISOString(),
                      });
                      onDone('Терминал привязан');
                      load();
                    } catch (caught) {
                      onError(caught);
                    }
                  }}
                >
                  Привязать
                </button>
              </div>
            )}
          </div>
        </div>
      ))}
    </>
  );
}
