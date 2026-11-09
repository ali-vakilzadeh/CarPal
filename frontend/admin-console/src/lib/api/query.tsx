'use client';
// TanStack Query over the admin client (AC3.T5), adapted from pwa/src/lib/api/query.tsx. GD-12: the cache lives in
// memory only (no persister, no offline mode) and is cleared on sign-out, when the BFF reports the session ended
// (idle limit, 8-hour end, revoked) and when another staff member signs in in the same tab. Query keys are
// [opId, path, query, body, purpose]; the client does the retrying (SEC-RL-4), so Query's own retry is off.
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationOptions,
  type UseQueryOptions,
} from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AdminOperationId, AdminResponse } from '@/lib/api/generated';
import { createBrowserApiClient } from './browser';
import type { ApiClient, CallArgs, CallRest, Outcome } from './client';
import type { ApiProblem } from './problem';
import { fetchSession, logout, SESSION_QUERY_KEY, type SessionView } from './session';

const ApiContext = createContext<ApiClient | null>(null);

/** Dispatched on window when the BFF answered 401 SESSION_ENDED / UNAUTHENTICATED (the shell shows a notice, AC4). */
export const SESSION_ENDED_EVENT = 'carpal-admin:session-ended';

export function apiQueryKey<Id extends AdminOperationId>(opId: Id, args?: CallArgs<Id>): readonly unknown[] {
  const a = (args ?? {}) as { path?: unknown; query?: unknown; body?: unknown; purpose?: unknown };
  return [opId, a.path ?? {}, a.query ?? {}, a.body ?? null, a.purpose ?? null];
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 15_000, gcTime: 5 * 60_000, refetchOnWindowFocus: false, networkMode: 'online' },
      mutations: { retry: false },
    },
  });
}

/** Drops every cached response and ETag (GD-12), but keeps nothing about who was signed in. */
export function clearPrivateCache(queryClient: QueryClient, api: ApiClient): void {
  queryClient.clear();
  api.etags.clear();
}

export function ApiProvider({
  children,
  client,
  queryClient: given,
  initialSession,
}: {
  children: ReactNode;
  client?: ApiClient;
  queryClient?: QueryClient;
  /** The server's view of the session for this page (AC4): the shell renders without waiting for /bff/session. */
  initialSession?: SessionView;
}) {
  const [queryClient] = useState(() => {
    const qc = given ?? createQueryClient();
    if (initialSession && qc.getQueryData(SESSION_QUERY_KEY) === undefined) qc.setQueryData(SESSION_QUERY_KEY, initialSession);
    return qc;
  });
  const [api] = useState(() => {
    if (client) return client;
    const browser: ApiClient = createBrowserApiClient({
      onSessionEnded: () => {
        clearPrivateCache(queryClient, browser);
        window.dispatchEvent(new Event(SESSION_ENDED_EVENT));
      },
    });
    return browser;
  });
  return (
    <QueryClientProvider client={queryClient}>
      <ApiContext.Provider value={api}>
        <StaffSwitchGuard />
        {children}
      </ApiContext.Provider>
    </QueryClientProvider>
  );
}

/** Clears the cache when the signed-in staff member changes (another sign-in in the same tab) or signs out. */
function StaffSwitchGuard() {
  const session = useSession();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const last = useRef<string | null | undefined>(undefined);
  const id = session.data ? (session.data.staff?.id ?? null) : undefined;
  useEffect(() => {
    if (id === undefined) return;
    if (last.current !== undefined && last.current !== id) {
      const view = queryClient.getQueryData<SessionView>(SESSION_QUERY_KEY);
      clearPrivateCache(queryClient, api);
      if (view) queryClient.setQueryData(SESSION_QUERY_KEY, view);
    }
    last.current = id;
  }, [id, api, queryClient]);
  return null;
}

export function useApiClient(): ApiClient {
  const api = useContext(ApiContext);
  if (!api) throw new Error('useApiClient outside <ApiProvider>');
  return api;
}

/** The BFF session view; re-read every minute so the shell can warn before the idle limit (AC4). */
export function useSession() {
  return useQuery<SessionView>({ queryKey: SESSION_QUERY_KEY, queryFn: () => fetchSession(), staleTime: 30_000, refetchInterval: 60_000 });
}

/** Signs out and clears every cached response before anything else renders (GD-12). */
export function useLogout() {
  const queryClient = useQueryClient();
  const api = useApiClient();
  return useCallback(async () => {
    await logout();
    clearPrivateCache(queryClient, api);
    await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
  }, [queryClient, api]);
}

export function useApiQuery<Id extends AdminOperationId>(
  opId: Id,
  args: CallArgs<Id> | undefined,
  options: Omit<UseQueryOptions<AdminResponse<Id>, ApiProblem>, 'queryKey' | 'queryFn'> = {},
) {
  const api = useApiClient();
  return useQuery<AdminResponse<Id>, ApiProblem>({
    queryKey: apiQueryKey(opId, args),
    queryFn: ({ signal }) => api.api(opId, ...([{ ...args, signal }] as unknown as CallRest<Id>)),
    ...options,
  });
}

/** A write: resolves to applied, pending (four-eyes, GD-11) or accepted (background job). */
export function useApiMutation<Id extends AdminOperationId>(
  opId: Id,
  options: Omit<UseMutationOptions<Outcome<AdminResponse<Id>>, ApiProblem, CallArgs<Id>>, 'mutationFn'> = {},
) {
  const api = useApiClient();
  return useMutation<Outcome<AdminResponse<Id>>, ApiProblem, CallArgs<Id>>({
    mutationFn: (args) => api.act(opId, ...([args] as unknown as CallRest<Id>)),
    ...options,
  });
}
