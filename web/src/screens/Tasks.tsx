import { useEffect, useState } from 'react';
import { api } from '../api';
import { MachineTag } from '../components/ui/MachineTag';
import { queueTaskClose, readTasks, type CachedTask } from '../db';
import { syncOutbox } from '../sync';

/**
 * Задачи техника (DECISION-050). Экран читает ЛОКАЛЬНЫЙ кэш, а не сеть: техник открывает список,
 * уже стоя у аппарата в подвале торгового центра, и список обязан быть там. Свежие задачи
 * подтягиваются при обновлении справочника, как аппараты и игрушки.
 *
 * Отметка «выполнено» тоже офлайновая: она кладётся в очередь и сразу помечает задачу в кэше,
 * чтобы техник увидел результат немедленно, а не после возвращения связи.
 */
export default function TasksScreen() {
  const [tasks, setTasks] = useState<CachedTask[]>([]);
  const [note, setNote] = useState<Record<number, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => setTasks(await readTasks());
  useEffect(() => {
    void load();
  }, []);

  const refresh = async () => {
    setBusy(true);
    try {
      const fresh = await api.get<CachedTask[]>('/api/tasks?status=OPEN');
      const { cacheTasks } = await import('../db');
      await cacheTasks(fresh);
      await load();
      setNotice('Список обновлён');
    } catch {
      setNotice('Нет связи — показан сохранённый список');
    } finally {
      setBusy(false);
    }
  };

  const complete = async (task: CachedTask) => {
    await queueTaskClose(task.id, note[task.id] ?? '');
    setNote({ ...note, [task.id]: '' });
    await load();
    setNotice('Отмечено. Уйдёт на сервер при первой связи.');
    void syncOutbox();
  };

  const open = tasks.filter((task) => task.status === 'OPEN');
  const done = tasks.filter((task) => task.status !== 'OPEN');

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Задачи</h2>
        <button onClick={refresh} disabled={busy}>{busy ? 'Обновляю…' : 'Обновить'}</button>
      </div>

      {notice && <div className="alert ok">{notice}</div>}

      {open.length === 0 && done.length === 0 && (
        <div className="card card-pad muted">Задач нет. Нажмите «Обновить», когда появится связь.</div>
      )}

      {open.map((task) => (
        <div className="card card-pad" key={task.id}>
          <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <strong>{task.title}</strong>
            {task.machine_number && <MachineTag number={task.machine_number} />}
          </div>
          {(task.machine_address || task.location_name) && (
            <div className="muted" style={{ marginTop: 4 }}>
              {task.machine_address ?? task.location_name}
            </div>
          )}
          {task.details && <div style={{ marginTop: 8 }}>{task.details}</div>}
          {task.due_date && (
            <div className="muted mono" style={{ marginTop: 6, fontSize: 11.5 }}>
              до {new Date(task.due_date).toLocaleDateString('ru-RU')}
            </div>
          )}
          <input
            placeholder="Комментарий (необязательно)"
            value={note[task.id] ?? ''}
            onChange={(event) => setNote({ ...note, [task.id]: event.target.value })}
            style={{ marginTop: 10 }}
          />
          <button className="primary btn-block" style={{ marginTop: 8 }} onClick={() => complete(task)}>
            Выполнено
          </button>
        </div>
      ))}

      {done.length > 0 && (
        <details className="card card-pad" style={{ marginTop: 12 }}>
          <summary style={{ cursor: 'pointer' }}>Выполнено ({done.length})</summary>
          {done.map((task) => (
            <div key={task.id} className="muted" style={{ marginTop: 8 }}>
              {task.title}
              {task.machine_number ? ` · аппарат № ${task.machine_number}` : ''}
            </div>
          ))}
        </details>
      )}
    </>
  );
}
