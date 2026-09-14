import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MIN_PAIRS,
  aggregatePairs,
  bootstrapCi,
  coefficientOfVariation,
  filterPairsForPeriod,
  percentile,
  weightedMean,
  weightedVariance,
  withMachineIndex,
  type VisitPair,
} from '../src/domain/technicianEffectiveness.js';

/**
 * Эффективность техника (DECISION-046, закрыт владельцем 14.09.2026). Проверяется ровно то, что
 * было сломано в исходной методике владельца и что мы обещали исправить: деление на ноль,
 * несогласованные веса среднего и дисперсии, нормальное приближение при малых N, размерность
 * «стабильности», нормировка по максимуму и порог доверия.
 */

type RawPair = Omit<VisitPair, 'index'>;

function pair(overrides: Partial<RawPair> & Pick<RawPair, 'machineNumber' | 'revenue'>): RawPair {
  const periodDays = overrides.periodDays ?? 10;
  const toyCostAtSetup = overrides.toyCostAtSetup ?? 100;
  return {
    technicianId: overrides.technicianId ?? 1,
    technicianName: overrides.technicianName ?? 'Техник',
    isFieldTechnician: overrides.isFieldTechnician ?? true,
    machineNumber: overrides.machineNumber,
    setupServiceId: overrides.setupServiceId ?? 1,
    setupDate: overrides.setupDate ?? '2026-09-01',
    closingServiceId: overrides.closingServiceId ?? 2,
    periodDays,
    revenue: overrides.revenue,
    toyCostAtSetup,
    revenuePerDay: overrides.revenue / periodDays,
    returnOnToys: toyCostAtSetup > 0 ? overrides.revenue / toyCostAtSetup : null,
  };
}

describe('статистика эффективности техника', () => {
  it('взвешенное среднее смещается к значению с большим весом', () => {
    // Простое среднее было бы 15; вес 3 у двадцатки тянет результат вверх.
    assert.equal(weightedMean([10, 20], [1, 3]), 17.5);
  });

  it('дисперсия при равных весах совпадает с классической выборочной', () => {
    // Опорная проверка формулы: делитель Σw − Σw²/Σw при одинаковых весах обязан вырождаться
    // в привычное (n−1), иначе взвешенная дисперсия просто неверна.
    assert.equal(weightedVariance([10, 20, 30], [1, 1, 1]), 100);
  });

  it('дисперсия при разных весах отличается от невзвешенной', () => {
    // Та самая ошибка исходной методики: среднее считалось взвешенно, а разброс — нет.
    const variance = weightedVariance([10, 20, 30], [1, 1, 6]);
    assert.ok(variance !== null);
    assert.notEqual(Math.round(variance as number), 100);
    assert.ok(Math.abs((variance as number) - 119.23) < 0.01, `получено ${variance}`);
  });

  it('стабильность безразмерна: умножение всех величин на константу её не меняет', () => {
    const values = [10, 20, 30];
    const weights = [1, 1, 1];
    const base = coefficientOfVariation(values, weights);
    const scaled = coefficientOfVariation(values.map((value) => value * 1000), weights);
    assert.ok(base !== null && scaled !== null);
    assert.ok(Math.abs((base as number) - (scaled as number)) < 1e-12);
  });

  it('перцентиль устойчив к одиночному выбросу, в отличие от максимума', () => {
    const values = [1, 1, 1, 1, 1, 1, 1, 1, 1, 100];
    assert.equal(Math.max(...values), 100);
    const p90 = percentile(values, 0.9);
    assert.ok(p90 !== null && (p90 as number) < 20, `90-й перцентиль должен игнорировать выброс, получено ${p90}`);
  });

  it('доверительный интервал при трёх наблюдениях получается широким, а не узким', () => {
    const values = [0.5, 1.0, 1.5];
    const weights = [10, 10, 10];
    const ci = bootstrapCi(values, weights);
    assert.ok(ci !== null);
    const [low, high] = ci as [number, number];
    assert.ok(low < 1 && high > 1, 'интервал обязан накрывать среднее');
    assert.ok(high - low > 0.3, `при N=3 интервал не может быть узким, получено ${high - low}`);
  });

  it('бутстрэп детерминирован: один и тот же вход даёт один и тот же интервал', () => {
    const values = [0.8, 1.1, 1.4, 0.9];
    const weights = [5, 7, 9, 6];
    assert.deepEqual(bootstrapCi(values, weights), bootstrapCi(values, weights));
  });
});

