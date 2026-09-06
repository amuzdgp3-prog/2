/**
 * Штампованная табличка с номером аппарата — сквозной опознавательный знак
 * дизайн-системы (docs/design/mockups/00_design_system.html, .tag-plate).
 *
 * В макетах номер показан как 4-значное число с ведущими нулями (0142), но
 * это иллюстративные данные (см. README макетов): в реальной системе
 * machine_number — произвольная строка (TEXT), не обязательно числовая.
 * Компонент рендерит значение как есть и не придумывает форматирование,
 * которого нет в бизнес-правилах.
 */
export function MachineTag({
  number,
  size = 'md',
}: {
  number: string | number;
  size?: 'md' | 'lg';
}) {
  return (
    <span
      className="tag-plate"
      style={size === 'lg' ? { fontSize: 16, padding: '8px 13px' } : undefined}
    >
      <span className="hash">№</span>
      {number}
    </span>
  );
}
