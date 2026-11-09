import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { formatDate } from '../../dateFormat';
import type { TabProps } from './types';
import './PhotosTab.css';

interface PhotoPair {
  local_id: string;
  service_date: string;
  machine_number: string;
  address: string;
  technician_name: string | null;
  photo_1: string | null;
  photo_2: string | null;
}

interface PhotoPage { rows: PhotoPair[]; total: number; limit: number; offset: number }
interface Technician { id: number; full_name: string; role: string }
interface ViewerPhoto { path: string; caption: string }

function PhotoImage({ path, alt }: { path: string; alt: string }) {
  const node = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = node.current;
    if (!element) return;
    let active = true;
    let objectUrl: string | null = null;
    const observer = new IntersectionObserver((entries) => {
      if (!entries[0]?.isIntersecting) return;
      observer.disconnect();
      void api.getBlob(path).then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      }).catch(() => { if (active) setFailed(true); });
    }, { rootMargin: '300px' });
    observer.observe(element);
    return () => { active = false; observer.disconnect(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [path]);
  return <div ref={node} className="service-photo-image">
    {url ? <img src={url} alt={alt} /> : <span>{failed ? 'Фото недоступно' : 'Загрузка…'}</span>}
  </div>;
}

function ViewerImage({ path, caption, zoom }: ViewerPhoto & { zoom: number }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    setUrl(null);
    setFailed(false);
    void api.getBlob(path).then((blob) => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [path]);
  return url ? <img src={url} alt={caption} style={{ width: `${zoom * 100}%`, maxHeight: zoom === 1 ? '78vh' : 'none' }} />
    : <span>{failed ? 'Фото недоступно' : 'Загрузка фото…'}</span>;
}

