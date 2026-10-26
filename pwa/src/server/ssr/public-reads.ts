// Public reads for the SEO pages (P5): the cp-ssr client (ssr/api.ts) behind a small in-memory cache. The backend
// marks public profile reads cacheable for 60 s for anonymous callers (Docs/40 §14.3); server rendering shares one
// cp-ssr rate-limit bucket (DI-26), so every read is kept for READ_TTL_MS per (operation, arguments, language, time
// zone) and the in-flight promise is shared, which also dedupes generateMetadata, the page and its @rail slot within
// one request. 404 and 410 are results, not errors: pages turn them into notFound() or the removed state (OQ-14).
import 'server-only';
import type { OperationId, OperationResponse } from '@carpal/api-contracts';
import { cookies } from 'next/headers';
import { ApiProblem, type CallArgs } from '@/lib/api';
import { validTimeZone, TIME_ZONE_COOKIE } from '@/lib/format';
import type { Locale } from '@/lib/i18n/locales';
import { serverEnv } from '@/server/env';
import { ssrApi } from './api';

export const READ_TTL_MS = 60_000;
const MAX_ENTRIES = 1_000;

export type Missing = 'not_found' | 'gone';
export type Read<T> = { ok: true; data: T } | { ok: false; missing: Missing };

export const missingOf = (err: unknown): Missing | null =>
  err instanceof ApiProblem ? (err.status === 404 ? 'not_found' : err.status === 410 ? 'gone' : null) : null;

/** A TTL cache of promises; failed reads (other than 404/410) are dropped at once so the next request retries. */
export class ReadCache {
  readonly #entries = new Map<string, { at: number; value: Promise<Read<unknown>> }>();
  /** Backend calls made through this cache (DI-26 measurement; tests read it). */
  calls = 0;

  constructor(
    private readonly ttlMs = READ_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  get<T>(key: string, load: () => Promise<T>): Promise<Read<T>> {
    const now = this.now();
    const hit = this.#entries.get(key);
    if (hit && now - hit.at < this.ttlMs) return hit.value as Promise<Read<T>>;
    this.calls++;
    const value = load().then(
      (data): Read<T> => ({ ok: true, data }),
      (err: unknown): Read<T> => {
        const missing = missingOf(err);
        if (missing) return { ok: false, missing };
        this.#entries.delete(key);
        throw err;
      },
    );
    this.#entries.delete(key);
    this.#entries.set(key, { at: now, value });
    while (this.#entries.size > MAX_ENTRIES) this.#entries.delete(this.#entries.keys().next().value!);
    return value;
  }
}

const cache = new ReadCache();

/** The time zone the visitor's dates and "open now" use: the browser's (cp_tz) or the deployment default (OQ-13). */
export async function requestTimeZone(): Promise<string> {
  return validTimeZone((await cookies()).get(TIME_ZONE_COOKIE)?.value) ?? serverEnv().CARPAL_PWA_DEFAULT_TIME_ZONE;
}

/** One cached public read; throws only for failures other than 404/410 (the page's error boundary shows Retry). */
export async function publicRead<Id extends OperationId>(
  locale: Locale,
  opId: Id,
  args: CallArgs<Id>,
): Promise<Read<OperationResponse<Id>>> {
  const timeZone = await requestTimeZone();
  const key = `${opId}|${locale}|${timeZone}|${JSON.stringify(args)}`;
  const api = ssrApi(locale, timeZone);
  return cache.get(key, () => (api.api as (op: Id, a: CallArgs<Id>) => Promise<OperationResponse<Id>>)(opId, args));
}

/** Like publicRead for lists: a missing parent or a failure gives an empty page instead of failing the whole page. */
export async function publicList<Id extends OperationId>(
  locale: Locale,
  opId: Id,
  args: CallArgs<Id>,
): Promise<OperationResponse<Id> | null> {
  try {
    const r = await publicRead(locale, opId, args);
    return r.ok ? r.data : null;
  } catch (err) {
    console.warn(`${opId} failed during rendering`, err instanceof ApiProblem ? `${err.status} ${err.code}` : err);
    return null;
  }
}

export const readCalls = () => cache.calls;
