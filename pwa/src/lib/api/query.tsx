'use client';
// TanStack Query over the browser client (GD-09): query keys are [opId, path, query, body]; the client does the
// retrying (SEC-RL-4), so Query's own retry is off. A paged list whose cursor is no longer valid (400
// CURSOR_MISMATCH, e.g. a guest whose pre-session expired) starts again from the first page (GD-09 amendment 4).
import {
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type UseInfiniteQueryOptions,
  type UseMutationOptions,
  type UseQueryOptions,
} from '@tanstack/react-query';
import type { OperationId, OperationResponse } from '@carpal/api-contracts';
import { createContext, useContext, useState, type ReactNode } from 'react';
import { createBrowserApiClient } from './browser';
import type { ApiClient, CallArgs, CallRest } from './client';
import { ApiProblem } from './problem';
import { SESSION_QUERY_KEY } from './session';

const ApiContext = createContext<ApiClient | null>(null);

export function apiQueryKey<Id extends OperationId>(opId: Id, args?: CallArgs<Id>): readonly unknown[] {
  const a = (args ?? {}) as { path?: unknown; query?: unknown; body?: unknown };
  return [opId, a.path ?? {}, a.query ?? {}, a.body ?? null];
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

export function ApiProvider({ children, client }: { children: ReactNode; client?: ApiClient }) {
  const [queryClient] = useState(createQueryClient);
  const [api] = useState(
    () => client ?? createBrowserApiClient({ onSessionEnded: () => void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY }) }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <ApiContext.Provider value={api}>{children}</ApiContext.Provider>
    </QueryClientProvider>
  );
}

export function useApiClient(): ApiClient {
  const api = useContext(ApiContext);
  if (!api) throw new Error('useApiClient outside <ApiProvider>');
  return api;
}

export function useApiQuery<Id extends OperationId>(
  opId: Id,
  args: CallArgs<Id> | undefined,
  options: Omit<UseQueryOptions<OperationResponse<Id>, ApiProblem>, 'queryKey' | 'queryFn'> = {},
) {
  const api = useApiClient();
  return useQuery<OperationResponse<Id>, ApiProblem>({
    queryKey: apiQueryKey(opId, args),
    queryFn: ({ signal }) => api.api(opId, ...([{ ...args, signal }] as unknown as CallRest<Id>)),
    ...options,
  });
}

export function useApiMutation<Id extends OperationId>(
  opId: Id,
  options: Omit<UseMutationOptions<OperationResponse<Id>, ApiProblem, CallArgs<Id>>, 'mutationFn'> = {},
) {
  const api = useApiClient();
  return useMutation<OperationResponse<Id>, ApiProblem, CallArgs<Id>>({
    mutationFn: (args) => api.api(opId, ...([args] as unknown as CallRest<Id>)),
    ...options,
  });
}

/** A cursor-paged list. `cursorIn` says where the operation takes its cursor: the query (GET lists) or the body (search.page). */
export function useApiInfiniteQuery<Id extends OperationId>(
  opId: Id,
  args: CallArgs<Id> | undefined,
  o: {
    cursorIn?: 'query' | 'body';
    nextCursor?: (page: OperationResponse<Id>) => string | null | undefined;
  } & Omit<
    UseInfiniteQueryOptions<OperationResponse<Id>, ApiProblem, InfiniteData<OperationResponse<Id>>, readonly unknown[], string | null>,
    'queryKey' | 'queryFn' | 'initialPageParam' | 'getNextPageParam'
  > = {},
) {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const { cursorIn = 'query', nextCursor = (p) => (p as { next_cursor?: string | null }).next_cursor ?? null, ...options } = o;
  const queryKey = [...apiQueryKey(opId, args), 'pages'];
  return useInfiniteQuery<OperationResponse<Id>, ApiProblem, InfiniteData<OperationResponse<Id>>, readonly unknown[], string | null>({
    queryKey,
    initialPageParam: null,
    getNextPageParam: (last) => nextCursor(last) ?? undefined,
    queryFn: async ({ pageParam, signal }) => {
      const base = (args ?? {}) as { query?: Record<string, unknown>; body?: Record<string, unknown> };
      const withCursor =
        pageParam === null
          ? base
          : cursorIn === 'query'
            ? { ...base, query: { ...base.query, cursor: pageParam } }
            : { ...base, body: { ...base.body, cursor: pageParam } };
      try {
        return await api.api(opId, ...([{ ...withCursor, signal }] as unknown as CallRest<Id>));
      } catch (err) {
        if (pageParam !== null && err instanceof ApiProblem && err.code === 'CURSOR_MISMATCH') {
          // Start the list again instead of showing an error.
          void queryClient.resetQueries({ queryKey, exact: true });
        }
        throw err;
      }
    },
    ...options,
  });
}
