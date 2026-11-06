import { useEffect, useState } from 'react';
import { api } from '../../api';

/**
 * Миниатюра фото, которая по клику открывается на весь экран. Раньше фото счётчика показывалось
 * только маленьким превью без возможности увеличить — не разглядеть показания на снимке.
 */
export function PhotoThumbnail({ objectKey, alt, label }: { objectKey: string; alt: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const [photo, setPhoto] = useState<{ key: string; url: string | null } | null>(null);
  const load = !label || open;

  useEffect(() => {
    if (!load) return;
    let active = true;
    let url: string | undefined;
    const key = objectKey.split('/').map(encodeURIComponent).join('/');
    void api.getBlob(`/api/photos/${key}`).then((blob) => {
      if (!active) return;
      url = URL.createObjectURL(blob);
      setPhoto({ key: objectKey, url });
    }).catch(() => {
      if (active) setPhoto({ key: objectKey, url: null });
    });
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [objectKey, load]);

  const current = photo?.key === objectKey ? photo : null;
  const close = () => {
    if (label) setPhoto(null);
    setOpen(false);
  };

  return (
    <>
      {label ? (
        <button type="button" aria-label={alt} onClick={() => setOpen(true)}
          style={{ padding: 0, border: 0, background: 'none', cursor: 'pointer', color: 'inherit' }}>{label}</button>
      ) : current?.url ? <img
        className="photo-thumb"
        style={{ cursor: 'zoom-in' }}
        src={current.url}
        alt={alt}
        onClick={() => setOpen(true)}
      /> : <span className="muted">{current ? 'Фото недоступно' : 'Загрузка фото…'}</span>}

      {open && (
        <div
          onClick={close}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,.9)', zIndex: 100,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, cursor: 'zoom-out',
          }}
        >
          {current?.url
            ? <img src={current.url} alt={alt} style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 'var(--r-md)' }} />
            : <span style={{ color: 'white' }}>{current ? 'Фото недоступно' : 'Загрузка фото…'}</span>}
        </div>
      )}
    </>
  );
}
