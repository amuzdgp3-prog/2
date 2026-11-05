import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AuditTab } from './AuditTab';
import { CashlessTab } from './CashlessTab';
import { CatalogTab } from './CatalogTab';
import { ConsumptionTab } from './ConsumptionTab';
import { ExpensesTab } from './ExpensesTab';
import { ExpenseSummaryTab } from './ExpenseSummaryTab';
import { LocationsTab } from './LocationsTab';
import { MachineTypesTab } from './MachineTypesTab';
import { MachinesTab } from './machines/MachinesTab';
import { ReviewsTab } from './ReviewsTab';
import { StaffTab } from './staff/StaffTab';
import { TasksTab } from './TasksTab';
import { TerminalsTab } from './TerminalsTab';
import { ToysTab } from './ToysTab';

type Tab = 'machines' | 'reviews' | 'tasks' | 'types' | 'locations' | 'catalog' | 'terminals' | 'staff' | 'cashless' | 'toys' | 'consumption' | 'expenses' | 'expense-summary' | 'audit';

const groups: { label: string; tabs: { id: Tab; label: string }[] }[] = [
  { label: 'Работа', tabs: [
    { id: 'machines', label: 'Управление аппаратами' },
    { id: 'reviews', label: 'Проверка обслуживаний' },
    { id: 'tasks', label: 'Задачи' },
  ] },
  { label: 'Финансы', tabs: [
    { id: 'expenses', label: 'Затраты' },
    { id: 'expense-summary', label: 'Сводка расходов' },
    { id: 'cashless', label: 'Безналичные платежи' },
    { id: 'consumption', label: 'Расход игрушек' },
  ] },
  { label: 'Справочники', tabs: [
    { id: 'locations', label: 'Адреса' }, { id: 'types', label: 'Типы аппаратов' },
    { id: 'catalog', label: 'Каталог' }, { id: 'terminals', label: 'Терминалы' },
    { id: 'toys', label: 'Игрушки' },
  ] },
  { label: 'Система', tabs: [
    { id: 'staff', label: 'Сотрудники' }, { id: 'audit', label: 'Аудит действий' },
  ] },
];

export default function AdminScreen() {
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const group = groups.find(item => item.tabs.some(tab => tab.id === requested)) ?? groups[0];
  const tab = group.tabs.find(item => item.id === requested)?.id ?? 'machines';
  const setTab = (next: Tab) => { setParams({ tab: next }); setNotice(null); setError(null); };
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const report = (message: string) => {
    setNotice(message);
    setError(null);
  };
  const fail = (caught: unknown) => {
    setError((caught as Error).message);
    setNotice(null);
  };

  return (
    <>
      <div className="admin-section-header">
        <p className="muted">Настройки, справочники и контроль работы</p>
      </div>
      <nav className="admin-group-tabs" aria-label="Группы управления">
        {groups.map(item => <button key={item.label} className={group === item ? 'active' : ''}
          aria-pressed={group === item} onClick={() => setTab(item.tabs[0].id)}>{item.label}</button>)}
      </nav>
      <nav className="admin-section-tabs" aria-label={group.label}>
        {group.tabs.map(item => <button key={item.id} className={tab === item.id ? 'active' : ''}
          aria-pressed={tab === item.id} onClick={() => setTab(item.id)}>{item.label}</button>)}
      </nav>

      {notice && <div className="alert ok">{notice}</div>}
      {error && <div className="alert error">{error}</div>}

      {tab === 'machines' && <MachinesTab onDone={report} onError={fail} />}
      {tab === 'reviews' && <ReviewsTab onDone={report} onError={fail} />}
      {tab === 'tasks' && <TasksTab onDone={report} onError={fail} />}
      {tab === 'types' && <MachineTypesTab onDone={report} onError={fail} />}
      {tab === 'locations' && <LocationsTab onDone={report} onError={fail} />}
      {tab === 'catalog' && <CatalogTab onDone={report} onError={fail} />}
      {tab === 'terminals' && <TerminalsTab onDone={report} onError={fail} />}
      {tab === 'staff' && <StaffTab onDone={report} onError={fail} />}
      {tab === 'toys' && <ToysTab onDone={report} onError={fail} />}
      {tab === 'consumption' && <ConsumptionTab onDone={report} onError={fail} />}
      {tab === 'expenses' && <ExpensesTab onDone={report} onError={fail} />}
      {tab === 'expense-summary' && <ExpenseSummaryTab onDone={report} onError={fail} />}
      {tab === 'cashless' && <CashlessTab onDone={report} onError={fail} />}
      {tab === 'audit' && <AuditTab onDone={report} onError={fail} />}
    </>
  );
}
