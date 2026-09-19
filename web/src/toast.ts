/**
 * Плоский событийный тост поверх окна, без контекста и провайдера — по тому же принципу, что и
 * api:reachable/api:unreachable в sync.ts: модулю, вызывающему showToast, не нужно знать, смонтирован
 * ли <ToastHost /> и где именно в дереве.
 */
export interface ToastEvent {
  id: number;
  message: string;
  kind: 'ok' | 'error';
}

let nextId = 0;

export function showToast(message: string, kind: ToastEvent['kind'] = 'ok'): void {
  window.dispatchEvent(new CustomEvent<ToastEvent>('toast:show', { detail: { id: nextId++, message, kind } }));
}
