// Browser transport (GD-09): same-origin calls to the BFF — api-host operations under /api, auth-host operations
// (the hosted sign-in, P4) under /id. Adds X-CSRF-Token on state changes (fetched once from /bff/csrf and refreshed
// once when the BFF refuses it), Accept-Language from the page language and CarPal-Timezone from the browser.
import { createApiClient, type ApiClient, type ApiClientOptions, type PowPurpose, type Transport } from './client';
import { solvePowChallenge } from './pow';

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
    const prefix = req.host === 'auth' ? '/id' : '/api';
    const send = async (refreshCsrf: boolean) => {
      const headers = new Headers(req.headers);
      headers.set('accept-language', locale());
      const tz = browserTimezone();
      if (tz) headers.set('carpal-timezone', tz);
      if (!SAFE.has(req.method) && req.host === 'api') headers.set('x-csrf-token', await (refreshCsrf ? o.csrf.refresh() : o.csrf.get()));
      return doFetch(`${prefix}${req.path}${req.search}`, {
        method: req.method,
        headers,
        credentials: 'same-origin',
        ...(req.body !== undefined ? { body: req.body } : {}),
        ...(req.signal ? { signal: req.signal } : {}),
      });
    };
    const res = await send(false);
    if (res.status === 403 && !SAFE.has(req.method) && req.host === 'api') {
      const reason = await res
        .clone()
        .json()
        .then((b: { code?: string; reason?: string }) => (b.code === 'CSRF_FAILED' ? b.reason : undefined))
        .catch(() => undefined);
      // The pre-session expired or was replaced (sign-in rotates it): fetch the new token once.
      if (reason === 'token' || reason === 'no_session') return send(true);
    }
    return res;
  };
}

/** auth.pow_challenge through the /id proxy, solved off the main thread. */
export async function browserPow(purpose: PowPurpose, doFetch: typeof fetch = (i, init) => fetch(i, init)): Promise<string> {
  const res = await doFetch('/id/oauth/challenge', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ purpose }),
  });
  if (!res.ok) throw new Error(`pow challenge: ${res.status}`);
  const c = (await res.json()) as { challenge_id: string; prefix: string; difficulty_bits: number };
  return `${c.challenge_id}.${await solvePowChallenge(c.prefix, c.difficulty_bits)}`;
}

export function createBrowserApiClient(o: Partial<ApiClientOptions> & { csrf?: CsrfSource } = {}): ApiClient {
  const csrf = o.csrf ?? createCsrfSource();
  return createApiClient({ transport: browserTransport({ csrf }), solvePow: (p) => browserPow(p), ...o });
}
