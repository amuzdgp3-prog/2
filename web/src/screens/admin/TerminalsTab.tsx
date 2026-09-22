import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../../api';
import { formatMoney } from '../../calc';
import type { Machine, TabProps } from './types';
import { Section } from './shared/Section';

interface SimilarTerminal {
  id: number;
  serial: string;
  bound_machine: string | null;
  address: string | null;
  location_name: string | null;
}

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
  const [similar, setSimilar] = useState<SimilarTerminal[]>([]);
  const [provider, setProvider] = useState('');
  const [bindTo, setBindTo] = useState<Record<number, string>>({});
  const [bindFrom, setBindFrom] = useState<Record<number, string>>({});
  const [transferring, setTransferring] = useState<number | null>(null);
  const [showWithoutTerminal, setShowWithoutTerminal] = useState(false);
  const [assignTo, setAssignTo] = useState<Record<string, string>>({});

  const load = () => {
    api.get<Array<Record<string, string | number | null>>>('/api/terminals').then(setTerminals).catch(onError);
    api.get<Machine[]>('/api/machines').then(setMachines).catch(onError);
  };
  useEffect(load, []);

  // На iVend номер записан как 50264785, в разговоре тот же терминал зовут 264785. Заведённая
  // короткая форма не получает транзакций вовсе (парсер опрашивает iVend по точным серийникам),
  // поэтому про похожий номер спрашиваем до создания, а не чиним последствия потом.
  useEffect(() => {
    if (serial.replace(/\D/g, '').length < 5) {
      setSimilar([]);
      return;
    }
    const timer = setTimeout(() => {
      api
        .get<SimilarTerminal[]>(`/api/terminals/similar?serial=${encodeURIComponent(serial.trim())}`)
        .then(setSimilar)
        .catch(() => setSimilar([]));
    }, 300);
    return () => clearTimeout(timer);
  }, [serial]);

  const describeSimilar = (terminal: SimilarTerminal): string =>
    terminal.bound_machine
      ? `аппарат № ${terminal.bound_machine}`
        + (terminal.address ?? terminal.location_name
          ? `, ${terminal.address ?? terminal.location_name}`
          : '')
      : 'на складе';

  // Аппарат считается «без терминала», если он активен и ни один терминал на него не привязан.
  // Списанные сюда не попадают: им терминал и не нужен.
  const boundMachines = new Set(
    terminals.filter((t) => t.bound_machine).map((t) => String(t.bound_machine)),
  );
  const machinesWithoutTerminal = machines.filter(
    (machine) => machine.status !== 'RETIRED' && !boundMachines.has(machine.machine_number),
  );

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (
      similar.length > 0
      && !confirm(
        `Похожий терминал уже заведён: ${similar.map((t) => `${t.serial} (${describeSimilar(t)})`).join(', ')}.\n\n`
        + 'Если это тот же самый терминал, новую запись заводить не нужно: она не получит ни одной '
        + 'транзакции, а деньги продолжат идти на прежний аппарат. Переставить терминал можно '
        + 'кнопкой «Перенести» на его карточке.\n\nВсё равно создать новый терминал?',
      )
    ) return;
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
            {similar.length > 0 && (
              <div className="alert error">
                <strong>Похожий терминал уже заведён.</strong>
                {similar.map((terminal) => (
                  <div key={terminal.id}>
                    № {terminal.serial} — {describeSimilar(terminal)}
                  </div>
                ))}
                <div style={{ marginTop: 6 }}>
                  Номер на iVend начинается с «50», и сопоставление идёт по нему целиком. Если это
                  тот же терминал, переставьте его кнопкой «Перенести» на его карточке, а новую
                  запись не заводите — она не получит ни одной транзакции.
                </div>
              </div>
            )}
            <button className="primary" type="submit">Добавить</button>
          </div>
        </Section>
      </form>

      <Section title="Сводка по терминалам">
        <div className="row" style={{ gap: 18, flexWrap: 'wrap' }}>
          <div>
            <div className="muted">на складе</div>
            <strong>{terminals.filter((t) => !t.bound_machine).length}</strong>
          </div>
          <div>
            <div className="muted">на аппаратах</div>
            <strong>{terminals.filter((t) => t.bound_machine).length}</strong>
          </div>
          <div>
            {/* Аппараты без терминала — это недополученный безнал, поэтому счётчик кликабельный:
                по нему сразу разворачивается список, где терминал можно назначить не уходя. */}
            <div className="muted">активных аппаратов без терминала</div>
            <button
              onClick={() => setShowWithoutTerminal(!showWithoutTerminal)}
              disabled={machinesWithoutTerminal.length === 0}
            >
              {machinesWithoutTerminal.length}
              {machinesWithoutTerminal.length > 0 && (showWithoutTerminal ? ' — скрыть' : ' — показать')}
            </button>
          </div>
        </div>

        {showWithoutTerminal && (
          <div style={{ marginTop: 12 }}>
            {machinesWithoutTerminal.map((machine) => (
              <div className="row" key={machine.machine_number} style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                <div style={{ minWidth: 220 }}>
                  <strong>№ {machine.machine_number}</strong>
                  <div className="muted">{machine.address ?? machine.location_name ?? 'без адреса'}</div>
                </div>
                <select
                  value={assignTo[machine.machine_number] ?? ''}
                  onChange={(event) =>
                    setAssignTo({ ...assignTo, [machine.machine_number]: event.target.value })
                  }
                >
                  <option value="">— свободный терминал —</option>
                  {terminals.filter((t) => !t.bound_machine).map((t) => (
                    <option key={t.id as number} value={t.id as number}>{t.serial}</option>
                  ))}
                </select>
                <button
                  disabled={!assignTo[machine.machine_number]}
                  onClick={async () => {
                    try {
                      await api.post('/api/terminals/bind', {
                        terminalId: Number(assignTo[machine.machine_number]),
                        machineNumber: machine.machine_number,
                        startedAt: new Date().toISOString(),
                      });
                      onDone(`Терминал привязан к аппарату № ${machine.machine_number}`);
                      setAssignTo({ ...assignTo, [machine.machine_number]: '' });
                      load();
                    } catch (caught) {
                      onError(caught);
                    }
                  }}
                >
                  Привязать
                </button>
              </div>
            ))}
          </div>
        )}
      </Section>

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
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                <button onClick={() => setTransferring(transferring === terminal.id ? null : (terminal.id as number))}>
                  {transferring === terminal.id ? 'Отмена' : 'Перенести'}
                </button>
                <button
                  onClick={async () => {
                    // Снятие возвращает терминал на склад и пересопоставляет безнал, поэтому
                    // случайное нажатие стоит дорого — спрашиваем явно.
                    if (!confirm(
                      `Снять терминал ${terminal.serial} с аппарата № ${terminal.bound_machine}?\n\n`
                      + 'Терминал вернётся на склад, а безналичные транзакции будут пересопоставлены. '
                      + 'Если терминал переезжает на другой аппарат, используйте «Перенести»: так '
                      + 'деньги правильно разделятся по дате переезда.',
                    )) return;
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
              </div>
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

          {transferring === terminal.id && (
            <div style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
              <div className="muted" style={{ marginBottom: 8 }}>
                Перенос на другой аппарат. Прежняя привязка закроется ровно тем моментом, с которого
                начнётся новая, поэтому безнал до этой даты останется за аппаратом № {String(terminal.bound_machine)},
                а после — уйдёт новому. Пусто — переносим прямо сейчас.
              </div>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                <select
                  value={bindTo[terminal.id as number] ?? ''}
                  onChange={(event) =>
                    setBindTo({ ...bindTo, [terminal.id as number]: event.target.value })
                  }
                >
                  <option value="">— новый аппарат —</option>
                  {machines
                    .filter((machine) => machine.machine_number !== String(terminal.bound_machine))
                    .map((machine) => (
                      <option key={machine.machine_number} value={machine.machine_number}>
                        № {machine.machine_number}{machine.address ? ` — ${machine.address}` : ''}
                      </option>
                    ))}
                </select>
                <input
                  type="datetime-local"
                  title="Момент переезда; пусто — прямо сейчас"
                  value={bindFrom[terminal.id as number] ?? ''}
                  onChange={(event) =>
                    setBindFrom({ ...bindFrom, [terminal.id as number]: event.target.value })
                  }
                />
                <button
                  className="primary"
                  disabled={!bindTo[terminal.id as number]}
                  onClick={async () => {
                    const target = bindTo[terminal.id as number];
                    if (!confirm(
                      `Перенести терминал ${terminal.serial} с аппарата № ${terminal.bound_machine} `
                      + `на № ${target}?`,
                    )) return;
                    try {
                      await api.post('/api/terminals/bind', {
                        terminalId: terminal.id,
                        machineNumber: target,
                        startedAt: bindFrom[terminal.id as number]
                          ? new Date(bindFrom[terminal.id as number]).toISOString()
                          : new Date().toISOString(),
                      });
                      onDone(`Терминал перенесён на аппарат № ${target}, безнал разделён по дате`);
                      setTransferring(null);
                      load();
                    } catch (caught) {
                      onError(caught);
                    }
                  }}
                >
                  Перенести
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </>
  );
}
