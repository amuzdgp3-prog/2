import type { OwnerMonthExpenseItem } from './ownerMonthReport.js';
import { sumDecimal } from './reports.js';

/** Группировка комментариев только для Excel; смешанные расходы сохраняют исходный смысл. */
export function groupMonthlyExpenseItems(items: OwnerMonthExpenseItem[]): OwnerMonthExpenseItem[] {
  const groups = new Map<string, { label: string; amounts: string[] }>();
  for (const item of items) {
    let label = item.label.trim().replace(/\s+/gu, ' ') || 'Без комментария';
    const normalized = label.toLocaleLowerCase('ru-RU').replace(/ё/gu, 'е');
    const hasZsd = /зсд/u.test(normalized);
    const hasParking = /парковк(?:а|и|у|е|ой)/u.test(normalized);
    const remainder = normalized
      .replace(/зсд|парковк(?:а|и|у|е|ой)/gu, '')
      .replace(/руб(?:лей|ля|ль)?\.?|р\.?|₽/gu, '')
      .replace(/[\d\s.,:;+\-—()]/gu, '');
    let key = `comment:${normalized}`;
    if (remainder === '' && hasZsd !== hasParking) {
      key = hasZsd ? 'category:zsd' : 'category:parking';
      label = hasZsd ? 'ЗСД' : 'Парковка';
    }
    const group = groups.get(key);
    if (group) group.amounts.push(item.amount);
    else groups.set(key, { label, amounts: [item.amount] });
  }
  return [...groups.values()].map(({ label, amounts }) => ({ label, amount: sumDecimal(amounts, 2) }));
}
