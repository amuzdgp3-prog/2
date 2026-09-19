import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, getToken, setToken } from './api';
import { clearCachedCatalog } from './db';

export type Role = 'ADMIN' | 'TECHNICIAN' | 'BOSS';

export interface CurrentUser {
  id: number;
  login: string;
  fullName: string;
  role: Role;
}

interface AuthState {
  user: CurrentUser | null;
  loading: boolean;
  login: (login: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

const USER_KEY = 'apixspb.user';

export function AuthProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [user, setUser] = useState<CurrentUser | null>(() => {
    const cached = localStorage.getItem(USER_KEY);
    return cached ? (JSON.parse(cached) as CurrentUser) : null;
  });
  // Сначала кэш, потом сеть: если токен и профиль уже есть на телефоне, приложение открывается сразу,
  // а /auth/me подтверждается в фоне. Ждать ответа сервера на слабой связи незачем — очередь и
  // справочник и так работают из IndexedDB.
  const [loading, setLoading] = useState(() => !(getToken() && localStorage.getItem(USER_KEY)));

  useEffect(() => {
    if (!getToken()) {
      setUser(null);
      setLoading(false);
      return;
    }
    // The cached identity keeps the app usable offline; the server confirms it when reachable.
    api
      .get<CurrentUser>('/api/auth/me')
      .then((confirmed) => {
        setUser(confirmed);
        localStorage.setItem(USER_KEY, JSON.stringify(confirmed));
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (loginName: string, password: string) => {
    const result = await api.post<{ token: string; user: CurrentUser }>('/api/auth/login', {
      login: loginName,
      password,
    });
    setToken(result.token);
    localStorage.setItem(USER_KEY, JSON.stringify(result.user));
    setUser(result.user);
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    localStorage.removeItem(USER_KEY);
    setUser(null);
    // Кэш принадлежит конкретному человеку: аппараты — его зоне ответственности, задачи — лично
    // ему. Без очистки следующий вошедший на этом же телефоне видит чужой список (DECISION-052).
    // Очереди неотправленной работы при этом сохраняются: там единственный экземпляр обслуживаний
    // вместе с фотографиями счётчиков.
    void clearCachedCatalog();
    // The router never resets the URL on its own: without this, whichever page happened to be
    // open at logout (e.g. a specific machine's service form) stays in the address bar and is
    // exactly what greets the next person who logs in on this device/browser, regardless of who
    // they are — a real incident where every re-login in a struggling session kept dropping the
    // technician (and later an admin checking on it) back onto someone else's half-filled form.
    navigate('/', { replace: true });
  }, [navigate]);

  useEffect(() => {
    window.addEventListener('auth:expired', logout);
    return () => window.removeEventListener('auth:expired', logout);
  }, [logout]);

  const value = useMemo(() => ({ user, loading, login, logout }), [user, loading, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
