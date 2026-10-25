// P2.T9 integration: the BFF against the live backend in lite mode (`pnpm dev` in backend/ with the env of GD-05:
// CARPAL_OAUTH_REDIRECT_URIS listing https://localhost:3000/bff/oauth/callback; CARPAL_RATE_LIMIT_SCALE=100 keeps the
// auth buckets out of the way, BA-25). The hosted sign-in UI does not exist yet (P4), so the test plays the browser:
// /bff/login → /id/oauth/authorize (proxied) → /id/v1/auth/* → /id/oauth/authorize again → /bff/oauth/callback.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from './crypto';
import { DEFAULT_LIFETIMES } from './config';
import { createBff, type Bff } from './index';
import { LiteSessionStore } from './session/store';
import { Browser } from './test-support';

const API = process.env.CARPAL_API_URL ?? 'http://127.0.0.1:8080';
const AUTH = process.env.CARPAL_AUTH_URL ?? 'http://127.0.0.1:8082';
const OUTBOX = join(import.meta.dirname, '..', '..', '..', '..', 'backend', '.data', 'outbox-mail.jsonl');
const PASSWORD = 'correct horse battery staple';
// Docs/40 Url is https-only, so the registered redirect URI is https://localhost:3000/bff/oauth/callback (the BFF
// handler is called directly here; no server listens on that origin).
const ORIGIN = 'https://localhost:3000';

interface Seen {
  url: string;
  method: string;
}

let bff: Bff;
let store: LiteSessionStore;
const clock = { offset: 0 };
const upstream: Seen[] = [];
const browserSaw: string[] = [];

beforeAll(async () => {
  const health = await fetch(`${API}/v1/health`).catch(() => null);
  if (!health?.ok) throw new Error(`backend not reachable at ${API}: run \`pnpm dev\` in backend/ with the env of pwa/README.md`);
  store = new LiteSessionStore({ sweepMs: 0 });
  bff = createBff({
    config: {
      origin: ORIGIN,
      apiUrl: API,
      authUrl: AUTH,
      apiAudience: 'https://api.carpal.app',
      clientId: 'cp-web-consumer',
      ssrClientId: 'cp-ssr',
      clientVersion: '0.1.0',
      strict: false,
      locales: ['fa', 'en'],
      ...DEFAULT_LIFETIMES,
    },
    store,
    now: () => Date.now() + clock.offset,
    fetch: async (input, init) => {
      upstream.push({ url: String(input), method: init?.method ?? 'GET' });
      return fetch(input, init);
    },
  });
});

/** A browser that records every response it receives (headers and body) for the "no tokens in the browser" check. */
class RecordingBrowser extends Browser {
  constructor(b: Bff) {
    super(b, ORIGIN);
  }

  override async fetch(path: string, init: RequestInit & { site?: string } = {}): Promise<Response> {
    const res = await super.fetch(path, init);
    const body = await res.clone().text();
    browserSaw.push([...res.headers].map(([k, v]) => `${k}: ${v}`).join('\n'), body);
    return res;
  }
}

