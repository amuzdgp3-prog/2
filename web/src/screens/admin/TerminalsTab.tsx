import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../../api';
import type { Machine, TabProps } from './types';
import { Section } from './shared/Section';

export function TerminalsTab({ onDone, onError }: TabProps) {
  const [terminals, setTerminals] = useState<Array<Record<string, string | number | null>>>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [serial, setSerial] = useState('');
  const [provider, setProvider] = useState('');
  const [bindTo, setBindTo] = useState<Record<number, string>>({});

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
              <div className="row" style={{ gap: 6 }}>
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
                <button
                  onClick={async () => {
                    try {
                      await api.post('/api/terminals/bind', {
                        terminalId: terminal.id,
                        machineNumber: bindTo[terminal.id as number],
                        startedAt: new Date().toISOString(),
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
