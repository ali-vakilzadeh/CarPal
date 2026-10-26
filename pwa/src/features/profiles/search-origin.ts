// "Came from a search result" (DI-10): the search page (P6) writes {orgId, sessionId, resultId, at} to sessionStorage
// when a result card opens a profile; a contact action on that profile (Call) then records search.result_event
// 'selected' for that result — the only contact signal the contract has. Nothing is sent without such an origin.
import type { ApiClient } from '@/lib/api';

export const SEARCH_ORIGIN_KEY = 'cp:search-origin';
const MAX_AGE_MS = 30 * 60_000;

export interface SearchOrigin {
  orgId: string;
  sessionId: string;
  resultId: string;
  at: number;
}

export function saveSearchOrigin(o: Omit<SearchOrigin, 'at'>): void {
  try {
    sessionStorage.setItem(SEARCH_ORIGIN_KEY, JSON.stringify({ ...o, at: Date.now() }));
  } catch {
    /* storage blocked: no selection event */
  }
}

export function readSearchOrigin(orgId: string, now = Date.now()): SearchOrigin | null {
  try {
    const o = JSON.parse(sessionStorage.getItem(SEARCH_ORIGIN_KEY) ?? 'null') as SearchOrigin | null;
    return o && o.orgId === orgId && now - o.at < MAX_AGE_MS ? o : null;
  } catch {
    return null;
  }
}

/** Fire-and-forget: records the selection once, then forgets the origin. */
export function reportSearchSelection(api: ApiClient, orgId: string): void {
  const o = readSearchOrigin(orgId);
  if (!o) return;
  try {
    sessionStorage.removeItem(SEARCH_ORIGIN_KEY);
  } catch {
    /* ignore */
  }
  void api
    .api('search.result_event', { path: { session_id: o.sessionId, result_id: o.resultId }, body: { event: 'selected' } })
    .catch(() => undefined);
}