describe('индекс к собственной норме аппарата', () => {
  it('пара сравнивается с остальными парами того же аппарата, а не сама с собой', () => {
    const pairs = withMachineIndex([
      pair({ machineNumber: 'A', revenue: 1000, periodDays: 10 }), // 100 в сутки
      pair({ machineNumber: 'A', revenue: 1000, periodDays: 10 }), // 100 в сутки
      pair({ machineNumber: 'A', revenue: 2000, periodDays: 10 }), // 200 в сутки
    ]);
    // Норма для третьей пары — медиана двух остальных (100), значит индекс ровно 2.
    assert.equal(pairs[2].index, 2);
    // Для первой пары норма — медиана из 100 и 200, то есть 150.
    assert.ok(Math.abs((pairs[0].index as number) - 100 / 150) < 1e-12);
  });

  it('у аппарата с единственной парой индекса нет: норму по одному наблюдению не построить', () => {
    const pairs = withMachineIndex([pair({ machineNumber: 'ONE', revenue: 500 })]);
    assert.equal(pairs[0].index, null);
  });

  it('разная проходимость точек не смещает сравнение техников', () => {
    // Оба техника отработали ровно на уровне своих аппаратов, но аппараты зарабатывают
    // по-разному. Индекс обязан оказаться одинаковым, иначе метрика меряет маршрут, а не людей.
    const pairs = withMachineIndex([
      pair({ machineNumber: 'BUSY', revenue: 10000, periodDays: 10, technicianId: 1, technicianName: 'Первый' }),
      pair({ machineNumber: 'BUSY', revenue: 10000, periodDays: 10, technicianId: 1, technicianName: 'Первый' }),
      pair({ machineNumber: 'BUSY', revenue: 10000, periodDays: 10, technicianId: 1, technicianName: 'Первый' }),
      pair({ machineNumber: 'QUIET', revenue: 500, periodDays: 10, technicianId: 2, technicianName: 'Второй' }),
      pair({ machineNumber: 'QUIET', revenue: 500, periodDays: 10, technicianId: 2, technicianName: 'Второй' }),
      pair({ machineNumber: 'QUIET', revenue: 500, periodDays: 10, technicianId: 2, technicianName: 'Второй' }),
    ]);
    const report = aggregatePairs(pairs);
    const first = report.rows.find((row) => row.technicianId === 1);
    const second = report.rows.find((row) => row.technicianId === 2);
    assert.ok(first && second);
    assert.equal(first?.index, 1);
    assert.equal(second?.index, 1);
    // При этом «выручка в сутки» у них различается в двадцать раз — потому её и нельзя
    // использовать для сравнения людей между собой.
    assert.equal(first?.revenuePerDay, 1000);
    assert.equal(second?.revenuePerDay, 50);
  });
});

