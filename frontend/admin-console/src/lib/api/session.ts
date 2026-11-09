// The BFF session from the browser (AC3.T2/T3/T5), adapted from pwa/src/lib/api/session.ts: who is signed in (never
// tokens), the staff roles, when the session ends (30-minute idle, 8-hour absolute), sign-in and step-up URLs, sign-out,
// and the pending-action store of GD-11 (save an action before /bff/reauth, replay it once after). No 'use client'
// here: the URL builders are shared with server pages.
import type { StaffRole } from '@/lib/api/generated';
import { resetSharedCsrfSource, sharedCsrfSource } from './browser';

export interface SessionView {
  signed_in: boolean;
  staff: {
    id: string;
    display_name: string;
    roles: StaffRole[];
    locale: string;
    timezone: string;
    acr: 'aal1' | 'aal2' | 'aal3';
    auth_time: string;
  } | null;
  locale: string | null;
  idle_expires_at: string | null;
  expires_at: string | null;
  pending_intents: { id: string; type: string; target: string | null; return_to: string }[];
  /** The server's clock when the view was made (deadlines are measured against it, AC4.T4). */
  server_time: string;
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
  const res = await doFetch('/bff/session', { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`session: ${res.status}`);
  return (await res.json()) as SessionView;
}

/** A same-origin path that is not a BFF, API or sign-in endpoint; anything else is null. */
export function safeNextPath(value: string | null | undefined): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
  if ([...value].some((c) => c < ' ' || c === '\x7f')) return null;
  if (/^\/(bff|api|id)(\/|$)/.test(value)) return null;
  return value;
}

/** The current page (path, query, fragment): the default place to come back to. */
export function currentPath(): string {
  return typeof location === 'undefined' ? '/' : `${location.pathname}${location.search}${location.hash}`;
}

/** /bff/login back to `returnTo` (default: this page); always aal3 (SEC-ADM-2). */
export function loginUrl(returnTo: string = currentPath()): string {
  return `/bff/login?${new URLSearchParams({ return_to: safeNextPath(returnTo) ?? '/' }).toString()}`;
}

/** /bff/reauth: confirm with the passkey again (STEP_UP_REQUIRED, GD-11), then back to `returnTo`; `intent` replays once. */
export function reauthUrl(o: { returnTo?: string; intent?: string } = {}): string {
  const p = new URLSearchParams({ return_to: safeNextPath(o.returnTo ?? currentPath()) ?? '/' });
  if (o.intent) p.set('intent', o.intent);
  return `/bff/reauth?${p.toString()}`;
}

async function post(path: string, body?: unknown, doFetch: typeof fetch = (i, init) => fetch(i, init)): Promise<Response> {
  return doFetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'x-csrf-token': await sharedCsrfSource().get() },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** Saves an action that needs a step-up (≤ 8 KiB, 30 min, server-side only); returns its id for reauthUrl. */
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

/** Takes a saved action once (null when it expired or was already replayed). */
export async function consumeIntent<Draft = unknown>(id: string): Promise<PendingIntent<Draft> | null> {
  const res = await post(`/bff/intents/${encodeURIComponent(id)}/consume`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`intent: ${res.status}`);
  return (await res.json()) as PendingIntent<Draft>;
}

/** Signs out in the BFF (revokes the refresh token, drops the session). The caller clears its query cache. */
export async function logout(): Promise<void> {
  await post('/bff/logout').catch(() => undefined);
  resetSharedCsrfSource();
}
