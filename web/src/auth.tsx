import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, getToken, setToken } from './api';

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
  const [user, setUser] = useState<CurrentUser | null>(() => {
    const cached = localStorage.getItem(USER_KEY);
    return cached ? (JSON.parse(cached) as CurrentUser) : null;
  });
  const [loading, setLoading] = useState(true);

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
  }, []);

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