describe('порог доверия и граничные случаи', () => {
  it(`техник с ${MIN_PAIRS - 1} парами оценки не получает, с ${MIN_PAIRS} — получает`, () => {
    const machines = ['A', 'B', 'C', 'D'];
    const build = (count: number, technicianId: number): RawPair[] =>
      Array.from({ length: count }, (_, i) =>
        pair({ machineNumber: machines[i], revenue: 1000, technicianId, technicianName: `Т${technicianId}` }));

    // Пары-«соседи» на тех же аппаратах, чтобы у каждого аппарата была норма для индекса.
    const neighbours = machines.map((machineNumber) =>
      pair({ machineNumber, revenue: 1000, technicianId: 99, technicianName: 'Сосед' }));

    const report = aggregatePairs(withMachineIndex([
      ...build(MIN_PAIRS - 1, 1),
      ...build(MIN_PAIRS, 2),
      ...neighbours,
    ]));

    const below = report.rows.find((row) => row.technicianId === 1);
    const atThreshold = report.rows.find((row) => row.technicianId === 2);
    assert.equal(below?.enoughData, false);
    assert.equal(below?.index, null, 'ниже порога оценка не выдаётся вообще');
    assert.equal(atThreshold?.enoughData, true);
    assert.ok(atThreshold?.index !== null, 'ровно на пороге оценка уже есть');
  });

  it('служебная запись не оценивается, но задаёт норму аппарата', () => {
    // Почти вся история парка записана на служебную запись «Админ». Если выкинуть её пары до
    // расчёта норм, у аппарата с длинной историей сравнивать оказывается не с чем, и полевой
    // техник остаётся без индекса — ровно это и происходило до правки.
    const raw = [
      pair({ machineNumber: 'M', revenue: 1000, technicianId: 2, technicianName: 'Админ', isFieldTechnician: false }),
      pair({ machineNumber: 'M', revenue: 1000, technicianId: 2, technicianName: 'Админ', isFieldTechnician: false }),
      pair({ machineNumber: 'M', revenue: 2000, technicianId: 7, technicianName: 'Полевой' }),
    ];
    const withIndex = withMachineIndex(raw);
    const field = withIndex.find((item) => item.technicianId === 7);
    assert.equal(field?.index, 2, 'норма взялась из пар служебной записи');

    const report = aggregatePairs(filterPairsForPeriod(withIndex, {}));
    assert.equal(report.rows.length, 1, 'в оценке остался только полевой техник');
    assert.equal(report.rows[0].technicianId, 7);
  });

  it('порог применяется к числу пар, на которых держится сама оценка', () => {
    // Шесть выездов, но сравнить можно только два: у остальных аппаратов второго периода нет.
    // Индекс по двум наблюдениям — ровно то, что порог обязан не пропустить, даже если общее
    // число пар выглядит достаточным.
    const pairs = withMachineIndex([
      pair({ machineNumber: 'PAIRED', revenue: 1000, technicianId: 1 }),
      pair({ machineNumber: 'PAIRED', revenue: 1100, technicianId: 1 }),
      pair({ machineNumber: 'SOLO-1', revenue: 1000, technicianId: 1 }),
      pair({ machineNumber: 'SOLO-2', revenue: 1000, technicianId: 1 }),
      pair({ machineNumber: 'SOLO-3', revenue: 1000, technicianId: 1 }),
      pair({ machineNumber: 'SOLO-4', revenue: 1000, technicianId: 1 }),
    ]);
    const row = aggregatePairs(pairs).rows[0];
    assert.equal(row.pairs, 6);
    assert.equal(row.pairsWithIndex, 2);
    assert.equal(row.enoughData, true, 'фактов на шесть выездов хватает');
    assert.equal(row.index, null, 'но индекс по двум парам не показывается');
    assert.equal(row.indexCi, null);
    assert.equal(row.scaled, null);
    assert.ok(row.revenuePerDay > 0, 'факты при этом остаются на месте');
  });

  it('визит без вложенных игрушек не роняет расчёт делением на ноль', () => {
    const pairs = withMachineIndex([
      pair({ machineNumber: 'A', revenue: 1000, toyCostAtSetup: 0 }),
      pair({ machineNumber: 'A', revenue: 1200, toyCostAtSetup: 200 }),
      pair({ machineNumber: 'A', revenue: 900, toyCostAtSetup: 300 }),
    ]);
    assert.equal(pairs[0].returnOnToys, null, 'без игрушек отдача не определена, а не бесконечна');

    const report = aggregatePairs(pairs);
    const row = report.rows[0];
    assert.equal(row.pairs, 3, 'пара без игрушек остаётся в счёте выездов');
    assert.equal(row.pairsWithToys, 2, 'но в метрику отдачи на игрушки не входит');
    assert.ok(Number.isFinite(row.returnOnToys as number));
  });

  it('шкала строится по 90-му перцентилю, а не по лучшей паре', () => {
    // Двадцать ровных пар одного техника и один аномально удачный период у другого.
    const pairs = withMachineIndex([
      ...Array.from({ length: 20 }, () => pair({ machineNumber: 'A', revenue: 1000, technicianId: 1 })),
      pair({ machineNumber: 'B', revenue: 100000, periodDays: 10, technicianId: 2, technicianName: 'Второй' }),
      pair({ machineNumber: 'B', revenue: 1000, periodDays: 10, technicianId: 2, technicianName: 'Второй' }),
      pair({ machineNumber: 'B', revenue: 1000, periodDays: 10, technicianId: 2, technicianName: 'Второй' }),
    ]);
    const report = aggregatePairs(pairs);

    const indices = pairs.filter((item) => item.index !== null).map((item) => item.index as number);
    const fleetMax = Math.max(...indices);
    assert.ok(fleetMax > 50, 'в наборе действительно есть выброс');

    // Ровный техник работает ровно на норме своих аппаратов, значит и шкала обязана показать
    // единицу. При нормировке по максимуму он получил бы сотую долю — только из-за чужого
    // удачного периода; это и был пункт 5 разбора.
    const first = report.rows.find((row) => row.technicianId === 1);
    assert.ok(Math.abs((first?.scaled as number) - 1) < 0.05, `получено ${first?.scaled}`);
    const byMax = (first?.index as number) / fleetMax;
    assert.ok(byMax < 0.05, `нормировка по максимуму дала бы ${byMax}`);
  });
});
