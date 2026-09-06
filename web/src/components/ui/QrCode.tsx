import { useEffect, useRef } from 'react';
import QRCode from 'qrcode';

/**
 * QR-код аппарата — кодирует прямую ссылку на форму обслуживания, а не голый номер: отсканировав
 * стикер на корпусе штатной камерой телефона (не обязательно из этого приложения), техник сразу
 * попадает в форму нужного аппарата, если уже вошёл в систему.
 */
export function machineQrValue(machineNumber: string): string {
  return `${window.location.origin}/service/${encodeURIComponent(machineNumber)}`;
}

export function QrCode({ value, size = 160 }: { value: string; size?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (canvasRef.current) {
      QRCode.toCanvas(canvasRef.current, value, { width: size, margin: 1 }).catch(() => undefined);
    }
  }, [value, size]);

  return <canvas ref={canvasRef} width={size} height={size} style={{ borderRadius: 'var(--r-md)' }} />;
}
