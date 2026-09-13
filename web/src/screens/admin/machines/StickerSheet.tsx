import { machineQrValue, QrCode } from '../../../components/ui/QrCode';
import type { Machine } from '../types';

/**
 * Лист наклеек на аппараты: QR-код (та же ссылка на форму обслуживания, что и на экране «История»,
 * components/ui/QrCode.tsx) плюс адрес точки. Печатается через window.print() и CSS в styles.css
 * (`.sticker-print-sheet`), а не отдельным PDF — в web нет ни одной PDF-библиотеки, а печать
 * браузера уже даёт сохранение в PDF там, где это нужно, без новой зависимости.
 *
 * Размер наклейки 7×3 см, 3 в ряд — то же соотношение, что в generate_stickers.py (офлайн-скрипт
 * владельца для наклеек по свободному списку адресов, не связанному с базой). Эта форма кладёт на
 * наклейку реальный адрес аппарата из базы и добавляет QR-код, которого в том скрипте не было.
 */
export function StickerSheet({ machines }: { machines: Machine[] }) {
  return (
    <div className="sticker-print-sheet">
      <div className="sticker-grid">
        {machines.map((machine) => (
          <div className="sticker-label" key={machine.machine_number}>
            <QrCode value={machineQrValue(machine.machine_number)} size={72} />
            <div className="sticker-label-text">
              <div className="sticker-label-number">№ {machine.machine_number}</div>
              <div className="sticker-label-address">{machine.address ?? machine.location_name ?? ''}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
