import { machineQrValue, QrCode } from '../../../components/ui/QrCode';
import type { Machine } from '../types';

/**
 * Лист наклеек на аппараты: QR-код (та же ссылка на форму обслуживания, что и на экране «История»,
 * components/ui/QrCode.tsx) плюс адрес точки. Печатается через window.print() и CSS в styles.css
 * (`.sticker-print-sheet`), а не отдельным PDF — в web нет ни одной PDF-библиотеки, а печать
 * браузера уже даёт сохранение в PDF там, где это нужно, без новой зависимости.
 *
 * Размер наклейки 7×6.5 см по требованию владельца: крупный QR-код сверху, под ним адрес. Число
 * колонок подбирается под ширину листа, см. .sticker-grid в styles.css. Офлайн-скрипт владельца
 * generate_stickers.py делал наклейки 7×3 см по свободному списку адресов, не связанному с базой,
 * и без QR-кода; эта форма берёт реальный адрес аппарата из базы.
 */
export function StickerSheet({ machines }: { machines: Machine[] }) {
  return (
    <div className="sticker-print-sheet">
      <div className="sticker-grid">
        {machines.map((machine) => (
          <div className="sticker-label" key={machine.machine_number}>
            {/* 140px ≈ 3.7 см — максимум, при котором под кодом остаётся место на две строки адреса. */}
            <QrCode value={machineQrValue(machine.machine_number)} size={140} />
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
