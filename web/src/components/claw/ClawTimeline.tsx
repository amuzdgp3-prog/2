import { formatVolts, payoutLevel, type PayoutBand } from '../../clawAdvice';

/**
 * Три графика друг под другом с общей шкалой периодов (DECISION-090): игр в сутки, отдача с
 * коридором нормы, Weak ступенькой. Две разные величины на одной оси не рисуются — каждая на своей
 * панели; моменты изменений Weak — пунктиром через все три. Наведение на столбец периода
 * показывает его цифры.
 */
export interface ClawPeriodPoint {
  serviceDate: string;
  occurredAt: string;
  days: number;
  games: number;
  gamesPerDay: number | null;
  payoutPercent: number | null;
  revenuePerDay: number | null;
  netPerDay: number | null;
  weak: number | null;
}

const niceCeil = (value: number) => {
  if (value <= 0) return 10;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) if (value <= step * magnitude) return step * magnitude;
  return 10 * magnitude;
};

const dayMonth = (iso: string) => {
  const [, month, day] = iso.split('-');
  return `${day}.${month}`;
};

export function ClawTimeline({ periods, band }: { periods: ClawPeriodPoint[]; band: PayoutBand }) {
  const W = 680;
  const L = 44;
  const R = 12;
  const PH = 74;
  const GAP = 46;
  const TOP = 34;
  const n = periods.length;
  const cw = (W - L - R) / n;
  const cx = (index: number) => L + cw * index + cw / 2;

  const gamesMax = niceCeil(Math.max(...periods.map((p) => p.gamesPerDay ?? 0)) * 1.1);
  const payoutMax = niceCeil(Math.max(band.high * 1.2, ...periods.map((p) => p.payoutPercent ?? 0)));
  const weaks = periods.map((p) => p.weak).filter((value): value is number => value !== null);
  const weakMin = weaks.length ? Math.floor((Math.min(...weaks) - 0.2) * 5) / 5 : 0;
  const weakMax = weaks.length ? Math.ceil((Math.max(...weaks) + 0.2) * 5) / 5 : 1;

  const panels = [
    { title: 'Игр в сутки', min: 0, max: gamesMax, ticks: [0, gamesMax / 2, gamesMax], digits: 0 },
    { title: 'Отдача, % выручки', min: 0, max: payoutMax, ticks: [0, payoutMax / 2, payoutMax], digits: 0 },
    { title: 'Weak, В', min: weakMin, max: weakMax, ticks: [weakMin, (weakMin + weakMax) / 2, weakMax], digits: 1 },
  ];
  const y0 = (k: number) => TOP + k * (PH + GAP);
  const Y = (k: number, value: number) => {
    const panel = panels[k];
    return y0(k) + PH - ((value - panel.min) / (panel.max - panel.min || 1)) * PH;
  };
  const height = y0(2) + PH + 24;
  const barWidth = Math.min(26, cw - 8);

  const changes = periods
    .map((p, index) => ({ p, index }))
    .filter(({ p, index }) => index > 0 && p.weak !== null && periods[index - 1].weak !== null && p.weak !== periods[index - 1].weak);

  const payoutPoints = periods
    .map((p, index) => (p.payoutPercent === null ? null : `${cx(index)},${Y(1, Math.min(p.payoutPercent, payoutMax))}`))
    .filter(Boolean)
    .join(' ');

  let weakPath = '';
  periods.forEach((p, index) => {
    if (p.weak === null) return;
    const x0 = L + cw * index;
    weakPath += `${weakPath ? 'L' : 'M'}${x0} ${Y(2, p.weak)} L${x0 + cw} ${Y(2, p.weak)} `;
  });

  // Подписи дат — не чаще, чем помещаются.
  const labelEvery = Math.max(1, Math.ceil(n / 9));

  return (
    <div className="scroll-x">
      <svg className="claw-chart" viewBox={`0 0 ${W} ${height}`} role="img" aria-label="Игры в сутки, отдача и Weak по периодам">
        {panels.map((panel, k) => (
          <g key={panel.title}>
            <text className="ttl" x={0} y={y0(k) - 16}>{panel.title}</text>
            {panel.ticks.map((tick) => (
              <g key={tick}>
                <line className="grid" x1={L} x2={W - R} y1={Y(k, tick)} y2={Y(k, tick)} />
                <text x={L - 6} y={Y(k, tick) + 3.5} textAnchor="end">
                  {panel.digits ? formatVolts(tick) : Math.round(tick)}
                </text>
              </g>
            ))}
          </g>
        ))}

        <rect className="band" x={L} width={W - L - R} y={Y(1, Math.min(band.high, payoutMax))} height={Y(1, band.low) - Y(1, Math.min(band.high, payoutMax))} />
        <text className="band-label" x={W - R - 4} y={Y(1, Math.min(band.high, payoutMax)) - 4} textAnchor="end">
          норма {formatVolts(band.low)}–{formatVolts(band.high)} %
        </text>

        {periods.map((p, index) =>
          p.gamesPerDay === null ? null : (
            <path
              key={`bar-${index}`}
              className="bar"
              d={`M${cx(index) - barWidth / 2} ${Y(0, 0)} V${Y(0, Math.min(p.gamesPerDay, gamesMax)) + 3} q0 -3 3 -3 H${cx(index) + barWidth / 2 - 3} q3 0 3 3 V${Y(0, 0)} Z`}
            />
          ),
        )}

        <polyline className="line" points={payoutPoints} />
        {periods.map((p, index) =>
          p.payoutPercent === null ? null : (
            <circle
              key={`pt-${index}`}
              className={`pt tci-${payoutLevel(p.payoutPercent, band)}`}
              cx={cx(index)}
              cy={Y(1, Math.min(p.payoutPercent, payoutMax))}
              r={4.5}
            />
          ),
        )}

        {weakPath && <path className="step" d={weakPath} />}

        {changes.map(({ p, index }) => {
          const x = L + cw * index;
          return (
            <g key={`chg-${index}`}>
              <line className="chg" x1={x} x2={x} y1={TOP - 8} y2={y0(2) + PH} />
              <text className="chgl" x={x + 4} y={TOP - 10}>
                {formatVolts(periods[index - 1].weak)}→{formatVolts(p.weak)}
              </text>
            </g>
          );
        })}

        {periods.map((p, index) => (
          <g key={`lbl-${index}`}>
            {index % labelEvery === 0 && (
              <text x={cx(index)} y={y0(2) + PH + 16} textAnchor="middle">{dayMonth(p.serviceDate)}</text>
            )}
            <rect x={L + cw * index} y={TOP - 4} width={cw} height={y0(2) + PH - TOP + 6} fill="transparent">
              <title>
                {`${dayMonth(p.serviceDate)}: ${p.gamesPerDay === null ? '—' : Math.round(p.gamesPerDay)} игр в сутки · отдача ${p.payoutPercent === null ? '—' : Math.round(p.payoutPercent) + ' %'} · Weak ${formatVolts(p.weak)} В`}
              </title>
            </rect>
          </g>
        ))}
      </svg>
      <div className="claw-legend">
        <span><i className="sw bar" />игр в сутки</span>
        <span><i className="sw band" />коридор нормы</span>
        <span><i className="sw step" />Weak и моменты изменений</span>
        <span className="muted">наведите на столбец — цифры периода</span>
      </div>
    </div>
  );
}
