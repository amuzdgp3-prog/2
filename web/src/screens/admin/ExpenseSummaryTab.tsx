import { useEffect, useState } from 'react';
import { api, getToken } from '../../api';
import { formatMoney } from '../../calc';
import type { TabProps } from './types';
import { Section } from './shared/Section';

/**
 * Сводка расходов: кто сколько стоит. Отдельно от вкладки «Затраты», где ведётся сам гроссбух
 * построчно, — здесь та же информация собрана по людям и дням, чтобы отвечать на вопрос «сколько
 * ушло на Фёдора в сентябре», а не «какие были записи».
 *
 * Личные траты владельца стоят отдельным блоком и в расходы на людей не входят: это его
 * собственные деньги, а не стоимость содержания техников. Смешивать их значило бы получить сумму,
 * из которой ничего не следует.
 */

interface DayRow {
  date: string;
  salary: string;
  fuel: string;
  other: string;
  items: Array<{ id: number; amount: string; comment: string; photoObjectKey: string | null }>;
}

interface PersonBlock {
  staffId: number | null;
  name: string;
  days: DayRow[];
  totals: { salary: string; fuel: string; other: string; total: string };
}

interface Summary {
  technicians: PersonBlock[];
  ownerExpenses: Array<{
    id: number;
    date: string;
    category: string;
    amount: string;
    comment: string;
    photoObjectKey: string | null;
  }>;
  totals: {
    technicians: string;
    owner: string;
    salary: string;
    fuel: string;
    other: string;
    total: string;
  };
}

const CATEGORY_LABELS: Record<string, string> = {
  FUEL: 'Бензин',
  SALARY: 'Зарплата / аванс',
  CARD: 'На карту',
  OTHER: 'Прочее',
};

function monthRange(): { from: string; to: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

function humanDate(iso: string): string {
  const [year, month, day] = iso.split('-');
  return `${day}.${month}.${year}`;
}

/** Чек открывается в новой вкладке; токен идёт параметром, потому что <a> не шлёт заголовки. */
function ReceiptLink({ objectKey }: { objectKey: string }) {
  return (
    <a
      href={`/api/photos/${objectKey}?token=${getToken() ?? ''}`}
      target="_blank"
      rel="noreferrer"
      title="Открыть чек"
    >
      📷 чек
    </a>
  );
}

export function ExpenseSummaryTab({ onError }: TabProps) {
  const [range, setRange] = useState(monthRange());
  const [summary, setSummary] = useState<Summary | null>(null);

  useEffect(() => {
    api
      .get<Summary>(`/api/expenses/summary?from=${range.from}&to=${range.to}`)
      .then(setSummary)
      .catch(onError);
  }, [range.from, range.to]);

  return (
    <Section title="Сводка расходов">
      <div className="grid-2" style={{ marginBottom: 12 }}>
        <div>
          <label>С</label>
          <input type="date" value={range.from} onChange={(event) => setRange({ ...range, from: event.target.value })} />
        </div>
        <div>
          <label>По</label>
          <input type="date" value={range.to} onChange={(event) => setRange({ ...range, to: event.target.value })} />
        </div>
      </div>

      {!summary && <p className="muted">Загрузка…</p>}

      {summary && (
        <>
          <div className="chip-row" style={{ marginBottom: 16 }}>
            <span className="chip"><strong>Всего: {formatMoney(summary.totals.total)} ₽</strong></span>
            <span className="chip">На техников: {formatMoney(summary.totals.technicians)} ₽</span>
            <span className="chip">Мои траты: {formatMoney(summary.totals.owner)} ₽</span>
            <span className="chip">Зарплата: {formatMoney(summary.totals.salary)} ₽</span>
            <span className="chip">Бензин: {formatMoney(summary.totals.fuel)} ₽</span>
            <span className="chip">Прочее у техников: {formatMoney(summary.totals.other)} ₽</span>
          </div>

          {summary.technicians.length === 0 && (
            <p className="muted">За период техники ничего не вносили</p>
          )}

          {summary.technicians.map((person) => (
            <div key={person.staffId ?? person.name} style={{ marginBottom: 20 }}>
              <h4 style={{ margin: '0 0 6px' }}>
                {person.name}
                <span className="muted" style={{ fontWeight: 400 }}>
                  {' '}— всего {formatMoney(person.totals.total)} ₽
                </span>
              </h4>
              <div className="table-wrap scroll-x">
                <table>
                  <thead>
                    <tr>
                      <th>День</th>
                      <th className="num">Зарплата</th>
                      <th className="num">Бензин</th>
                      <th className="num">Прочее</th>
                      <th>На что и чеки</th>
                    </tr>
                  </thead>
                  <tbody>
                    {person.days.map((day) => (
                      <tr key={day.date}>
                        <td className="mono">{humanDate(day.date)}</td>
                        <td className="num">{formatMoney(day.salary)} ₽</td>
                        <td className="num">{formatMoney(day.fuel)} ₽</td>
                        <td className="num">{formatMoney(day.other)} ₽</td>
                        <td className="wrap" style={{ fontSize: 12.5 }}>
                          {day.items.map((item) => (
                            <div key={item.id}>
                              {item.comment} — {formatMoney(item.amount)} ₽
                              {item.photoObjectKey && (
                                <> · <ReceiptLink objectKey={item.photoObjectKey} /></>
                              )}
                            </div>
                          ))}
                        </td>
                      </tr>
                    ))}
                    <tr style={{ fontWeight: 700 }}>
                      <td>Итого</td>
                      <td className="num">{formatMoney(person.totals.salary)} ₽</td>
                      <td className="num">{formatMoney(person.totals.fuel)} ₽</td>
                      <td className="num">{formatMoney(person.totals.other)} ₽</td>
                      <td />
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          <h4 style={{ margin: '0 0 6px' }}>
            Мои траты
            <span className="muted" style={{ fontWeight: 400 }}>
              {' '}— всего {formatMoney(summary.totals.owner)} ₽
            </span>
          </h4>
          {summary.ownerExpenses.length === 0 && <p className="muted">За период своих трат нет</p>}
          {summary.ownerExpenses.length > 0 && (
            <div className="table-wrap scroll-x">
              <table>
                <thead>
                  <tr>
                    <th>Дата</th>
                    <th>Категория</th>
                    <th className="num">Сумма</th>
                    <th>Комментарий</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.ownerExpenses.map((row) => (
                    <tr key={row.id}>
                      <td className="mono">{humanDate(row.date)}</td>
                      <td>{CATEGORY_LABELS[row.category] ?? row.category}</td>
                      <td className="num">{formatMoney(row.amount)} ₽</td>
                      <td className="wrap">
                        {row.comment || '—'}
                        {row.photoObjectKey && (
                          <> · <ReceiptLink objectKey={row.photoObjectKey} /></>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Section>
  );
}
