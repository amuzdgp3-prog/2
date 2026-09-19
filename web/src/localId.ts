/**
 * Идентификатор записи, создаваемый на телефоне (UUID v4).
 *
 * `crypto.randomUUID()` доступна только в защищённом контексте (HTTPS или localhost) и в iOS
 * начиная с 15.4: при заходе по обычному HTTP или со старого iPhone вызов падает с
 * «crypto.randomUUID is not a function», и обслуживание не сохраняется. `getRandomValues`
 * доступна везде, поэтому им заменяем недостающую функцию — формат UUID v4 тот же, и сервер
 * принимает его по прежнему шаблону.
 */
export function newLocalId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // версия 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // вариант RFC 4122
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
