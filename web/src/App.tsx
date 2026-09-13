import { Suspense, lazy, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import { readOutbox } from './db';
import { syncOutbox } from './sync';
import DashboardScreen from './screens/Dashboard';
import ForgottenScreen from './screens/Forgotten';
import HistoryScreen from './screens/History';
import LoginScreen from './screens/Login';
import MachinesScreen from './screens/Machines';
import OwnerReportScreen from './screens/OwnerReport';
import QueueScreen from './screens/Queue';
import ReportsScreen from './screens/Reports';
import ServiceFormScreen from './screens/ServiceForm';
import ServiceLogScreen from './screens/ServiceLog';
import TasksScreen from './screens/Tasks';

/**
 * Админка грузится отдельным чанком и только когда администратор реально открывает /admin.
 * Маршрут и так закрыт проверкой isAdmin, но проверка эта — в рантайме, а не на границе сборки:
 * при обычном импорте весь код админки (10 вкладок, формы сотрудников, терминалов, iVend)
 * попадал в общий бандл и уезжал на телефон каждому технику в поле, который его никогда не
 * увидит. Динамический import() — единственная граница, по которой Vite режет чанки; разбиение
 * Admin.tsx на файлы само по себе на размер бандла не влияло.
 */
const AdminScreen = lazy(() => import('./screens/admin'));

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'администратор',
  TECHNICIAN: 'техник',
  BOSS: 'руководитель',
};

