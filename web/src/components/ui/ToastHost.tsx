import { useEffect, useState } from 'react';
import type { ToastEvent } from '../../toast';

const AUTO_DISMISS_MS = 4000;

/**
 * Смонтирован один раз в App, вне маршрутов — тост должен пережить navigate() сразу после
 * showToast (например, переход в /queue после отправки черновика), а не исчезнуть вместе с
 * размонтированным экраном.
 */
export function ToastHost() {
  const [toasts, setToasts] = useState<ToastEvent[]>([]);

  useEffect(() => {
    const onShow = (event: Event) => {
      const toast = (event as CustomEvent<ToastEvent>).detail;
      setToasts((prev) => [...prev, toast]);
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((item) => item.id !== toast.id));
      }, AUTO_DISMISS_MS);
    };
    window.addEventListener('toast:show', onShow);
    return () => window.removeEventListener('toast:show', onShow);
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-host">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.kind}`}>
          {toast.message}
        </div>
      ))}
    </div>
  );
}
