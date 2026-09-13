import { useEffect, useState } from 'react';
import { api } from '../../api';
import { formatMoney } from '../../calc';
import { PageSizeSelect } from '../../components/ui/PageSizeSelect';
import type { TabProps } from './types';

interface IvendSettingsView {
  isEnabled: boolean;
  login: string;
  hasPassword: boolean;
  overlapMinutes: number;
  runTimes: string[];
  lastRun: {
    startedAt: string;
    finishedAt: string | null;
    status: string;
    rowsInserted: number;
    rowsMatched: number;
    errorMessage: string | null;
  } | null;
}

/**
 * Логин/пароль кабинета iVend редактируются прямо здесь (не в env) — по требованию владельца:
 * если провайдер сменит пароль, он вводит новый тут же и видит сразу, принят ли он кабинетом.
 */

function IvendSettingsPanel({ onDone, onError }: TabProps) {
  const [settings, setSettings] = useState<IvendSettingsView | null>(null);
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [checkResult, setCheckResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [runTimes, setRunTimes] = useState<string[]>([]);
  const [scheduleBusy, setScheduleBusy] = useState(false);

  const load = () => {
    api
      .get<IvendSettingsView>('/api/parser/ivend/settings')
      .then((data) => {
        setSettings(data);
        setLogin(data.login);
        setEnabled(data.isEnabled);
        setRunTimes(data.runTimes);
      })
      .catch(onError);
  };
  useEffect(load, []);

  const saveSchedule = async (next: string[]) => {
    setScheduleBusy(true);
    try {
      const result = await api.put<{ ok: boolean; runTimes: string[] }>('/api/parser/ivend/schedule', {
        runTimes: next,
      });
      setRunTimes(result.runTimes);
      onDone('Расписание синхронизации сохранено');
    } catch (caught) {
      onError(caught);
    } finally {
      setScheduleBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setCheckResult(null);
    try {
      const result = await api.put<{ ok: boolean; message: string }>('/api/parser/ivend/settings', {
        login, password, isEnabled: enabled,
      });
      setCheckResult(result);
      setPassword('');
      load();
    } catch (caught) {
      onError(caught);
    } finally {
      setBusy(false);
    }
  };

  const runNow = async () => {
    setBusy(true);
    try {
      const result = await api.post<{ skipped: boolean; imported?: number; matched?: number; error?: string }>(
        '/api/parser/ivend/run', {},
      );
      if (result.skipped) onDone('Синхронизация выключена или не настроена — данные не запрашивались');
      else if (result.error) onError(new Error(result.error));
      else onDone(`Готово: новых транзакций ${result.imported ?? 0}, сопоставлено аппаратов ${result.matched ?? 0}`);
      load();
    } catch (caught) {
      onError(caught);
    } finally {
      setBusy(false);
    }
  };

  if (!settings) return null;

  return (
    <div className="card card-pad" style={{ marginBottom: 14 }}>
      <div className="muted" style={{ marginBottom: 10 }}>Кабинет iVend — автосбор безналичных платежей</div>

      {checkResult && (
        <div className={`alert ${checkResult.ok ? 'ok' : 'error'}`} style={{ marginBottom: 10 }}>
          {checkResult.message}
        </div>
      )}
      {settings.lastRun?.status === 'ERROR' && !checkResult && (
        <div className="alert error" style={{ marginBottom: 10 }}>
          Последняя синхронизация не удалась: {settings.lastRun.errorMessage}
        </div>
      )}

      <div className="row2">
        <div className="fld">
          <label>Логин (телефон)</label>
          <input value={login} onChange={(event) => setLogin(event.target.value)} placeholder="9991234567" />
        </div>
        <div className="fld">
          <label>Пароль</label>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={settings.hasPassword ? 'заполнен — введите новый, если сменился' : 'введите пароль'}
          />
        </div>
      </div>

      <div className="row" style={{ marginTop: 8, gap: 12 }}>
        <label style={{ margin: 0 }}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            style={{ width: 'auto', marginRight: 8 }}
          />
          автосинхронизация включена
        </label>
        <button onClick={save} disabled={busy}>Сохранить и проверить</button>
        <button onClick={runNow} disabled={busy}>Синхронизировать сейчас</button>
      </div>

      <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
        <label style={{ display: 'block', marginBottom: 8 }}>Время автосинхронизации (по Москве)</label>
        <div className="row" style={{ gap: 8 }}>
          {runTimes.map((time, index) => (
            <div key={index} className="row" style={{ gap: 4, width: 'auto' }}>
              <input
                type="time"
                value={time}
                style={{ width: 110 }}
                disabled={scheduleBusy}
                onChange={(event) => {
                  const next = [...runTimes];
                  next[index] = event.target.value;
                  setRunTimes(next);
                }}
              />
              <button
                className="icon-btn"
                disabled={scheduleBusy || runTimes.length <= 1}
                title="Убрать это время"
                onClick={() => saveSchedule(runTimes.filter((_, i) => i !== index))}
              >
                ✕
              </button>
            </div>
          ))}
          <button
            disabled={scheduleBusy}
            onClick={() => setRunTimes([...runTimes, '12:00'])}
          >
            + время
          </button>
          <button disabled={scheduleBusy} onClick={() => saveSchedule(runTimes)}>
            Сохранить расписание
          </button>
        </div>
        <p className="muted" style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
          Парсер будет заходить в кабинет iVend только в указанное время, а не постоянно
        </p>
      </div>

      {settings.lastRun && (
        <p className="muted" style={{ marginTop: 10, marginBottom: 0, fontSize: 12 }}>
          Последний запуск: {new Date(settings.lastRun.startedAt).toLocaleString('ru-RU')}
          {settings.lastRun.status === 'SUCCESS'
            ? ` — успешно, новых транзакций ${settings.lastRun.rowsInserted}, сопоставлено аппаратов ${settings.lastRun.rowsMatched}`
            : ` — ${settings.lastRun.status === 'RUNNING' ? 'выполняется…' : 'ошибка'}`}
        </p>
      )}
    </div>
  );
}

export function CashlessTab({ onDone, onError }: TabProps) {
  const [rows, setRows] = useState<Array<Record<string, string | number | null>>>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [onlyUnmatched, setOnlyUnmatched] = useState(false);

  const load = () => {
    const params = new URLSearchParams({ limit: String(pageSize), offset: String(page * pageSize) });
    if (onlyUnmatched) params.set('status', 'UNMATCHED');
    api
      .get<{ rows: Array<Record<string, string | number | null>>; total: number }>(`/api/cashless?${params.toString()}`)
      .then((response) => {
        setRows(response.rows);
        setTotal(response.total);
      })
      .catch(onError);
  };
  useEffect(load, [onlyUnmatched, page, pageSize]);
  useEffect(() => setPage(0), [onlyUnmatched, pageSize]);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const shownFrom = total === 0 ? 0 : page * pageSize + 1;
  const shownTo = Math.min(total, (page + 1) * pageSize);

  return (
    <>
      <IvendSettingsPanel onDone={onDone} onError={onError} />

      <div className="card row">
        <label style={{ margin: 0 }}>
          <input
            type="checkbox"
            checked={onlyUnmatched}
            onChange={(event) => setOnlyUnmatched(event.target.checked)}
            style={{ width: 'auto', marginRight: 8 }}
          />
          только несопоставленные
        </label>
        <button
          onClick={async () => {
            try {
              const result = await api.post<{ processed: number }>('/api/cashless/rematch', {
                onlyUnmatched: true,
              });
              onDone(`Повторно обработано транзакций: ${result.processed}`);
              load();
            } catch (caught) {
              onError(caught);
            }
          }}
        >
          Пересопоставить
        </button>
      </div>

      <div className="table-wrap scroll-x">
        <table>
          <thead>
            <tr>
              <th>Время</th>
              <th>Терминал</th>
              <th className="right">Сумма</th>
              <th>Аппарат</th>
              <th>Статус</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id as number}>
                <td>{new Date(row.occurred_at as string).toLocaleString('ru-RU')}</td>
                <td>{row.terminal_external_id}</td>
                <td className="right mono">{formatMoney(row.amount as string)}</td>
                <td>{(row.matched_machine_number as string) ?? '—'}</td>
                <td>
                  {row.match_status}
                  {row.unmatched_reason && <div className="muted">{row.unmatched_reason}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="pagination">
        <div className="info">Показано {shownFrom}–{shownTo} из {total}</div>
        <div className="row" style={{ gap: 14 }}>
          <PageSizeSelect value={pageSize} onChange={setPageSize} />
          <div className="pg">
            <button disabled={page === 0} onClick={() => setPage(page - 1)}>‹</button>
            {Array.from({ length: pageCount }).slice(0, 7).map((_, index) => (
              <button key={index} className={index === page ? 'active' : ''} onClick={() => setPage(index)}>
                {index + 1}
              </button>
            ))}
            <button disabled={page >= pageCount - 1} onClick={() => setPage(page + 1)}>›</button>
          </div>
        </div>
      </div>
    </>
  );
}
