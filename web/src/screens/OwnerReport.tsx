import { useEffect, useState } from 'react';
import { api, getToken } from '../api';
import type { OwnerMonthReport } from '../ownerMonthReport';
import {
  CashReportCard,
  ExpensesCard,
  GroupsTable,
  MachineCounts,
  MachineRowsTable,
  RentCard,
  RevenueAndProfit,
  ToysTable,
} from './OwnerReportSections';

const MONTH_NAMES_FULL = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

interface YearMonth {
  year: number;
  month: number;
}

/** Месяц по умолчанию — прошлый: текущий ещё не закончен. */
function previousMonth(): YearMonth {
  const now = new Date();
  const index = now.getUTCFullYear() * 12 + now.getUTCMonth() - 1;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

function shiftMonth({ year, month }: YearMonth, delta: number): YearMonth {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

function isCurrentOrLater({ year, month }: YearMonth): boolean {
  const now = new Date();
  return year * 12 + month >= now.getUTCFullYear() * 12 + now.getUTCMonth() + 1;
}

/**
 * Страница «Отчёт» — отчёт владельцу за выбранный месяц (по умолчанию прошлый). Все цифры приходят
 * готовыми из единого расчёта `GET /api/reports/owner-month`; тот же расчёт строит xlsx, поэтому
 * экран и файл совпадают блок в блок. Здесь только раскладка.
 */
export default function OwnerReportScreen() {
  const [period, setPeriod] = useState<YearMonth>(previousMonth);
  const [report, setReport] = useState<OwnerMonthReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setReport(null);
    setError(null);
    api.get<OwnerMonthReport>(`/api/reports/owner-month?year=${period.year}&month=${period.month}`)
      .then((data) => { if (!cancelled) setReport(data); })
      .catch((caught) => { if (!cancelled) setError((caught as Error).message); });
    return () => { cancelled = true; };
  }, [period]);

  const downloadExcel = async () => {
    setDownloading(true);
    try {
      const response = await fetch(`/api/reports/monthly-excel?year=${period.year}&month=${period.month}`, {
        headers: { authorization: `Bearer ${getToken()}` },
      });
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `Отчет ${period.year}-${String(period.month).padStart(2, '0')}.xlsx`;
      link.click();
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <>
      <div className="card card-pad" style={{ marginBottom: 12 }}>
        <div className="row">
          <button type="button" onClick={() => setPeriod((p) => shiftMonth(p, -1))}>← Раньше</button>
          <strong style={{ flex: 1, textAlign: 'center', fontFamily: 'var(--f-display)', fontSize: 18 }}>
            {MONTH_NAMES_FULL[period.month - 1]} {period.year}
          </strong>
          <button type="button" onClick={() => setPeriod((p) => shiftMonth(p, 1))} disabled={isCurrentOrLater(period)}>
            Позже →
          </button>
        </div>
        <button
          type="button"
          className="primary"
          style={{ marginTop: 10 }}
          onClick={downloadExcel}
          disabled={downloading}
        >
          {downloading ? 'Формирую…' : 'Скачать отчёт (xlsx)'}
        </button>
      </div>

      {error && <div className="alert error">{error}</div>}
      {!error && !report && <p className="muted">Загрузка…</p>}
      {report && (
        <>
          <RevenueAndProfit report={report} />
          <MachineCounts report={report} />
          <GroupsTable report={report} />
          <div className="or-cols">
            <ExpensesCard report={report} />
            <CashReportCard report={report} />
          </div>
          <RentCard report={report} />
          <ToysTable report={report} />
          <MachineRowsTable report={report} />
        </>
      )}
    </>
  );
}
