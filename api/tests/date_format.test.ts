import assert from 'node:assert/strict';
import { it } from 'node:test';
import { formatDate, formatDateTime, formatTime } from '../../web/src/dateFormat.ts';

it('formats business dates without a timezone shift', () => {
  assert.equal(formatDate('2026-11-05'), '05.11.26');
  assert.equal(formatDate('2001-01-02'), '02.01.01');
});

it('formats timestamps with a two-digit year and no seconds or comma', () => {
  const date = new Date(2026, 10, 5, 14, 30, 59);
  assert.equal(formatDate(date), '05.11.26');
  assert.equal(formatTime(date), '14:30');
  assert.equal(formatDateTime(date), '05.11.26 14:30');
  assert.equal(formatDateTime(date.toISOString()), '05.11.26 14:30');
});

it('shows a placeholder for missing or invalid timestamps', () => {
  for (const value of [null, undefined, '', 'invalid', new Date(NaN)]) {
    assert.equal(formatDate(value), '—');
    assert.equal(formatTime(value), '—');
    assert.equal(formatDateTime(value), '—');
  }
});
