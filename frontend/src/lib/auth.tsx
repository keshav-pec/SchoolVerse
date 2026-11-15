import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LoginInput, Permission, SessionDTO, SignupInput } from '@shared';
import { api, ApiError } from './api';
import { SESSION_KEY } from './query-client';

interface AuthContextValue {
  session: SessionDTO | null;
  isLoading: boolean;
  can: (permission: Permission) => boolean;
  login: (input: LoginInput) => Promise<SessionDTO>;
  signup: (input: SignupInput) => Promise<SessionDTO>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function fetchSession(): Promise<SessionDTO | null> {
  try {
    return await api.get<SessionDTO>('/auth/me');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const sessionQuery = useQuery({ queryKey: SESSION_KEY, queryFn: fetchSession, staleTime: 5 * 60_000, retry: false });

  const loginMutation = useMutation({
    mutationFn: (input: LoginInput) => api.post<SessionDTO>('/auth/login', input),
    onSuccess: (session) => queryClient.setQueryData(SESSION_KEY, session),
  });
  const signupMutation = useMutation({
    mutationFn: (input: SignupInput) => api.post<SessionDTO>('/auth/signup', input),
    onSuccess: (session) => queryClient.setQueryData(SESSION_KEY, session),
  });

  const value = useMemo<AuthContextValue>(() => {
    const session = sessionQuery.data ?? null;
    return {
      session,
      isLoading: sessionQuery.isLoading,
      can: (permission) => !!session?.permissions.includes(permission),
      login: loginMutation.mutateAsync,
      signup: signupMutation.mutateAsync,
      logout: async () => {
        await api.post('/auth/logout').catch(() => undefined);
        queryClient.clear();
        queryClient.setQueryData(SESSION_KEY, null);
      },
    };
  }, [sessionQuery.data, sessionQuery.isLoading, loginMutation.mutateAsync, signupMutation.mutateAsync, queryClient]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** Use inside authenticated routes where a session is guaranteed. */
export function useSession(): SessionDTO {
  const { session } = useAuth();
  if (!session) throw new Error('useSession called without an active session');
  return session;
}
