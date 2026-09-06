const PAGE_SIZES = [50, 100, 500] as const;

/** Единая настройка «строк на странице» для списков (Журнал/Аудит/Безнал) — 50/100/500. */
export function PageSizeSelect({ value, onChange }: { value: number; onChange: (size: number) => void }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
      <span className="muted">Строк:</span>
      <select value={value} onChange={(event) => onChange(Number(event.target.value))}>
        {PAGE_SIZES.map((size) => (
          <option key={size} value={size}>{size}</option>
        ))}
      </select>
    </label>
  );
}
