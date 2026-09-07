import jsQR from 'jsqr';
import { useEffect, useRef, useState } from 'react';

/**
 * Кнопка сканирования QR через камеру устройства — поиск аппарата по стикеру на корпусе, без
 * ручного ввода номера. Скрывается сама, если у браузера нет доступа к камере (например, сайт
 * открыт не по HTTPS или это старый браузер) — тогда просто не занимает место в интерфейсе.
 */
export function QrScannerButton({ onDetect }: { onDetect: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const frameRef = useRef<number>();

  const supported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

  useEffect(() => {
    if (!open) return;

    let cancelled = false;

    const start = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        scanLoop();
      } catch {
        setError('Нет доступа к камере — разрешите доступ в настройках браузера.');
      }
    };

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });

    const scanLoop = () => {
      const video = videoRef.current;
      if (!video || !context || video.readyState !== video.HAVE_ENOUGH_DATA) {
        frameRef.current = requestAnimationFrame(scanLoop);
        return;
      }
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height);
      if (code?.data) {
        onDetect(code.data);
        setOpen(false);
        return;
      }
      frameRef.current = requestAnimationFrame(scanLoop);
    };

    void start();

    return () => {
      cancelled = true;
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, [open, onDetect]);

  if (!supported) return null;

  return (
    <>
      <button className="qr-btn" type="button" onClick={() => { setError(null); setOpen(true); }} title="Сканировать QR">
        ▦
      </button>

      {open && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,.85)', zIndex: 100,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: 20,
          }}
        >
          {error ? (
            <div className="alert error" style={{ maxWidth: 320 }}>{error}</div>
          ) : (
            <video ref={videoRef} muted playsInline style={{ maxWidth: 360, width: '100%', borderRadius: 'var(--r-md)' }} />
          )}
          <button className="btn btn-ghost" style={{ color: '#fff', borderColor: '#fff' }} onClick={() => setOpen(false)}>
            Закрыть
          </button>
        </div>
      )}
    </>
  );
}

/**
 * Достаёт номер аппарата и из полного URL (/service/0142), и из голого номера в старом стикере.
 * Возвращает null, если строка распознана как URL, но не нашего вида (например, случайный сайт
 * или чужая ссылка) — раньше в этом случае функция отдавала URL целиком, из-за чего сообщение об
 * ошибке показывало «Аппарат № https://... не найден» вместо понятного «QR-код не распознан».
 */
export function extractMachineNumber(scanned: string): string | null {
  try {
    const url = new URL(scanned);
    const match = url.pathname.match(/\/service\/([^/]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    // not a URL — treat the raw value as the machine number
    return scanned;
  }
}
