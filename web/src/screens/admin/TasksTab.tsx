import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../../api';
import type { Machine, TabProps } from './types';
import { Section } from './shared/Section';

interface TaskRow {
  id: number;
  title: string;
  details: string;
  status: 'OPEN' | 'DONE' | 'CANCELLED';
  machine_number: string | null;
  machine_address: string | null;
  assigned_name: string | null;
  created_by_name: string | null;
  closed_by_name: string | null;
  close_note: string;
  due_date: string | null;
  closed_at: string | null;
}

const STATUS_LABELS: Record<TaskRow['status'], string> = {
  OPEN: 'в работе',
  DONE: 'выполнена',
  CANCELLED: 'отменена',
};

/**
 * Задачи техникам, сторона администратора (DECISION-050). Задача без исполнителя видна всем
 * техникам, у кого аппарат в зоне ответственности, и её берёт первый доехавший: это список дел на
 * маршрут, а не поимённая диспетчеризация.
 */
export function TasksTab({ onDone, onError }: TabProps) {
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [staff, setStaff] = useState<Array<{ id: number; full_name: string; role: string }>>([]);
  const [showClosed, setShowClosed] = useState(false);
  const [form, setForm] = useState({
    title: '',
    details: '',
    machineNumber: '',
    assignedTo: '',
    dueDate: '',
  });

  const load = () => {
    api.get<TaskRow[]>('/api/tasks').then(setTasks).catch(onError);
    api.get<Machine[]>('/api/machines').then(setMachines).catch(() => setMachines([]));
    api
      .get<Array<{ id: number; full_name: string; role: string }>>('/api/staff')
      .then((rows) => setStaff(rows.filter((row) => row.role === 'TECHNICIAN')))
      .catch(() => setStaff([]));
  };
  useEffect(load, []);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api.post('/api/tasks', {
        title: form.title,
        details: form.details,
        machineNumber: form.machineNumber || null,
        assignedTo: form.assignedTo ? Number(form.assignedTo) : null,
        dueDate: form.dueDate || null,
      });
      onDone('Задача создана');
      setForm({ title: '', details: '', machineNumber: '', assignedTo: '', dueDate: '' });
      load();
    } catch (caught) {
      onError(caught);
    }
  };

  const act = async (task: TaskRow, action: 'cancel' | 'reopen') => {
    try {
      if (action === 'cancel') {
        if (!confirm(`Отменить задачу «${task.title}»?`)) return;
        await api.post(`/api/tasks/${task.id}/close`, { cancel: true });
        onDone('Задача отменена');
      } else {
        await api.post(`/api/tasks/${task.id}/reopen`, {});
        onDone('Задача возвращена в работу');
      }
      load();
    } catch (caught) {
      onError(caught);
    }
  };

  const openTasks = tasks.filter((task) => task.status === 'OPEN');
  const closedTasks = tasks.filter((task) => task.status !== 'OPEN');

  return (
    <>
      <form onSubmit={create}>
        <Section title="Новая задача">
          <div className="stack">
            <div>
              <label>Что сделать</label>
              <input
                value={form.title}
                onChange={(event) => setForm({ ...form, title: event.target.value })}
                required
              />
            </div>
            <div>
              <label>Подробности</label>
              <input
                value={form.details}
                onChange={(event) => setForm({ ...form, details: event.target.value })}
              />
            </div>
            <div className="grid-2">
              <div>
                <label>Аппарат</label>
                <select
                  value={form.machineNumber}
                  onChange={(event) => setForm({ ...form, machineNumber: event.target.value })}
                >
                  <option value="">— не привязана к аппарату —</option>
                  {machines.filter((m) => m.status !== 'RETIRED').map((machine) => (
                    <option key={machine.machine_number} value={machine.machine_number}>
                      № {machine.machine_number}{machine.address ? ` — ${machine.address}` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label>Исполнитель</label>
                <select
                  value={form.assignedTo}
                  onChange={(event) => setForm({ ...form, assignedTo: event.target.value })}
                >
                  <option value="">— любой техник —</option>
                  {staff.map((person) => (
                    <option key={person.id} value={person.id}>{person.full_name}</option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label>Срок</label>
              <input
                type="date"
                value={form.dueDate}
                onChange={(event) => setForm({ ...form, dueDate: event.target.value })}
              />
            </div>
            <div className="muted" style={{ fontSize: 12.5 }}>
              Без исполнителя задачу увидят все техники, у кого этот аппарат в зоне
              ответственности, и возьмёт первый доехавший.
            </div>
            <button className="primary" type="submit">Поставить задачу</button>
          </div>
        </Section>
      </form>

      {openTasks.length === 0 && <div className="card muted">Открытых задач нет.</div>}

      {openTasks.map((task) => (
        <div className="card" key={task.id}>
          <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <div>
              <strong>{task.title}</strong>
              <div className="muted">
                {task.machine_number ? `аппарат № ${task.machine_number}` : 'без привязки к аппарату'}
                {task.machine_address ? ` — ${task.machine_address}` : ''}
                {' · '}
                {task.assigned_name ?? 'любой техник'}
                {task.due_date ? ` · до ${new Date(task.due_date).toLocaleDateString('ru-RU')}` : ''}
              </div>
            </div>
            <button onClick={() => act(task, 'cancel')}>Отменить</button>
          </div>
          {task.details && <div style={{ marginTop: 8 }}>{task.details}</div>}
        </div>
      ))}

      {closedTasks.length > 0 && (
        <details className="card" open={showClosed} onToggle={(e) => setShowClosed((e.target as HTMLDetailsElement).open)}>
          <summary style={{ cursor: 'pointer' }}>Закрытые задачи ({closedTasks.length})</summary>
          <div style={{ marginTop: 10 }}>
            {closedTasks.map((task) => (
              <div key={task.id} style={{ marginTop: 10, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
                <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                  <div>
                    <strong>{task.title}</strong>
                    <div className="muted">
                      {STATUS_LABELS[task.status]}
                      {task.closed_by_name ? ` · ${task.closed_by_name}` : ''}
                      {task.closed_at ? ` · ${new Date(task.closed_at).toLocaleString('ru-RU')}` : ''}
                    </div>
                    {task.close_note && <div style={{ marginTop: 4 }}>{task.close_note}</div>}
                  </div>
                  <button onClick={() => act(task, 'reopen')}>Вернуть в работу</button>
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
    </>
  );
}
