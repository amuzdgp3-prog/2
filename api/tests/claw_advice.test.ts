import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  adviseClaw,
  clawChangeEffect,
  payoutBand,
  payoutLevel,
  type ClawLimits,
  type ClawValues,
} from '../src/domain/clawAdvice.js';

/**
 * Совет по настройкам клешни (DECISION-090). Чистая функция: проверяются пороги, которые
 * согласовал владелец, — норма ±10 % от цели, совет не раньше 300 игр, шаг Weak 0,2 В, переход на
 * Medium у границы Weak.
 */
const limits: ClawLimits = {
  weakStep: 0.2,
  strongStep: 1,
  mediumStep: 1,
  weakMin: 8,
  weakMax: 15,
  strongMin: 10,
  strongMax: 45,
  mediumMin: 10,
  mediumMax: 35,
};
const values = (weak: number | null, medium: number | null = 30, strong: number | null = 40): ClawValues => ({
  strong,
  medium,
  weak,
  prizeSet: 10,
});
// Выручка 100 000 ₽ — затраты в рублях совпадают с процентом × 1000.
const totals = (games: number, percent: number) => ({ games, revenue: 100_000, toyCost: percent * 1000 });

describe('коридор нормы отдачи', () => {
  it('норма — цель ±10 % от самой цели', () => {
    assert.deepEqual(payoutBand(35), { target: 35, low: 31.5, high: 38.5 });
  });

  it('без цели — прежняя общая вилка 25–40 %', () => {
    assert.deepEqual(payoutBand(null), { target: null, low: 25, high: 40 });
  });

  it('границы коридора входят в норму', () => {
    const band = payoutBand(35);
    assert.equal(payoutLevel(31.5, band), 'ok');
    assert.equal(payoutLevel(38.5, band), 'ok');
    assert.equal(payoutLevel(31.4, band), 'low');
    assert.equal(payoutLevel(38.6, band), 'high');
  });
});

describe('совет по настройкам клешни', () => {
  const band = payoutBand(35);

  it('Weak не вносился — совета нет', () => {
    const { advice } = adviseClaw({ current: values(null), limits, band, totals: totals(500, 20) });
    assert.equal(advice.kind, 'no-settings');
  });

  it('без выручки отдачу не посчитать', () => {
    const { advice } = adviseClaw({
      current: values(12.4), limits, band, totals: { games: 0, revenue: 0, toyCost: 0 },
    });
    assert.equal(advice.kind, 'no-data');
  });

  it('меньше 300 игр — рано судить, даже при сильном отклонении', () => {
    const { advice } = adviseClaw({ current: values(12.4), limits, band, totals: totals(299, 5) });
    assert.equal(advice.kind, 'early');
  });

  it('в коридоре — не менять', () => {
    const { advice } = adviseClaw({ current: values(12.4), limits, band, totals: totals(800, 34) });
    assert.equal(advice.kind, 'ok');
  });

  it('отдаёт мало — прибавить Weak на шаг 0,2 без двоичного хвоста', () => {
    const { advice } = adviseClaw({ current: values(12.4), limits, band, totals: totals(300, 26) });
    assert.deepEqual(advice, {
      kind: 'change', param: 'weak', direction: 'raise', from: 12.4, to: 12.6, games: 300, payoutPercent: 26,
    });
  });

  it('отдаёт много — убавить Weak', () => {
    const { advice } = adviseClaw({ current: values(12.4), limits, band, totals: totals(900, 47) });
    assert.equal(advice.kind, 'change');
    if (advice.kind === 'change') {
      assert.equal(advice.direction, 'lower');
      assert.equal(advice.to, 12.2);
    }
  });

  it('Weak у верхней границы — совет переходит на Medium', () => {
    const { advice } = adviseClaw({ current: values(15), limits, band, totals: totals(900, 20) });
    assert.deepEqual(advice, {
      kind: 'change', param: 'medium', direction: 'raise', from: 30, to: 31, games: 900, payoutPercent: 20,
    });
  });

  it('Weak и Medium у границы — дело не в настройках', () => {
    const { advice } = adviseClaw({ current: values(15, 35), limits, band, totals: totals(900, 20) });
    assert.equal(advice.kind, 'limit');
  });

  it('без границ Weak на типе совет по Weak не упирается', () => {
    const open = { ...limits, weakMin: null, weakMax: null };
    const { advice } = adviseClaw({ current: values(30), limits: open, band, totals: totals(900, 20) });
    assert.equal(advice.kind === 'change' && advice.param, 'weak');
  });

  it('Weak больше Medium — предупреждение о противоречии', () => {
    const { warnings } = adviseClaw({ current: values(31, 30), limits, band, totals: totals(900, 34) });
    assert.deepEqual(warnings, ['order']);
  });
});

describe('эффект изменения настроек', () => {
  it('рост игр считается с поправкой на фон типа', () => {
    const effect = clawChangeEffect({
      before: { days: 14, games: 1000, revenue: 100_000, toyCost: 22_000 },
      after: { days: 14, games: 1060, revenue: 106_000, toyCost: 27_560 },
      typeBefore: { days: 140, games: 10_000, revenue: 1_000_000, toyCost: 250_000 },
      typeAfter: { days: 140, games: 10_200, revenue: 1_020_000, toyCost: 255_000 },
      complete: true,
    });
    assert.equal(Math.round(effect.paceChangePercent!), 6);
    assert.equal(Math.round(effect.typePaceChangePercent!), 2);
    assert.equal(Math.round(effect.paceAdjustedPercent!), 4);
    assert.equal(Math.round(effect.payoutBefore!), 22);
    assert.equal(Math.round(effect.payoutAfter!), 26);
    // Игр больше, но игрушек ушло больше — чистыми почти без изменений.
    assert.ok(Math.abs(effect.netChangePercent!) < 1);
  });

  it('пустое окно не даёт деления на ноль', () => {
    const effect = clawChangeEffect({
      before: { days: 0, games: 0, revenue: 0, toyCost: 0 },
      after: { days: 3, games: 100, revenue: 10_000, toyCost: 2_000 },
      typeBefore: null,
      typeAfter: null,
      complete: false,
    });
    assert.equal(effect.paceChangePercent, null);
    assert.equal(effect.paceAdjustedPercent, null);
    assert.equal(effect.complete, false);
  });
});
