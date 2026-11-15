import { defaultMessageFor, type ApiErrorBody, type ApiErrorDetails } from '@shared';

const BASE_URL = import.meta.env.VITE_API_URL ?? '/api/v1';

/** Endpoints that must never trigger an automatic refresh-and-retry. */
const NO_REFRESH = ['/auth/login', '/auth/signup', '/auth/refresh', '/auth/logout'];

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: ApiErrorDetails;
  readonly requestId?: string;

  constructor(status: number, code: string, message: string, details?: ApiErrorDetails, requestId?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }

  get fieldErrors(): Record<string, string> {
    return this.details?.fields ?? {};
  }
}

let refreshInFlight: Promise<boolean> | null = null;

/** Single-flight refresh: concurrent 401s share one refresh request. */
function refreshSession(): Promise<boolean> {
  refreshInFlight ??= fetch(`${BASE_URL}/auth/refresh`, { method: 'POST', credentials: 'include' })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

async function request<T>(method: Method, path: string, body?: unknown, allowRefresh = true): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      credentials: 'include',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', "We can't reach SchoolVerse right now. Check your connection and try again.");
  }

  if (res.status === 401 && allowRefresh && !NO_REFRESH.includes(path)) {
    if (await refreshSession()) return request<T>(method, path, body, false);
  }

  if (res.status === 204) return undefined as T;

  const json = (await res.json().catch(() => null)) as ({ data: T } & Partial<ApiErrorBody>) | null;
  if (!res.ok) {
    const err = json?.error;
    const code = err?.code ?? 'INTERNAL_ERROR';
    throw new ApiError(res.status, code, err?.message ?? defaultMessageFor(code), err?.details, err?.requestId);
  }
  return (json as { data: T }).data;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
};
