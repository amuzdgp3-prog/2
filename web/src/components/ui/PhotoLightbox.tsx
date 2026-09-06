import { useState } from 'react';

/**
 * Миниатюра фото, которая по клику открывается на весь экран. Раньше фото счётчика показывалось
 * только маленьким превью без возможности увеличить — не разглядеть показания на снимке.
 */
export function PhotoThumbnail({ src, alt }: { src: string; alt: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <img
        className="photo-thumb"
        style={{ cursor: 'zoom-in' }}
        src={src}
        alt={alt}
        onClick={() => setOpen(true)}
      />

      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,.9)', zIndex: 100,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, cursor: 'zoom-out',
          }}
        >
          <img src={src} alt={alt} style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 'var(--r-md)' }} />
        </div>
      )}
    </>
  );
}
