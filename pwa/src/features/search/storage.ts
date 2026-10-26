// Browser-side search memory (P6.T1/T2). Nothing here is ever sent anywhere or put into a URL:
//   - recent searches (localStorage cp:recent-searches, last 5, per device; each removable, Clear all);
//   - the request behind each search session of this tab (sessionStorage cp:search:<session_id>), so a reload, Back or
//     an expired guest session can run the same search again (DI-17) — the URL carries only the session id and
//     enumerated filters (GD-14).
import type { SearchRequest, TaxonomyType } from '@carpal/api-contracts';

export const RECENT_KEY = 'cp:recent-searches';
export const MAX_RECENT = 5;
const SESSION_PREFIX = 'cp:search:';
const MAX_SESSIONS = 30;

export interface RecentSearch {
  text: string;
  node?: { id: string; type: TaxonomyType; name: string };
  at: number;
}

const listeners = new Set<() => void>();
let cached: { raw: string | null; list: RecentSearch[] } = { raw: null, list: [] };

function readRaw(): string | null {
  try {
    return localStorage.getItem(RECENT_KEY);
  } catch {
    return null;
  }
}

export function readRecent(): RecentSearch[] {
  const raw = readRaw();
  if (raw === cached.raw) return cached.list;
  let list: RecentSearch[] = [];
  try {
    const parsed = JSON.parse(raw ?? '[]') as unknown;
    if (Array.isArray(parsed))
      list = parsed
        .filter((x): x is RecentSearch => !!x && typeof x === 'object' && typeof (x as RecentSearch).text === 'string')
        .slice(0, MAX_RECENT);
  } catch {
    list = [];
  }
  cached = { raw, list };
  return list;
}

function writeRecent(list: RecentSearch[]): void {
  try {
    if (list.length) localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
    else localStorage.removeItem(RECENT_KEY);
  } catch {
    /* storage blocked: nothing is remembered */
  }
  for (const fn of listeners) fn();
}

const sameText = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

export function addRecent(entry: Omit<RecentSearch, 'at'>, now = Date.now()): void {
  const text = entry.text.trim().slice(0, 200);
  if (!text) return;
  writeRecent([{ ...entry, text, at: now }, ...readRecent().filter((r) => !sameText(r.text, text))]);
}

export function removeRecent(text: string): void {
  writeRecent(readRecent().filter((r) => !sameText(r.text, text)));
}

export function clearRecent(): void {
  writeRecent([]);
}

export function subscribeRecent(fn: () => void) {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => e.key === RECENT_KEY && fn();
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('storage', onStorage);
  };
}

// ---------------------------------------------------------------- requests per session

export interface StoredSearch {
  request: SearchRequest;
  at: number;
}

export function storeSearch(sessionId: string, request: SearchRequest, now = Date.now()): void {
  try {
    sessionStorage.setItem(SESSION_PREFIX + sessionId, JSON.stringify({ request, at: now } satisfies StoredSearch));
    // Keep the newest MAX_SESSIONS.
    const keys: { key: string; at: number }[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (!key?.startsWith(SESSION_PREFIX)) continue;
      try {
        keys.push({ key, at: (JSON.parse(sessionStorage.getItem(key) ?? '{}') as StoredSearch).at ?? 0 });
      } catch {
        keys.push({ key, at: 0 });
      }
    }
    keys.sort((a, b) => b.at - a.at);
    for (const k of keys.slice(MAX_SESSIONS)) sessionStorage.removeItem(k.key);
  } catch {
    /* storage blocked: a reload starts a new search from the URL */
  }
}

export function readStoredSearch(sessionId: string): StoredSearch | null {
  try {
    const s = JSON.parse(sessionStorage.getItem(SESSION_PREFIX + sessionId) ?? 'null') as StoredSearch | null;
    return s && typeof s === 'object' && s.request && typeof s.request === 'object' ? s : null;
  } catch {
    return null;
  }
}