function verificationToken(email: string): string {
  const lines = readFileSync(OUTBOX, 'utf8').trim().split('\n').reverse();
  for (const line of lines) {
    const m = JSON.parse(line) as { to: string; template: string; variables: { link?: string } };
    if (m.to === email && m.template === 'identity.email_verification') return m.variables.link!.split('#')[1]!;
  }
  throw new Error(`no verification mail for ${email}`);
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/** Signs a fresh user up and in through the BFF and the proxied hosted sign-in endpoints. */
async function signUpAndIn(browser: RecordingBrowser, email: string): Promise<Response> {
  const login = await browser.fetch('/bff/login?return_to=%2Fen%2Fgarage');
  expect(login.status).toBe(303);
  const authorizePath = new URL(login.headers.get('location')!).pathname + new URL(login.headers.get('location')!).search;
  const toSignin = await browser.fetch(authorizePath);
  expect(toSignin.status).toBe(302);
  const signin = new URL(toSignin.headers.get('location')!);
  expect(`${signin.origin}${signin.pathname}`).toBe(`${ORIGIN}/id/signin`);
  const interaction = signin.searchParams.get('interaction_id')!;
  expect(browser.cookies.get('__Host-cp_ia')).toBe(interaction);

  const post = (path: string, body: unknown) =>
    browser.fetch(path, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', 'idempotency-key': uuidv7() },
    });
  const signup = await post('/id/v1/auth/signup', {
    interaction_id: interaction,
    full_name: 'Sara Example',
    email,
    password: PASSWORD,
    locale: 'en',
    terms_version: '1.0',
    privacy_policy_version: '1.0',
  });
  expect(signup.status).toBe(202);
  expect(await json(signup)).toEqual({ next: 'verify_email' });
  expect((await post('/id/v1/auth/email/verify', { token: verificationToken(email) })).status).toBe(200);
  const first = await post('/id/v1/auth/signin', { interaction_id: interaction, email, password: PASSWORD });
  expect(await json(first)).toEqual({ next: 'complete' });

  // The hosted UI sends the browser back to the same authorize URL; the auth host answers with the code.
  const back = await browser.fetch(authorizePath);
  expect(back.status).toBe(302);
  const callback = new URL(back.headers.get('location')!);
  expect(`${callback.origin}${callback.pathname}`).toBe(`${ORIGIN}/bff/oauth/callback`);
  return browser.fetch(`${callback.pathname}${callback.search}`);
}

