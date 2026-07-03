import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type {
  AuthSuccessDto,
  LoginResponseDto,
  MeResponse,
  PasskeyAuthenticationOptionsDto,
  Role,
  UserDto,
} from '@gamedock/shared';
import { ROLE_LEVELS } from '@gamedock/shared';
import { startAuthentication } from '@simplewebauthn/browser';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { api, setCsrfToken } from './api';

export type LoginStepResult =
  { requiresTotp: true; challengeToken: string } | { requiresTotp: false };

interface AuthState {
  user: UserDto | null;
  loading: boolean;
  login(username: string, password: string): Promise<LoginStepResult>;
  completeTotpLogin(challengeToken: string, code: string): Promise<void>;
  loginWithPasskey(): Promise<void>;
  logout(): Promise<void>;
  hasRole(role: Role): boolean;
  refreshUser(): Promise<void>;
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

  const login = useCallback(
    async (username: string, password: string): Promise<LoginStepResult> => {
      const result = await api.post<LoginResponseDto>('/api/auth/login', { username, password });
      if (result.status === 'totp_required') {
        return { requiresTotp: true, challengeToken: result.challengeToken };
      }
      setCsrfToken(result.csrfToken);
      setUser(result.user);
      return { requiresTotp: false };
    },
    [],
  );

  const completeTotpLogin = useCallback(async (challengeToken: string, code: string) => {
    const result = await api.post<LoginResponseDto>('/api/auth/login/totp', {
      challengeToken,
      code,
    });
    if (result.status === 'totp_required') {
      // Shouldn't happen (this endpoint always completes or throws), but stay safe.
      throw new Error('Verification did not complete');
    }
    setCsrfToken(result.csrfToken);
    setUser(result.user);
  }, []);

  const loginWithPasskey = useCallback(async () => {
    const options = await api.post<PasskeyAuthenticationOptionsDto>(
      '/api/auth/passkeys/login/begin',
    );
    const response = await startAuthentication({
      optionsJSON: options as unknown as PublicKeyCredentialRequestOptionsJSON,
    });
    const result = await api.post<AuthSuccessDto>('/api/auth/passkeys/login/complete', {
      response,
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

  const refreshUser = useCallback(async () => {
    const me = await api.get<MeResponse>('/api/auth/me');
    setCsrfToken(me.csrfToken);
    setUser(me.user);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        login,
        completeTotpLogin,
        loginWithPasskey,
        logout,
        hasRole,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
