/**
 * Фото счётчика как байты, а не как `Blob`/`File`.
 *
 * На iOS (WebKit) `Blob`, положенный в IndexedDB и прочитанный обратно, нередко оказывается
 * пустым или ссылается на уже удалённый временный файл Камеры/Галереи. Такой объект при отправке
 * даёт multipart без содержимого, и сервер отвечает `FILE_REQUIRED` («нужен файл фотографии»),
 * хотя в форме фото было видно. Байты (`ArrayBuffer`) живут в IndexedDB как обычные данные, поэтому
 * фото сначала целиком читается в память, а `Blob` для отправки собирается заново.
 */

export class EmptyPhotoError extends Error {
  constructor() {
    super('Снимок не прочитался (0 байт). Сфотографируйте счётчик ещё раз.');
    this.name = 'EmptyPhotoError';
  }
}

/** Читает файл целиком; бросает EmptyPhotoError, если содержимого нет. */
export async function photoToBytes(photo: Blob): Promise<ArrayBuffer> {
  const bytes = await readBlob(photo);
  if (bytes.byteLength === 0) throw new EmptyPhotoError();
  return bytes;
}

export function bytesToPhoto(bytes: ArrayBuffer, type: string): Blob {
  return new Blob([bytes], { type: type || 'image/jpeg' });
}

/** `Blob.arrayBuffer()` есть не во всех версиях Safari — при его отсутствии читаем через FileReader. */
function readBlob(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('не удалось прочитать фото'));
    reader.readAsArrayBuffer(blob);
  });
}