export function PhotosTab({ onError }: TabProps) {
  const errorRef = useRef(onError);
  errorRef.current = onError;
  const touchStart = useRef<number | null>(null);
  const [date, setDate] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [technicianId, setTechnicianId] = useState('');
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState({ date: '', dateTo: '', technicianId: '', search: '' });
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<PhotoPage>({ rows: [], total: 0, limit: 30, offset: 0 });
  const [technicians, setTechnicians] = useState<Technician[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    api.get<Technician[]>('/api/staff')
      .then((staff) => setTechnicians(staff.filter((person) => person.role === 'TECHNICIAN')))
      .catch((error) => errorRef.current(error));
  }, []);

  useEffect(() => {
    const query = new URLSearchParams({ limit: '30', offset: String(offset) });
    if (applied.date) {
      query.set('from', applied.date);
      query.set('to', applied.dateTo || applied.date);
    }
    if (applied.technicianId) query.set('technicianId', applied.technicianId);
    if (applied.search) query.set('search', applied.search);
    let cancelled = false;
    setLoading(true);
    api.get<PhotoPage>(`/api/service-photos?${query}`)
      .then((result) => { if (!cancelled) setPage(result); })
      .catch((error) => { if (!cancelled) errorRef.current(error); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [applied, offset]);

  const photos = useMemo<ViewerPhoto[]>(() => page.rows.flatMap((row) => {
    const caption = `${row.address} · №${row.machine_number} · ${formatDate(row.service_date)} · ${row.technician_name ?? 'Техник не указан'}`;
    return ([row.photo_1, row.photo_2] as const).flatMap((key, slot) => key ? [{
      path: `/api/service-photos/${row.local_id}/${slot + 1}`,
      caption,
    }] : []);
  }), [page.rows]);

  const selected = viewerIndex === null ? null : photos[viewerIndex];
  useEffect(() => {
    if (!selected) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setViewerIndex(null);
      if (event.key === 'ArrowRight') { setViewerIndex((index) => index === null ? null : Math.min(index + 1, photos.length - 1)); setZoom(1); }
      if (event.key === 'ArrowLeft') { setViewerIndex((index) => index === null ? null : Math.max(index - 1, 0)); setZoom(1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, photos.length]);

  let photoIndex = 0;
  return (
    <section className="service-photos">
      <h2>Фото</h2>
      <p className="muted">Фотографии обслуживания хранятся 30 дней после загрузки.</p>
      <form className="service-photo-filters" onSubmit={(event) => {
        event.preventDefault();
        setOffset(0);
        setApplied({ date, dateTo, technicianId, search: search.trim() });
      }}>
        <label>Дата<input type="date" value={date} onChange={(event) => { setDate(event.target.value); if (!event.target.value) setDateTo(''); }} /></label>
        <label>По дату<input type="date" value={dateTo} min={date || undefined} disabled={!date} onChange={(event) => setDateTo(event.target.value)} /></label>
        <label>Техник<select value={technicianId} onChange={(event) => setTechnicianId(event.target.value)}>
          <option value="">Все техники</option>
          {technicians.map((person) => <option key={person.id} value={person.id}>{person.full_name}</option>)}
        </select></label>
        <label>Адрес или № аппарата<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Поиск" /></label>
        <button className="btn btn-primary" type="submit">Показать</button>
        <button className="btn btn-ghost" type="button" onClick={() => {
          setDate(''); setDateTo(''); setTechnicianId(''); setSearch(''); setOffset(0);
          setApplied({ date: '', dateTo: '', technicianId: '', search: '' });
        }}>Сбросить</button>
      </form>

      {loading ? <p className="muted">Загружаем фото…</p> : page.rows.length === 0 ? (
        <p className="muted">По выбранным фильтрам фотографий нет.</p>
      ) : (
        <>
          <div className="service-photo-grid">
            {page.rows.map((row) => (
              <div className="service-photo-pair" key={row.local_id}>
                <div className="service-photo-pair-images">
                  {([row.photo_1, row.photo_2] as const).map((key, slot) => {
                    if (!key) return <div className="service-photo-empty" key={slot}>Фото удалено</div>;
                    const index = photoIndex++;
                    return <button key={slot} type="button" onClick={() => { setViewerIndex(index); setZoom(1); }} aria-label={`Открыть фото аппарата ${row.machine_number}`}>
                      <PhotoImage path={`/api/service-photos/${row.local_id}/${slot + 1}?thumbnail=1`} alt={`Аппарат ${row.machine_number}`} />
                    </button>;
                  })}
                </div>
                <div className="service-photo-caption">{row.address} · №{row.machine_number} · {formatDate(row.service_date)} · {row.technician_name ?? 'Техник не указан'}</div>
              </div>
            ))}
          </div>
          <div className="service-photo-pages">
            <button className="btn btn-ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 30))}>← Ранее</button>
            <span>{offset + 1}–{Math.min(offset + page.rows.length, page.total)} из {page.total}</span>
            <button className="btn btn-ghost" disabled={offset + page.rows.length >= page.total} onClick={() => setOffset(offset + 30)}>Далее →</button>
          </div>
        </>
      )}

      {selected && <div className="service-photo-viewer" role="dialog" aria-modal="true" aria-label="Просмотр фото">
        <div className="service-photo-viewer-bar">
          <span>{selected.caption}</span>
          <button type="button" onClick={() => setZoom((value) => Math.max(1, value - 0.5))}>−</button>
          <button type="button" onClick={() => setZoom((value) => Math.min(4, value + 0.5))}>＋</button>
          <button type="button" onClick={() => setViewerIndex(null)} aria-label="Закрыть">✕</button>
        </div>
        <div className="service-photo-viewer-body">
          <button type="button" disabled={viewerIndex === 0} onClick={() => { setViewerIndex((viewerIndex ?? 0) - 1); setZoom(1); }} aria-label="Предыдущее фото">‹</button>
          <div className="service-photo-zoom"
            onTouchStart={(event) => { touchStart.current = event.touches[0]?.clientX ?? null; }}
            onTouchEnd={(event) => {
              if (touchStart.current === null || zoom !== 1) return;
              const distance = (event.changedTouches[0]?.clientX ?? touchStart.current) - touchStart.current;
              if (Math.abs(distance) > 60) {
                setViewerIndex((index) => index === null ? null : Math.max(0, Math.min(photos.length - 1, index + (distance < 0 ? 1 : -1))));
              }
              touchStart.current = null;
            }}>
            <ViewerImage path={selected.path} caption={selected.caption} zoom={zoom} />
          </div>
          <button type="button" disabled={viewerIndex === photos.length - 1} onClick={() => { setViewerIndex((viewerIndex ?? 0) + 1); setZoom(1); }} aria-label="Следующее фото">›</button>
        </div>
        <div className="service-photo-viewer-count">{(viewerIndex ?? 0) + 1} из {photos.length}</div>
      </div>}
    </section>
  );
}