describe('BFF against the live backend', () => {
  it('a guest gets an anonymous token lazily and reads config.client through the forwarder', async () => {
    const browser = new RecordingBrowser(bff);
    const res = await browser.fetch('/api/v1/config/client', { headers: { 'accept-language': 'fa' } });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toHaveProperty('flags');
    expect(res.headers.get('carpal-contract')).toBe('1.0.0');
    expect(browser.cookies.get('__Host-cp_sid')).toBeTruthy();
  });

  it('keeps a guest the same anonymous principal across token renewals (DI-17): its search session stays readable', async () => {
    const browser = new RecordingBrowser(bff);
    const csrf = await browser.csrf();
    const write = (path: string, body: unknown) =>
      browser.fetch(path, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      });
    const run = await write('/api/v1/search', {
      search_mode: 'providers',
      entry_point: 'search_box',
      query_text: 'brake pads',
      location: { mode: 'chosen_city', city_key: 'tehran' },
    });
    expect(run.status).toBe(200);
    const sessionId = (await json(run)).session_id as string;
    // Renew the anonymous token (16 min later): same DPoP key, so the same anonymous key on the backend.
    clock.offset += 16 * 60_000;
    try {
      const refine = await write(`/api/v1/search/${sessionId}/refine`, { sort: 'distance' });
      expect(refine.status).toBe(200);
    } finally {
      clock.offset -= 16 * 60_000;
    }
    const grants = upstream.filter((u) => u.url.endsWith('/oauth/token'));
    expect(grants.length).toBeGreaterThanOrEqual(2);
  });

  it('signs a user in with the code flow, calls me.get, refreshes after expiry, and logs out (P2 acceptance)', async () => {
    const browser = new RecordingBrowser(bff);
    await browser.fetch('/bff/csrf');
    const guestSid = browser.cookies.get('__Host-cp_sid');
    const email = `p2-${uuidv7()}@test.carpal.app`;

    const done = await signUpAndIn(browser, email);
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe('/en/garage');
    const sid = browser.cookies.get('__Host-cp_sid')!;
    expect(sid).not.toBe(guestSid);
    const view = await json(await browser.fetch('/bff/session'));
    expect(view).toMatchObject({ signed_in: true, locale: 'en', user: { display_name: 'Sara Example', acr: 'aal1' } });

    const me = await browser.fetch('/api/v1/me');
    expect(me.status).toBe(200);
    expect(await json(me)).toMatchObject({ email, status: 'active', locale: 'en' });

    // Refresh after the access token expired (clock moved past the 5-minute lifetime): rotation, then the call works.
    const before = (await store.get(sid))!.user!;
    clock.offset += 6 * 60_000;
    const again = await browser.fetch('/api/v1/me');
    expect(again.status).toBe(200);
    const after = (await store.get(sid))!.user!;
    expect(after.refreshToken).not.toBe(before.refreshToken);
    expect(after.accessToken).not.toBe(before.accessToken);
    // The rotated-out refresh token is dead.
    const reuse = await fetch(`${AUTH}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'carpal-client': 'cp-web-consumer/0.1.0 (web 1.0)' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: 'cp-web-consumer',
        refresh_token: before.refreshToken,
      }).toString(),
    });
    expect(reuse.status).toBe(400);
    expect(await json(reuse)).toMatchObject({ error: 'invalid_grant' });
    // Reuse revoked the whole family (SEC-AU-5): the session has ended; sign in again for the rest.
    const ended = await browser.fetch('/api/v1/me');
    expect(ended.status).toBe(401);
    expect(await json(ended)).toMatchObject({ code: 'SESSION_ENDED' });

    clock.offset = 0;
    const second = new RecordingBrowser(bff);
    await signInExisting(second, email);
    const sid2 = second.cookies.get('__Host-cp_sid')!;
    const rt = (await store.get(sid2))!.user!.refreshToken;
    const csrf = await second.csrf();
    const logout = await second.fetch('/bff/logout', { method: 'POST', headers: { 'x-csrf-token': csrf } });
    expect(logout.status).toBe(200);
    expect(await store.get(sid2)).toBeNull();
    // logout revoked the refresh token at the auth server.
    const revoked = await fetch(`${AUTH}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'carpal-client': 'cp-web-consumer/0.1.0 (web 1.0)' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: 'cp-web-consumer', refresh_token: rt }).toString(),
    });
    expect(revoked.status).toBe(400);
    const guest = await second.fetch('/api/v1/me');
    expect(guest.status).toBe(401);
  });

  it('never let an access, refresh or ID token reach the browser', async () => {
    expect(browserSaw.length).toBeGreaterThan(10);
    const all = browserSaw.join('\n');
    expect(all).not.toMatch(/cprt_[A-Za-z0-9_-]{20,}/);
    expect(all).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./);
  });

  it('answers 404 for paths outside the consumer audience without calling the backend', async () => {
    const browser = new RecordingBrowser(bff);
    const count = upstream.length;
    for (const path of [
      '/api/v1/orgs/0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/locations',
      '/api/v1/admin/flags',
      '/api/v1/orgs/0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/fleet/members',
    ])
      expect((await browser.fetch(path)).status, path).toBe(404);
    expect(upstream.length).toBe(count);
  });

  it('records how the backend treats cp-ssr on search operations (DI-14)', async () => {
    const cred = await bff.ssr.ssr();
    const res = await fetch(`${API}/v1/search`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cred.accessToken}`,
        'carpal-client': 'cp-ssr/0.1.0 (web 1.0)',
        'content-type': 'application/json',
        'accept-language': 'en',
      },
      body: JSON.stringify({
        search_mode: 'providers',
        entry_point: 'directory_page',
        location: { mode: 'chosen_city', city_key: 'tehran' },
      }),
    });
    // Backend scopes are not enforced per operation today: cp-ssr can run search (DI-14 resolved for now).
    expect(res.status).toBe(200);
  });
});

async function signInExisting(browser: RecordingBrowser, email: string): Promise<void> {
  const login = await browser.fetch('/bff/login?return_to=%2Fen');
  const loc = new URL(login.headers.get('location')!);
  const authorizePath = `${loc.pathname}${loc.search}`;
  const interaction = new URL((await browser.fetch(authorizePath)).headers.get('location')!).searchParams.get('interaction_id')!;
  const res = await browser.fetch('/id/v1/auth/signin', {
    method: 'POST',
    body: JSON.stringify({ interaction_id: interaction, email, password: PASSWORD }),
    headers: { 'content-type': 'application/json' },
  });
  expect(await res.json()).toEqual({ next: 'complete' });
  const back = new URL((await browser.fetch(authorizePath)).headers.get('location')!);
  const done = await browser.fetch(`${back.pathname}${back.search}`);
  expect(done.headers.get('location')).toBe('/en');
}
