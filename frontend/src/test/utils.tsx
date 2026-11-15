import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { vi } from 'vitest';
import type { Role } from '@shared';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AuthProvider } from '@/lib/auth';
import { sessionFor } from './fixtures';

export interface MockResponse {
  status?: number;
  data?: unknown;
  error?: { code: string; message: string; details?: unknown };
}
export type Handler = (request: { url: URL; method: string; body: unknown }) => MockResponse | undefined;

export interface FetchMock {
  calls: { method: string; path: string; body: unknown }[];
  /** All calls whose path contains `fragment`. */
  callsTo: (fragment: string, method?: string) => { method: string; path: string; body: unknown }[];
}

/** Replaces `fetch` with a router of handlers. Unmatched requests fail the test loudly. */
export function mockApi(role: Role | null, handlers: Record<string, MockResponse | Handler>): FetchMock {
  const calls: FetchMock['calls'] = [];
  const all: Record<string, MockResponse | Handler> = {
    'GET /api/v1/auth/me': role ? { data: sessionFor(role) } : { status: 401, error: { code: 'UNAUTHENTICATED', message: 'Please sign in to continue.' } },
    ...handlers,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost');
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
      calls.push({ method, path: url.pathname + url.search, body });
      const key = `${method} ${url.pathname}`;
      const entry = all[key];
      if (!entry) throw new Error(`Unmocked request: ${key}${url.search}`);
      const res = typeof entry === 'function' ? entry({ url, method, body }) : entry;
      if (!res) throw new Error(`Handler returned nothing for ${key}`);
      const status = res.status ?? 200;
      if (status === 204) return new Response(null, { status });
      return new Response(JSON.stringify(res.error ? { error: res.error } : { data: res.data }), { status, headers: { 'Content-Type': 'application/json' } });
    }),
  );
  return { calls, callsTo: (fragment, method) => calls.filter((c) => c.path.includes(fragment) && (!method || c.method === method)) };
}

export function renderWithApp(ui: ReactElement, { route = '/' }: { route?: string } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <TooltipProvider>
          <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
}
