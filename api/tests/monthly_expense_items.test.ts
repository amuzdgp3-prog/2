import assert from 'node:assert/strict';
import { it } from 'node:test';
import { groupMonthlyExpenseItems } from '../src/domain/monthlyExpenseItems.js';
import { sumDecimal } from '../src/domain/reports.js';

it('combines standalone ZSD, parking and repeated comments with exact amounts', () => {
  const input = [
    { label: 'ЗСД', amount: '100.10' },
    { label: 'зсд 135 р.', amount: '135.20' },
    { label: '200 парковка', amount: '200.00' },
    { label: 'Парковка', amount: '50.00' },
    { label: '  Проверка  терминалов ', amount: '0.10' },
    { label: 'проверка терминалов', amount: '0.20' },
  ];
  assert.deepEqual(groupMonthlyExpenseItems(input), [
    { label: 'ЗСД', amount: '235.30' },
    { label: 'Парковка', amount: '250.00' },
    { label: 'Проверка терминалов', amount: '0.30' },
  ]);
  assert.equal(input[4].label, '  Проверка  терминалов ');
});

it('preserves combined and unrelated comments and reconciles the total', () => {
  const input = [
    { label: 'ЗСД270 парковка 200', amount: '470.00' },
    { label: 'Парковка200+ЗСД135+Яндекс доставка 2000+1000', amount: '3335.00' },
    { label: 'ЗСД270,Яндекс доставка 2353,водителю1000', amount: '3623.00' },
    { label: 'Ремонт парковки', amount: '100.00' },
    { label: 'ЗСД', amount: '-10.00' },
  ];
  const result = groupMonthlyExpenseItems(input);
  assert.deepEqual(result, input);
  assert.equal(sumDecimal(result.map(item => item.amount), 2), sumDecimal(input.map(item => item.amount), 2));
});

it('handles missing comments and an empty month', () => {
  assert.deepEqual(groupMonthlyExpenseItems([]), []);
  assert.deepEqual(groupMonthlyExpenseItems([{ label: ' ', amount: '1.00' }, { label: 'Без комментария', amount: '2.00' }]), [
    { label: 'Без комментария', amount: '3.00' },
  ]);
});
