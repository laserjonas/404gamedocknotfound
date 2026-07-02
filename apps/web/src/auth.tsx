import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { MeResponse, Role, UserDto } from '@gamedock/shared';
import { ROLE_LEVELS } from '@gamedock/shared';
import { api, setCsrfToken } from './api';

interface AuthState {
  user: UserDto | null;
  loading: boolean;
  login(username: string, password: string): Promise<void>;
  logout(): Promise<void>;
  hasRole(role: Role): boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserDto | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api
      .get<MeResponse>('/api/auth/me')
      .then((me) => {
        if (cancelled) return;
        setCsrfToken(me.csrfToken);
        setUser(me.user);
      })
      .catch(() => {
        /* not signed in */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    const onUnauthorized = () => {
      setCsrfToken(null);
      setUser(null);
    };
    window.addEventListener('gamedock:unauthorized', onUnauthorized);
    return () => {
      cancelled = true;
      window.removeEventListener('gamedock:unauthorized', onUnauthorized);
    };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const result = await api.post<{ user: UserDto; csrfToken: string }>('/api/auth/login', {
      username,
      password,
    });
    setCsrfToken(result.csrfToken);
    setUser(result.user);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } finally {
      setCsrfToken(null);
      setUser(null);
    }
  }, []);

  const hasRole = useCallback(
    (role: Role) => (user ? ROLE_LEVELS[user.role] >= ROLE_LEVELS[role] : false),
    [user],
  );

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, hasRole }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
