import { useState } from 'react';
import { AuditTab } from './AuditTab';
import { CashlessTab } from './CashlessTab';
import { CatalogTab } from './CatalogTab';
import { ConsumptionTab } from './ConsumptionTab';
import { ExpensesTab } from './ExpensesTab';
import { LocationsTab } from './LocationsTab';
import { MachineTypesTab } from './MachineTypesTab';
import { MachinesTab } from './machines/MachinesTab';
import { StaffTab } from './staff/StaffTab';
import { TasksTab } from './TasksTab';
import { TerminalsTab } from './TerminalsTab';
import { ToysTab } from './ToysTab';

type Tab = 'machines' | 'tasks' | 'types' | 'locations' | 'catalog' | 'terminals' | 'staff' | 'cashless' | 'toys' | 'consumption' | 'expenses' | 'audit';

export default function AdminScreen() {
  const [tab, setTab] = useState<Tab>('machines');
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
      <div className="tabs">
        <button className={tab === 'machines' ? 'active' : ''} onClick={() => setTab('machines')}>Аппараты</button>
        <button className={tab === 'tasks' ? 'active' : ''} onClick={() => setTab('tasks')}>Задачи</button>
        <button className={tab === 'types' ? 'active' : ''} onClick={() => setTab('types')}>Типы</button>
        <button className={tab === 'locations' ? 'active' : ''} onClick={() => setTab('locations')}>Адреса</button>
        <button className={tab === 'catalog' ? 'active' : ''} onClick={() => setTab('catalog')}>Каталог</button>
        <button className={tab === 'terminals' ? 'active' : ''} onClick={() => setTab('terminals')}>Терминалы</button>
        <button className={tab === 'staff' ? 'active' : ''} onClick={() => setTab('staff')}>Сотрудники</button>
        <button className={tab === 'toys' ? 'active' : ''} onClick={() => setTab('toys')}>Игрушки</button>
        <button className={tab === 'consumption' ? 'active' : ''} onClick={() => setTab('consumption')}>Расход</button>
        <button className={tab === 'expenses' ? 'active' : ''} onClick={() => setTab('expenses')}>Затраты</button>
        <button className={tab === 'cashless' ? 'active' : ''} onClick={() => setTab('cashless')}>Безнал</button>
        <button className={tab === 'audit' ? 'active' : ''} onClick={() => setTab('audit')}>Аудит</button>
      </div>

      {notice && <div className="alert ok">{notice}</div>}
      {error && <div className="alert error">{error}</div>}

      {tab === 'machines' && <MachinesTab onDone={report} onError={fail} />}
      {tab === 'tasks' && <TasksTab onDone={report} onError={fail} />}
      {tab === 'types' && <MachineTypesTab onDone={report} onError={fail} />}
      {tab === 'locations' && <LocationsTab onDone={report} onError={fail} />}
      {tab === 'catalog' && <CatalogTab onDone={report} onError={fail} />}
      {tab === 'terminals' && <TerminalsTab onDone={report} onError={fail} />}
      {tab === 'staff' && <StaffTab onDone={report} onError={fail} />}
      {tab === 'toys' && <ToysTab onDone={report} onError={fail} />}
      {tab === 'consumption' && <ConsumptionTab onDone={report} onError={fail} />}
      {tab === 'expenses' && <ExpensesTab onDone={report} onError={fail} />}
      {tab === 'cashless' && <CashlessTab onDone={report} onError={fail} />}
      {tab === 'audit' && <AuditTab onDone={report} onError={fail} />}
    </>
  );
}
