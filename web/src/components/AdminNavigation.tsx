import { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

const groups = [
  { label: 'Работа', links: [
    { to: '/log', label: 'Журнал', icon: '☰' },
    { to: '/', label: 'Аппараты', icon: '▦' },
    { to: '/admin?tab=tasks', label: 'Задачи', icon: '☑' },
    { to: '/admin?tab=reviews', label: 'Проверка обслуживаний', icon: '✓' },
  ] },
  { label: 'Финансы', links: [
    { to: '/cash-collections', label: 'Инкассация', icon: '₽' },
    { to: '/dashboard', label: 'Сводка', icon: '◧' },
    { to: '/owner-report', label: 'Отчёт владельцу', icon: '▤' },
    { to: '/reports', label: 'Отчёты и выгрузки', icon: '↗' },
  ] },
  { label: 'Управление', links: [
    { to: '/admin', label: 'Управление', icon: '⚙' },
  ] },
];

export function AdminNavigation({ mobile = false, drafts = 0, queued = 0 }: {
  mobile?: boolean; drafts?: number; queued?: number;
}) {
  const location = useLocation();
  const [more, setMore] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => { setMore(false); }, [location.pathname, location.search]);
  useEffect(() => {
    if (!more) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setMore(false); toggle.current?.focus(); }
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [more]);

  const renderLink = (link: { to: string; label: string; icon: string }) => {
    const [path, search = ''] = link.to.split('?');
    const active = location.pathname === path &&
      (path !== '/admin' || (search ? location.search === `?${search}` :
        !['?tab=tasks', '?tab=reviews'].includes(location.search)));
    return <NavLink key={link.to} to={link.to} end={path === '/'} onClick={() => setMore(false)}
      className={() => active ? 'active' : ''} aria-current={active ? 'page' : false}>
      <span aria-hidden="true">{link.icon}</span>{link.label}
    </NavLink>;
  };
  const draftLink = drafts > 0 && renderLink({ to: '/queue', label: `Черновики${queued ? ` (${queued})` : ''}`, icon: '✎' });

  if (!mobile) return <nav className="admin-sidebar-nav" aria-label="Разделы администратора">
    {groups.map(group => <div className="admin-nav-group" key={group.label}>
      <div className="admin-nav-label">{group.label}</div>
      {group.links.map(renderLink)}
      {group.label === 'Работа' && draftLink}
    </div>)}
  </nav>;

  const primary = [groups[0].links[0], groups[0].links[1], groups[1].links[0], groups[1].links[1]];
  const secondaryActive = !primary.some(link => link.to === location.pathname);
  return <>
    {more && <div className="admin-more-panel mobile-only" id="admin-more">
      <div className="row"><strong>Разделы</strong><button onClick={() => setMore(false)} aria-label="Закрыть разделы">✕</button></div>
      <nav aria-label="Дополнительные разделы">{groups.map(group => <div key={group.label}>
        <div className="admin-nav-label">{group.label}</div>
        {group.links.filter(link => !primary.includes(link)).map(renderLink)}
        {group.label === 'Работа' && draftLink}
      </div>)}</nav>
    </div>}
    <nav className="nav admin-mobile-nav" aria-label="Основные разделы">
      {primary.map(renderLink)}
      <button ref={toggle} className={more || secondaryActive ? 'active' : ''}
        aria-expanded={more} aria-controls="admin-more" onClick={() => setMore(!more)}>
        <span aria-hidden="true">···</span>Ещё
      </button>
    </nav>
  </>;
}
