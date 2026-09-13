import { useState, type FormEvent } from 'react';
import { api } from '../../../api';
import type { StaffRow } from './types';
import type { TabProps } from '../types';
import { Section } from '../shared/Section';

export function CreateStaffForm({ onDone, onError }: TabProps) {
  const [form, setForm] = useState({ login: '', fullName: '', role: 'TECHNICIAN', password: '' });

  const create = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api.post('/api/staff', form);
      onDone(`Сотрудник ${form.fullName || form.login} создан`);
    } catch (caught) {
      onError(caught);
    }
  };

  return (
    <form onSubmit={create}>
      <Section title="Новый сотрудник">
        <div className="stack">
          <div className="grid-2">
            <div>
              <label>Логин</label>
              <input value={form.login} onChange={(event) => setForm({ ...form, login: event.target.value })} required />
            </div>
            <div>
              <label>Имя</label>
              <input value={form.fullName} onChange={(event) => setForm({ ...form, fullName: event.target.value })} required />
            </div>
          </div>
          <div className="grid-2">
            <div>
              <label>Роль</label>
              <select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })}>
                <option value="TECHNICIAN">Техник</option>
                <option value="ADMIN">Администратор</option>
                <option value="BOSS">Руководитель (только чтение)</option>
              </select>
            </div>
            <div>
              <label>Пароль</label>
              <input
                type="password"
                value={form.password}
                onChange={(event) => setForm({ ...form, password: event.target.value })}
                required
              />
            </div>
          </div>
          <button className="primary" type="submit">Создать</button>
        </div>
      </Section>
    </form>
  );
}

export function EditStaffForm({
  person,
  onDone,
  onError,
}: TabProps & { person: StaffRow }) {
  const [fullName, setFullName] = useState(person.full_name);
  const [role, setRole] = useState(person.role);
  const [isActive, setIsActive] = useState(person.is_active);
  const [newPassword, setNewPassword] = useState('');

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api.patch(`/api/staff/${person.id}`, { fullName, role, isActive });
      await onDone('Данные сотрудника сохранены');
    } catch (caught) {
      onError(caught);
    }
  };

  const savePassword = async () => {
    try {
      await api.post(`/api/staff/${person.id}/password`, { password: newPassword });
      setNewPassword('');
      await onDone('Пароль изменён');
    } catch (caught) {
      onError(caught);
    }
  };

  return (
    <div style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
      <form onSubmit={saveProfile}>
        <div className="stack">
          <div className="grid-2">
            <div>
              <label>Имя</label>
              <input value={fullName} onChange={(event) => setFullName(event.target.value)} required />
            </div>
            <div>
              <label>Роль</label>
              <select value={role} onChange={(event) => setRole(event.target.value as StaffRow['role'])}>
                <option value="TECHNICIAN">Техник</option>
                <option value="ADMIN">Администратор</option>
                <option value="BOSS">Руководитель (только чтение)</option>
              </select>
            </div>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={isActive}
              onChange={(event) => setIsActive(event.target.checked)}
              style={{ width: 'auto' }}
            />
            Учётная запись активна (выключите, чтобы запретить вход без удаления истории)
          </label>
          <button className="primary" type="submit">Сохранить</button>
        </div>
      </form>

      <div className="grid-2" style={{ marginTop: 14, alignItems: 'flex-end' }}>
        <div>
          <label>Новый пароль</label>
          <input
            type="password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
          />
        </div>
        <button type="button" disabled={!newPassword} onClick={savePassword}>
          Сменить пароль
        </button>
      </div>
      <p className="muted" style={{ marginTop: 6, marginBottom: 0 }}>
        Ограничений на сложность пароля нет — можно ставить любой, включая короткий.
      </p>
    </div>
  );
}
