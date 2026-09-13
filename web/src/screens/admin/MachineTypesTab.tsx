import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../../api';
import type { TabProps } from './types';
import { Section } from './shared/Section';

interface MachineTypeRow {
  name: string;
  is_active: boolean;
  machines_count: number;
}

/**
 * Справочник типов аппаратов (DECISION-047). Ключ справочника — само название типа, поэтому
 * переименование здесь меняет тип сразу у всех аппаратов, включая списанные: это одна операция
 * внешнего ключа, а не массовая правка истории.
 *
 * «Отключить» и «удалить» намеренно разные действия. Удалить можно только тип, которым не помечен
 * ни один аппарат; использованный тип отключается, остаётся в истории и отчётах, но больше не
 * предлагается при установке новых аппаратов.
 */
export function MachineTypesTab({ onDone, onError }: TabProps) {
  const [types, setTypes] = useState<MachineTypeRow[]>([]);
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameTo, setRenameTo] = useState('');

  const load = () => {
    api.get<MachineTypeRow[]>('/api/machine-types').then(setTypes).catch(onError);
  };
  useEffect(load, []);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api.post('/api/machine-types', { name: newName });
      onDone(`Тип «${newName.trim()}» добавлен`);
      setNewName('');
      load();
    } catch (caught) {
      onError(caught);
    }
  };

  const rename = async (currentName: string) => {
    try {
      await api.patch(`/api/machine-types/${encodeURIComponent(currentName)}`, { name: renameTo });
      onDone('Тип переименован, аппараты обновлены');
      setRenaming(null);
      setRenameTo('');
      load();
    } catch (caught) {
      onError(caught);
    }
  };

  const setActive = async (name: string, isActive: boolean) => {
    try {
      await api.patch(`/api/machine-types/${encodeURIComponent(name)}`, { isActive });
      onDone(isActive ? 'Тип снова доступен при установке' : 'Тип отключён');
      load();
    } catch (caught) {
      onError(caught);
    }
  };

  const remove = async (row: MachineTypeRow) => {
    if (!confirm(`Удалить тип «${row.name}»? Отменить нельзя.`)) return;
    try {
      await api.delete(`/api/machine-types/${encodeURIComponent(row.name)}`);
      onDone('Тип удалён');
      load();
    } catch (caught) {
      onError(caught);
    }
  };

  return (
    <>
      <form onSubmit={create}>
        <Section title="Новый тип аппарата">
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <input
              placeholder="Например: Прищепка"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              required
            />
            <button className="primary" type="submit">Добавить</button>
          </div>
        </Section>
      </form>

      {types.map((row) => (
        <div className="card" key={row.name}>
          <div className="row">
            <div>
              <strong>{row.name}</strong>
              <div className="muted">
                аппаратов: {row.machines_count}
                {!row.is_active && ' · отключён, не предлагается при установке'}
              </div>
            </div>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <button onClick={() => { setRenaming(renaming === row.name ? null : row.name); setRenameTo(row.name); }}>
                {renaming === row.name ? 'Закрыть' : 'Переименовать'}
              </button>
              <button onClick={() => setActive(row.name, !row.is_active)}>
                {row.is_active ? 'Отключить' : 'Включить'}
              </button>
              {row.machines_count === 0 && (
                <button className="btn-danger-ghost" onClick={() => remove(row)}>Удалить</button>
              )}
            </div>
          </div>

          {renaming === row.name && (
            <div className="row" style={{ gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
              <input value={renameTo} onChange={(event) => setRenameTo(event.target.value)} />
              <button
                className="primary"
                disabled={!renameTo.trim() || renameTo === row.name}
                onClick={() => rename(row.name)}
              >
                Сохранить
              </button>
              {row.machines_count > 0 && (
                <span className="muted">
                  новое название получат все {row.machines_count} аппаратов этого типа
                </span>
              )}
            </div>
          )}
        </div>
      ))}
    </>
  );
}
