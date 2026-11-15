import { QueryCache, QueryClient } from '@tanstack/react-query';
import { ApiError } from './api';

export const SESSION_KEY = ['session'] as const;

export const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => {
      // Any 401 that survived the automatic refresh means the session is really over.
      if (error instanceof ApiError && error.status === 401) queryClient.setQueryData(SESSION_KEY, null);
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
    },
    mutations: { retry: false },
  },
});
