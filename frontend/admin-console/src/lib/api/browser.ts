// Browser transport (AC3.T5), adapted from pwa/src/lib/api/browser.ts: same-origin calls to the BFF forwarder under
// /api. Adds X-CSRF-Token on state changes (fetched once from /bff/csrf and fetched again once when the BFF refuses
// it: sign-in rotates the session), Accept-Language from the page language and CarPal-Timezone from the browser. No
// proof of work: staff never call an ATT operation.
import { createApiClient, type ApiClient, type ApiClientOptions, type Transport } from './client';

export interface CsrfSource {
  get(): Promise<string>;
  refresh(): Promise<string>;
}

export function createCsrfSource(doFetch: typeof fetch = (i, init) => fetch(i, init)): CsrfSource {
  let current: Promise<string> | undefined;
  const load = () =>
    (current = doFetch('/bff/csrf', { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`csrf: ${res.status}`);
        return ((await res.json()) as { csrf_token: string }).csrf_token;
      })
      .catch((err: unknown) => {
        current = undefined;
        throw err;
      }));
  return { get: () => current ?? load(), refresh: load };
}

let shared: CsrfSource | undefined;

/** The page's one CSRF source, shared by the typed client and the session helpers (logout, pending actions). */
export function sharedCsrfSource(): CsrfSource {
  return (shared ??= createCsrfSource());
}

/** After sign-out the BFF dropped the session: the next write fetches a new token. */
export function resetSharedCsrfSource(): void {
  shared = undefined;
}

const SAFE = new Set(['GET', 'HEAD']);

export function pageLocale(): string {
  return typeof document === 'undefined' ? 'fa' : document.documentElement.lang || 'fa';
}

export function browserTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

export function browserTransport(o: { csrf: CsrfSource; locale?: () => string; fetch?: typeof fetch }): Transport {
  const doFetch = o.fetch ?? ((i, init) => fetch(i, init));
  const locale = o.locale ?? pageLocale;
  return async (req) => {
    const send = async (refreshCsrf: boolean) => {
      const headers = new Headers(req.headers);
      headers.set('accept-language', locale());
      const tz = browserTimezone();
      if (tz) headers.set('carpal-timezone', tz);
      if (!SAFE.has(req.method)) headers.set('x-csrf-token', await (refreshCsrf ? o.csrf.refresh() : o.csrf.get()));
      return doFetch(`/api${req.path}${req.search}`, {
        method: req.method,
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
        ...(req.body !== undefined ? { body: req.body } : {}),
        ...(req.signal ? { signal: req.signal } : {}),
      });
    };
    const res = await send(false);
    if (res.status === 403 && !SAFE.has(req.method)) {
      const reason = await res
        .clone()
        .json()
        .then((b: { code?: string; reason?: string }) => (b.code === 'CSRF_FAILED' ? b.reason : undefined))
        .catch(() => undefined);
      // The session was rotated (sign-in, step-up) since the token was fetched: fetch the new one once.
      if (reason === 'token' || reason === 'no_session') return send(true);
    }
    return res;
  };
}

export function createBrowserApiClient(o: Partial<ApiClientOptions> & { csrf?: CsrfSource } = {}): ApiClient {
  const csrf = o.csrf ?? sharedCsrfSource();
  return createApiClient({ transport: browserTransport({ csrf }), ...o });
}
