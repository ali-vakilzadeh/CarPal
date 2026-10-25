'use client';
// The BFF session from the browser (P2.T7): who is signed in (never tokens), sign-in / step-up / sign-out, and the
// pending-intent store of GD-06 (save a gated action before the hosted sign-in, replay it once after).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createCsrfSource, type CsrfSource } from './browser';

export interface SessionView {
  signed_in: boolean;
  user: { id: string; display_name: string; acr: 'aal1' | 'aal2' | 'aal3'; auth_time: number } | null;
  locale: string | null;
  pending_intents: { id: string; type: string; target: string | null; return_to: string }[];
}

export interface PendingIntent<Draft = unknown> {
  id: string;
  type: string;
  target: string | null;
  return_to: string;
  draft: Draft | null;
}

export const SESSION_QUERY_KEY = ['bff', 'session'] as const;

export async function fetchSession(doFetch: typeof fetch = (i, init) => fetch(i, init)): Promise<SessionView> {
  const res = await doFetch('/bff/session', { credentials: 'same-origin', headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`session: ${res.status}`);
  return (await res.json()) as SessionView;
}

export function useSession() {
  return useQuery({ queryKey: SESSION_QUERY_KEY, queryFn: () => fetchSession(), staleTime: 60_000 });
}

/** The current page (path, query, fragment) — the default place to come back to after sign-in. */
export function currentPath(): string {
  return typeof location === 'undefined' ? '/' : `${location.pathname}${location.search}${location.hash}`;
}

/**
 * /bff/login URL; `stepUp` re-authenticates at aal2/aal3 (prompt=login, BA-11). `screen: 'signup'` asks the hosted
 * sign-in to open on account creation (P3 sends the hint; the BFF and the hosted UI act on it from P4).
 */
export function loginUrl(o: { returnTo?: string; stepUp?: 'aal2' | 'aal3'; locale?: string; screen?: 'signup' } = {}): string {
  const p = new URLSearchParams({ return_to: o.returnTo ?? currentPath() });
  if (o.stepUp) p.set('step_up', o.stepUp);
  if (o.locale) p.set('locale', o.locale);
  if (o.screen) p.set('screen', o.screen);
  return `/bff/login?${p.toString()}`;
}

let sharedCsrf: CsrfSource | undefined;
const csrf = () => (sharedCsrf ??= createCsrfSource());

async function post(path: string, body?: unknown, doFetch: typeof fetch = (i, init) => fetch(i, init)): Promise<Response> {
  return doFetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'x-csrf-token': await csrf().get() },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** Saves a gated action in the pre-session (≤ 8 KiB, 30 min); returns its id. */
export async function saveIntent(intent: { type: string; target?: string; returnTo?: string; draft?: unknown }): Promise<string> {
  const res = await post('/bff/intents', {
    type: intent.type,
    target: intent.target,
    return_to: intent.returnTo ?? currentPath(),
    draft: intent.draft,
  });
  if (!res.ok) throw new Error(`intent: ${res.status}`);
  return ((await res.json()) as { intent_id: string }).intent_id;
}

/** Takes a saved intent once (null when it expired or was already replayed). */
export async function consumeIntent<Draft = unknown>(id: string): Promise<PendingIntent<Draft> | null> {
  const res = await post(`/bff/intents/${encodeURIComponent(id)}/consume`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`intent: ${res.status}`);
  return (await res.json()) as PendingIntent<Draft>;
}

/** Signs out (revokes the refresh token in the BFF) and refreshes the session view. */
export function useLogout() {
  const queryClient = useQueryClient();
  return async () => {
    await post('/bff/logout');
    sharedCsrf = undefined;
    await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
  };
}
