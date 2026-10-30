'use client';
// Help Me cases in this browser (P10.T1): every step URL (/<locale>/help/<case>/<step>) reads its case from here, so
// refresh, Back and "Save and exit" work; the server keeps the triage session, the match session and the appointment,
// this store only the links between them and the user's choices. Per user (localStorage cp:help:cases:<user id>, at
// most 10 cases, 14 days), never sent anywhere; a browser position is never stored (only a chosen city).
import { useCallback, useSyncExternalStore } from 'react';
import { useSession } from '@/lib/api/session';
import { isSymptomKey, type HelpCase } from './model';

export const MAX_CASES = 10;
export const CASE_TTL_MS = 14 * 86_400_000;

const key = (userId: string) => `cp:help:cases:${userId}`;
const listeners = new Set<() => void>();
const cache = new Map<string, { raw: string | null; cases: HelpCase[] }>();
/** The one empty list (useSyncExternalStore needs a stable snapshot). */
const NONE: HelpCase[] = [];

function valid(c: unknown): c is HelpCase {
  const x = c as HelpCase;
  return (
    !!x &&
    typeof x.id === 'string' &&
    typeof x.updatedAt === 'number' &&
    (x.kind === 'help' || x.kind === 'direct') &&
    typeof x.text === 'string' &&
    Array.isArray(x.symptoms) &&
    x.symptoms.every(isSymptomKey) &&
    Array.isArray(x.mediaIds)
  );
}

/** The user's cases, newest first (expired ones dropped). Safe on the server (empty). */
export function readCases(userId: string | null, now = Date.now()): HelpCase[] {
  if (!userId || typeof localStorage === 'undefined') return NONE;
  let raw: string | null;
  try {
    raw = localStorage.getItem(key(userId));
  } catch {
    return NONE;
  }
  const hit = cache.get(userId);
  if (hit && hit.raw === raw) return hit.cases;
  let cases: HelpCase[];
  try {
    const v: unknown = raw ? JSON.parse(raw) : [];
    cases = Array.isArray(v) ? v.filter(valid).filter((c) => now - c.updatedAt < CASE_TTL_MS) : [];
  } catch {
    cases = [];
  }
  cases.sort((a, b) => b.updatedAt - a.updatedAt);
  cache.set(userId, { raw, cases });
  return cases;
}

function writeCases(userId: string, cases: HelpCase[]): void {
  try {
    localStorage.setItem(key(userId), JSON.stringify(cases.slice(0, MAX_CASES)));
  } catch {
    /* storage blocked or full: the case lasts until the page reloads */
  }
  for (const fn of listeners) fn();
}

export function readCase(userId: string | null, caseId: string): HelpCase | null {
  return readCases(userId).find((c) => c.id === caseId) ?? null;
}

/** Inserts or replaces a case (newest first, at most 10). */
export function saveCase(userId: string, c: HelpCase, now = Date.now()): HelpCase {
  const next = { ...c, updatedAt: now };
  writeCases(userId, [next, ...readCases(userId, now).filter((x) => x.id !== c.id)]);
  return next;
}

export function removeCase(userId: string, caseId: string): void {
  writeCases(
    userId,
    readCases(userId).filter((c) => c.id !== caseId),
  );
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => e.key?.startsWith('cp:help:cases:') && fn();
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('storage', onStorage);
  };
}

/** The signed-in user's cases and a writer; `ready` is false until the session is known. */
export function useHelpCases() {
  const session = useSession();
  const userId = session.data?.user?.id ?? null;
  const cases = useSyncExternalStore(
    subscribe,
    () => readCases(userId),
    () => NONE,
  );
  const update = useCallback(
    (c: HelpCase) => {
      if (userId) saveCase(userId, c);
    },
    [userId],
  );
  const remove = useCallback(
    (caseId: string) => {
      if (userId) removeCase(userId, caseId);
    },
    [userId],
  );
  return { userId, ready: session.data !== undefined, cases, update, remove };
}

/** One case of the signed-in user (null when it is not in this browser). */
export function useHelpCase(caseId: string) {
  const { cases, update, ready, userId } = useHelpCases();
  const c = cases.find((x) => x.id === caseId) ?? null;
  const patch = useCallback(
    (change: Partial<HelpCase>) => {
      if (!userId) return null;
      const cur = readCase(userId, caseId);
      if (!cur) return null;
      return saveCase(userId, { ...cur, ...change });
    },
    [userId, caseId],
  );
  return { c, ready, update, patch, userId };
}