export default function App() {
  const { user, loading, logout } = useAuth();
  const [online, setOnline] = useState(navigator.onLine);
  const [queued, setQueued] = useState(0);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(
    () =>
      window.matchMedia('(display-mode: standalone)').matches ||
      // iOS Safari has no display-mode media query for the installed PWA; it exposes this
      // non-standard flag on navigator instead.
      (navigator as { standalone?: boolean }).standalone === true,
  );
  // iOS Safari never fires beforeinstallprompt — there is no such API on iOS at all — so a
  // technician on an iPhone saw no install affordance whatsoever. Detect the platform instead
  // and show the manual Share-sheet steps, since that is the only way to install there.
  const [isIosSafari] = useState(() => {
    const ua = navigator.userAgent;
    const isIosDevice = /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
    const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
    return isIosDevice && isSafari;
  });
  // Yandex Browser (and some other Chromium forks — Samsung Internet, in-app webviews) never
  // fire beforeinstallprompt either, despite being Chromium-based and often still able to install
  // via their own menu — a technician on Yandex Browser saw neither the native button nor any
  // hint at all. Rather than chase every such browser by name, wait for the moment Chrome itself
  // would already have fired the event (a few seconds) and fall back to a generic "check your
  // browser menu" hint for anything left over that isn't iOS Safari and isn't already installed.
  const [installPromptGraceElapsed, setInstallPromptGraceElapsed] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setInstallPromptGraceElapsed(true), 2500);
    return () => window.clearTimeout(timer);
  }, []);
  const location = useLocation();
  // The service form has its own bottom action bar (Отмена/Сохранить); showing the global
  // tab bar at the same time made the two fixed bars overlap on top of each other.
  const hideBottomNav = location.pathname.startsWith('/service/');
  const isHomeScreen = location.pathname === '/';

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    // Reachability reported by actual API calls beats navigator.onLine, which stays true on a
    // network that has no route to the server.
    window.addEventListener('api:reachable', goOnline);
    window.addEventListener('api:unreachable', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('api:reachable', goOnline);
      window.removeEventListener('api:unreachable', goOffline);
    };
  }, []);

  // The browser offers installation only once and only when it decides the app qualifies;
  // capturing the event lets the technician install from a visible button instead of a menu.
  useEffect(() => {
    const capture = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    const markInstalled = () => {
      setInstalled(true);
      setInstallPrompt(null);
    };
    window.addEventListener('beforeinstallprompt', capture);
    window.addEventListener('appinstalled', markInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', capture);
      window.removeEventListener('appinstalled', markInstalled);
    };
  }, []);

  const refreshQueueCount = async () => {
    const items = await readOutbox();
    setQueued(items.filter((item) => item.status === 'PENDING').length);
  };

  useEffect(() => {
    void refreshQueueCount();
  }, [location.pathname]);

  // Coming back online is the moment to flush whatever the technician recorded offline.
  useEffect(() => {
    if (!online || !user) return;
    void syncOutbox().then(refreshQueueCount);
  }, [online, user]);

  if (loading) return <div className="app"><p className="muted">Загрузка…</p></div>;
  if (!user) return <LoginScreen />;

  const isAdmin = user.role === 'ADMIN';
  const canSeeReports = user.role !== 'TECHNICIAN';

  const install = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  };

  const isTechnician = user.role === 'TECHNICIAN';

  const links = (
    <>
      <NavLink to="/" end><span>▦</span>Аппараты</NavLink>
      <NavLink to="/tasks"><span>☑</span>Задачи</NavLink>
      <NavLink to="/queue"><span>✎</span>Черновики{queued > 0 ? ` (${queued})` : ''}</NavLink>
      {isTechnician && <NavLink to="/forgotten"><span>⏰</span>Забытые</NavLink>}
      {canSeeReports && <NavLink to="/dashboard"><span>◧</span>Сводка</NavLink>}
      {canSeeReports && <NavLink to="/owner-report"><span>▤</span>Отчёт владельцу</NavLink>}
      {canSeeReports && <NavLink to="/log"><span>☰</span>Журнал</NavLink>}
      {canSeeReports && <NavLink to="/reports"><span>₽</span>Отчёты</NavLink>}
      {isAdmin && <NavLink to="/admin"><span>⚙</span>Админ</NavLink>}
    </>
  );

  const installButton = !installed && installPrompt && (
    <button onClick={install} style={{ width: '100%', marginBottom: 8 }}>
      ⬇️ Установить приложение
    </button>
  );

  const iosInstallHint = !installed && isIosSafari && !installPrompt && (
    <div className="muted" style={{ fontSize: 12, padding: '0 10px 8px', lineHeight: 1.4 }}>
      Установить на iPhone: <strong>⎋ Поделиться</strong> внизу экрана → <strong>«На экран «Домой»»</strong>.
    </div>
  );

  const showGenericInstallHint = !installed && !isIosSafari && !installPrompt && installPromptGraceElapsed;
  const genericInstallHint = showGenericInstallHint && (
    <div className="muted" style={{ fontSize: 12, padding: '0 10px 8px', lineHeight: 1.4 }}>
      Установить: меню браузера (обычно ⋮) → <strong>«Установить приложение»</strong> или
      <strong> «Добавить на главный экран»</strong>. Нет такого пункта — можно продолжать
      пользоваться прямо в браузере, всё работает так же.
    </div>
  );

  return (
    <>
      <aside className="sidebar">
        <div className="brand">Apixspb</div>
        {links}
        <div className="spacer" />
        {installButton}
        {iosInstallHint}
        {genericInstallHint}
        <div className="user">
          <div style={{ padding: '0 10px 8px' }}>
            <div>{user.fullName}</div>
            <div className="muted">{ROLE_LABELS[user.role] ?? user.role}</div>
          </div>
          <button
            onClick={logout}
            disabled={!online}
            title={online ? undefined : 'Нет связи: выход невозможен, войти обратно можно только при интернете'}
            style={{ width: '100%' }}
          >
            Выйти
          </button>
        </div>
      </aside>

      <div className="app">
        <div className="topbar">
          <h1>Apixspb</h1>
          <div className="row" style={{ gap: 6 }}>
            {queued > 0 && <span className="badge queue">В очереди: {queued}</span>}
            <span className={`badge ${online ? 'online' : 'offline'}`}>
              {online ? 'Онлайн' : 'Оффлайн'}
            </span>
            <button
              className="mobile-only"
              onClick={logout}
              disabled={!online}
              title={online ? undefined : 'Нет связи: выход невозможен, войти обратно можно только при интернете'}
              style={{ padding: '6px 10px' }}
            >
              Выйти
            </button>
          </div>
        </div>

        {/* Показываем предложение установить приложение только на главном экране — оно занимало
            место над контентом на КАЖДОМ экране, включая карточку обслуживания, где заслоняло
            собой блок «Прошлое обслуживание», который технику нужно видеть сразу. */}
        {isHomeScreen && !installed && installPrompt && (
          <div className="card row mobile-only">
            <div>
              <strong>Установить приложение</strong>
              <div className="muted">Работает без интернета, запускается с рабочего стола</div>
            </div>
            <button className="primary" style={{ width: 'auto' }} onClick={install}>
              Установить
            </button>
          </div>
        )}

        {isHomeScreen && !installed && isIosSafari && !installPrompt && (
          <div className="card card-pad mobile-only">
            <strong>Установить на iPhone</strong>
            <p className="muted" style={{ marginBottom: 0 }}>
              Нажмите <strong>⎋ Поделиться</strong> внизу экрана Safari, затем выберите
              <strong> «На экран «Домой»»</strong>. Приложение будет работать без интернета и
              запускаться отдельной иконкой.
            </p>
          </div>
        )}

        {isHomeScreen && showGenericInstallHint && (
          <div className="card card-pad mobile-only">
            <strong>Установить приложение</strong>
            <p className="muted" style={{ marginBottom: 0 }}>
              Откройте меню браузера (обычно значок <strong>⋮</strong> в углу экрана) и найдите
              пункт <strong>«Установить приложение»</strong> или <strong>«Добавить на главный
              экран»</strong>. Если такого пункта нет — браузер это не поддерживает, можно
              продолжать работать прямо здесь, во вкладке, всё работает точно так же.
            </p>
          </div>
        )}

        <Routes>
          <Route path="/" element={<MachinesScreen />} />
          <Route
            path="/service/:machineNumber/:localId?"
            element={<ServiceFormScreen onQueued={refreshQueueCount} />}
          />
          <Route path="/history/:machineNumber" element={<HistoryScreen />} />
          <Route path="/tasks" element={<TasksScreen />} />
          <Route path="/queue" element={<QueueScreen onChange={refreshQueueCount} />} />
          <Route path="/forgotten" element={isTechnician ? <ForgottenScreen /> : <Navigate to="/" />} />
          <Route path="/dashboard" element={canSeeReports ? <DashboardScreen /> : <Navigate to="/" />} />
          <Route path="/owner-report" element={canSeeReports ? <OwnerReportScreen /> : <Navigate to="/" />} />
          <Route path="/log" element={canSeeReports ? <ServiceLogScreen /> : <Navigate to="/" />} />
          <Route path="/reports" element={canSeeReports ? <ReportsScreen /> : <Navigate to="/" />} />
          <Route
            path="/admin"
            element={
              isAdmin ? (
                <Suspense fallback={<div className="muted">Загрузка…</div>}>
                  <AdminScreen />
                </Suspense>
              ) : (
                <Navigate to="/" />
              )
            }
          />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </div>

      {!hideBottomNav && <nav className="nav">{links}</nav>}
    </>
  );
}
