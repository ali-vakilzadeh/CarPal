'use client';
// Search data (P6.T2): search.run / search.refine / search.page through the typed client, with the session's
// response kept in the query cache and its request in sessionStorage (storage.ts) so Back, reload and an expired
// session all work: a session that cannot be read any more (404, 400 CURSOR_MISMATCH — e.g. a guest whose
// pre-session was renewed, DI-17) is replaced by running the stored request again (GD-09 amendment 4).
import type { EntryPoint, ResultCard, SafetyBlock, SearchRequest, SearchResponse } from '@carpal/api-contracts';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useAnalytics } from '@/lib/analytics/client';
import type { ENTRY_POINTS } from '@/lib/analytics/events';
import { ApiProblem } from '@/lib/api/problem';
import { useApiClient } from '@/lib/api/query';
import { refined, type RefineBody } from './request';
import { readStoredSearch, storeSearch } from './storage';

export interface SearchView {
  response: SearchResponse;
  request: SearchRequest;
}

export const sessionKey = (id: string) => ['search-session', id] as const;
const pagesKey = (id: string) => ['search-pages', id] as const;

/** The analytics entry point of a search (CLIENT_EVENTS vocabulary). */
export function analyticsEntry(e: EntryPoint, fromHome = false): (typeof ENTRY_POINTS)[number] {
  if (fromHome) return 'home';
  if (e === 'search_box') return 'search';
  if (e === 'map') return 'map';
  if (e === 'help_me') return 'help_me';
  if (e === 'profile') return 'profile';
  return 'other';
}

/** True for API answers that mean "this session cannot be used any more": run the stored request again. */
export function sessionGone(err: unknown): boolean {
  return err instanceof ApiProblem && (err.status === 404 || err.code === 'CURSOR_MISMATCH');
}

/** Guests' requests without the signed-in-only parts (after a 401: the session ended while searching). */
export function asGuest(req: SearchRequest, fallbackCity: string): SearchRequest {
  const next: SearchRequest = { ...req };
  delete next.vehicle_id;
  if (!next.filters?.brand_node_id) delete next.vehicle_filter_applied;
  if (next.location.mode === 'user_position') next.location = { mode: 'chosen_city', city_key: fallbackCity };
  return next;
}

export function useSearchActions() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const { track } = useAnalytics();

  const remember = useCallback(
    (response: SearchResponse, request: SearchRequest) => {
      storeSearch(response.session_id, request);
      queryClient.setQueryData<SearchView>(sessionKey(response.session_id), { response, request });
    },
    [queryClient],
  );

  const run = useCallback(
    async (request: SearchRequest, o: { started?: boolean; fromHome?: boolean } = {}) => {
      const response = await api.api('search.run', { body: request });
      remember(response, request);
      if (o.started) track('search.started', { entry_point: analyticsEntry(request.entry_point, o.fromHome), help_me_used: false });
      return response;
    },
    [api, remember, track],
  );

  const refine = useCallback(
    async (sessionId: string, prev: SearchRequest, body: RefineBody) => {
      const request = refined(prev, body);
      try {
        const response = await api.api('search.refine', { path: { session_id: sessionId }, body });
        remember(response, request);
        return response;
      } catch (err) {
        if (sessionGone(err)) return run(request);
        throw err;
      }
    },
    [api, remember, run],
  );

  return { run, refine };
}

/**
 * The search of a page URL: from the cache, else by running the request stored for that session (or, for a shared
 * link without one, the request the caller builds from the URL). The result may carry a new session id — the page
 * then replaces its URL.
 */
export function useSearchView(
  sessionId: string | null,
  recover: (stored: SearchRequest | null) => SearchRequest | null,
  o: { ready: boolean; fallbackCity: string },
) {
  const { run } = useSearchActions();
  return useQuery<SearchView, ApiProblem>({
    queryKey: sessionKey(sessionId ?? ''),
    enabled: !!sessionId && o.ready,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: false,
    queryFn: async () => {
      const request = recover(readStoredSearch(sessionId!)?.request ?? null);
      if (!request) throw new ApiProblem(404, { code: 'NOT_FOUND', title: 'search session not found' });
      try {
        return { response: await run(request), request };
      } catch (err) {
        // Signed out meanwhile: the same search as a guest (no vehicle_id, no user_position; BA-16).
        if (!(err instanceof ApiProblem) || err.status !== 401) throw err;
        const guest = asGuest(request, o.fallbackCity);
        return { response: await run(guest), request: guest };
      }
    },
  });
}

/** Every loaded result of a session: the first page from the response, then search.page (20 per page, cursor only). */
export function useSearchPages(view: SearchView | undefined, onGone: () => void) {
  const api = useApiClient();
  const id = view?.response.session_id ?? '';
  const q = useInfiniteQuery<{ items: ResultCard[]; next_cursor: string | null }, ApiProblem>({
    queryKey: pagesKey(id),
    enabled: !!view,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: false,
    initialPageParam: null,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    queryFn: async ({ pageParam }) => {
      if (pageParam === null) return { items: view!.response.results, next_cursor: view!.response.next_cursor };
      try {
        return await api.api('search.page', { path: { session_id: id }, query: { cursor: pageParam as string } });
      } catch (err) {
        if (sessionGone(err)) onGone();
        throw err;
      }
    },
  });
  const results = q.data?.pages.flatMap((p) => p.items) ?? [];
  return { results, hasMore: q.hasNextPage, loadMore: () => void q.fetchNextPage(), loadingMore: q.isFetchingNextPage, error: q.error };
}

/** The safety banner when search.run failed: the shared keyword check on the text (safety.check). */
export function useSafetyFallback(text: string, failed: boolean, locale: string) {
  const enabled = failed && text.trim().length > 0;
  const api = useApiClient();
  return useQuery<SafetyBlock, ApiProblem>({
    queryKey: ['safety.check', text, locale],
    enabled,
    staleTime: Infinity,
    retry: false,
    queryFn: () => api.api('safety.check', { body: { text: text.slice(0, 3000), locale: locale as 'fa' | 'en' } }),
  });
}

/** search.result_event: 'viewed' when a result is opened, 'selected' for Request / Call (DI-10). Fire and forget. */
export function useResultEvent() {
  const api = useApiClient();
  return useCallback(
    (sessionId: string, resultId: string, event: 'viewed' | 'selected') =>
      void api.api('search.result_event', { path: { session_id: sessionId, result_id: resultId }, body: { event } }).catch(() => undefined),
    [api],
  );
}
