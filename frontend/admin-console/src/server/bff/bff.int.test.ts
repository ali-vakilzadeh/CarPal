// AC3.T7 integration: the admin BFF against the live backend (`pnpm dev` in backend/, strict mode for the acceptance
// run). The sign-in pages do not exist yet (AC4), so the test plays the browser through the BFF and its /id proxy:
// /bff/login → /id/oauth/authorize → password (proof of work in strict mode) → emailed code → device-bound passkey
// enrolment (a software security key) → passkey at aal3 → /id/oauth/authorize again → /bff/oauth/callback. Then
// admin.flags_list through the forwarder, a consumer path (404), a write without CSRF (403), the session view, and
// the check that no response the browser receives carries a token. A fresh ADM account per run comes from the
// backend's dev tool (`pnpm dev:staff create`), because a passkey enrolled by an earlier run cannot be used again.
//
// Backend settings (see README "Integration tests"): CARPAL_OAUTH_REDIRECT_URIS with cp-web-admin
// https://localhost:3200/bff/oauth/callback, CARPAL_WEBAUTHN_RP_ID=localhost, CARPAL_WEBAUTHN_ORIGINS with
// http://localhost:3200, and in strict mode CARPAL_STRICT_AUTH=1 plus the cp-web-admin public key in
// CARPAL_OAUTH_CLIENT_JWKS; this test then needs CARPAL_ADMIN_CLIENT_PRIVATE_JWKS (the private half) and
// CARPAL_STRICT_AUTH=1.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { cbor, SoftAuthenticator, solvePow } from '../../../tests/support/soft-authenticator';
import { DEFAULT_LIFETIMES, SESSION_COOKIE } from './config';
import { uuidv7 } from './crypto';
import { createBff, privateKeyJwt, type Bff } from './index';
import { LiteSessionStore } from './session/store';
import { Browser } from './test-support';

const ADMIN_API = process.env.CARPAL_ADMIN_API_URL ?? 'http://127.0.0.1:8081';
const AUTH = process.env.CARPAL_AUTH_URL ?? 'http://127.0.0.1:8082';
const STRICT = process.env.CARPAL_STRICT_AUTH === '1';
const BACKEND = join(import.meta.dirname, '..', '..', '..', '..', '..', 'backend');
const OUTBOX = join(BACKEND, '.data', 'outbox-mail.jsonl');
const ORIGIN = 'http://localhost:3200';
const REDIRECT = 'https://localhost:3200/bff/oauth/callback';
const PASSWORD = 'admin-console-int-password';

let bff: Bff;
const upstream: { url: string; method: string; headers: Headers }[] = [];
const browserSaw: string[] = [];
let email = '';

/** A browser that records every response it receives (headers and body) for the "no tokens in the browser" check. */
class RecordingBrowser extends Browser {
  override async fetch(path: string, init: RequestInit & { site?: string } = {}): Promise<Response> {
    const res = await super.fetch(path, init);
    browserSaw.push([...res.headers].map(([k, v]) => `${k}: ${v}`).join('\n'), await res.clone().text());
    return res;
  }
}

function createStaff(): string {
  const address = `bff-int-${Date.now()}@staff.carpals.test`;
  // backend `pnpm dev:staff create`, run with the backend's tsx directly (no shell: arguments stay whole on Windows).
  const tsx = join(BACKEND, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  execFileSync(
    process.execPath,
    [
      tsx,
      '--conditions=source',
      'tools/db/staff-cli.ts',
      'create',
      '--email',
      address,
      '--name',
      'BFF Integration',
      '--roles',
      'ADM',
      '--locale',
      'en',
      '--password',
      PASSWORD,
    ],
    {
      cwd: BACKEND,
      stdio: 'pipe',
      // The tool only needs the database; the test's own strict-mode settings would fail its config check.
      env: { ...process.env, CARPAL_STRICT_AUTH: '0', CARPAL_ADMIN_CLIENT_PRIVATE_JWKS: '' },
    },
  );
  return address;
}

function lastCode(to: string): string {
  const lines = readFileSync(OUTBOX, 'utf8').trim().split('\n').reverse();
  for (const line of lines) {
    const m = JSON.parse(line) as { to: string; template: string; variables: { code?: string } };
    if (m.to === to && m.template === 'identity.otp_code' && m.variables.code) return m.variables.code;
  }
  throw new Error(`no identity.otp_code mail for ${to}`);
}

beforeAll(async () => {
  const health = await fetch(`${AUTH}/.well-known/openid-configuration`).catch(() => null);
  if (!health?.ok) throw new Error(`backend not reachable at ${AUTH}: run \`pnpm dev\` in backend/ (README "Integration tests")`);
  const keys = process.env.CARPAL_ADMIN_CLIENT_PRIVATE_JWKS
    ? (JSON.parse(process.env.CARPAL_ADMIN_CLIENT_PRIVATE_JWKS) as Record<string, never>)
    : {};
  const key = keys['cp-web-admin'] as ({ kid: string; crv?: string } & Record<string, string>) | undefined;
  if (STRICT && !key) throw new Error('strict mode needs CARPAL_ADMIN_CLIENT_PRIVATE_JWKS with the cp-web-admin key');
  bff = createBff({
    config: {
      origin: ORIGIN,
      adminApiUrl: ADMIN_API,
      authUrl: AUTH,
      adminApiAudience: process.env.CARPAL_ADMIN_API_AUDIENCE ?? 'https://admin-api.carpals.ir',
      clientId: 'cp-web-admin',
      clientVersion: '0.1.0',
      locales: ['fa', 'en'],
      localeCookie: 'cpa_locale',
      ...DEFAULT_LIFETIMES,
      redirectUri: REDIRECT,
    },
    store: new LiteSessionStore({ sweepMs: 0 }),
    ...(key ? { clientAuth: privateKeyJwt(key, key.crv === 'Ed25519' ? 'EdDSA' : 'ES256') } : {}),
    fetch: async (input, init) => {
      upstream.push({ url: String(input), method: init?.method ?? 'GET', headers: new Headers(init?.headers) });
      return fetch(input, init);
    },
  });
  email = process.env.CARPAL_INT_STAFF_EMAIL ?? createStaff();
}, 120_000);

/** The whole staff sign-in through the BFF; returns the browser holding the session cookie. */
async function signIn(): Promise<RecordingBrowser> {
  const browser = new RecordingBrowser(bff, ORIGIN);
  const login = await browser.fetch('/bff/login?return_to=%2Fflags');
  expect(login.status).toBe(303);
  const authorize = new URL(login.headers.get('location')!);
  expect(authorize.searchParams.get('acr_values')).toBe('aal3');
  const authorizePath = `${authorize.pathname}${authorize.search}`;
  const toSignin = await browser.fetch(authorizePath);
  expect(toSignin.status).toBe(302);
  const signin = new URL(toSignin.headers.get('location')!);
  expect(`${signin.origin}${signin.pathname}`).toBe(`${ORIGIN}/id/signin`);
  const interaction = signin.searchParams.get('interaction_id')!;

  const post = async (path: string, body: Record<string, unknown>, extra: Record<string, string> = {}) =>
    browser.fetch(path, {
      method: 'POST',
      body: JSON.stringify({ interaction_id: interaction, ...body }),
      headers: { 'content-type': 'application/json', 'idempotency-key': uuidv7(), ...extra },
    });
  const pow = async () => {
    const res = await browser.fetch('/id/oauth/challenge', {
      method: 'POST',
      body: JSON.stringify({ purpose: 'signin' }),
      headers: { 'content-type': 'application/json' },
    });
    const c = (await res.json()) as { challenge_id: string; prefix: string; difficulty_bits: number };
    return { 'carpal-pow': `${c.challenge_id}.${solvePow(c.prefix, c.difficulty_bits)}` };
  };
  let first = await post('/id/v1/auth/signin', { email, password: PASSWORD }, STRICT ? await pow() : {});
  if (first.status === 403 && ((await first.clone().json()) as { code?: string }).code === 'ATTESTATION_REQUIRED')
    first = await post('/id/v1/auth/signin', { email, password: PASSWORD }, await pow());
  expect(first.status, await first.clone().text()).toBe(200);
  const key = new SoftAuthenticator('localhost', ORIGIN);
  expect(await first.json()).toEqual({ next: 'enrol_passkey' });
  const options = await post('/id/v1/auth/passkey-enrolment/options', { code: lastCode(email) });
  expect(options.status, await options.clone().text()).toBe(200);
  const enrolled = await post('/id/v1/auth/passkey-enrolment', {
    attestation: key.register((await options.json()) as Record<string, unknown>),
  });
  expect(enrolled.status, await enrolled.clone().text()).toBe(200);
  expect(await enrolled.json()).toEqual({ next: 'mfa', mfa_methods: ['webauthn'] });
  const o = (await (await post('/id/v1/auth/webauthn/options', { purpose: 'mfa' })).json()) as Record<string, unknown>;
  const verified = await post('/id/v1/auth/mfa/verify', { method: 'webauthn', assertion: key.assert(o) });
  expect(verified.status, await verified.clone().text()).toBe(200);
  expect(await verified.json()).toEqual({ next: 'complete' });

  // The sign-in page sends the browser back to the same authorize URL; the auth host answers with the code, and the
  // proxy maps the registered https callback to this http origin (OQ-11).
  const back = await browser.fetch(authorizePath);
  expect(back.status).toBe(302);
  const callback = new URL(back.headers.get('location')!);
  expect(`${callback.origin}${callback.pathname}`).toBe(`${ORIGIN}/bff/oauth/callback`);
  const done = await browser.fetch(`${callback.pathname}${callback.search}`);
  expect(done.status, done.headers.get('location') ?? '').toBe(303);
  expect(done.headers.get('location')).toBe('/flags');
  return browser;
}

describe('admin BFF against the live backend', () => {
  let browser: RecordingBrowser;

  it('signs a new staff member in at aal3 with a device-bound passkey, DPoP-bound tokens and the session view', async () => {
    browser = await signIn();
    const view = (await (await browser.fetch('/bff/session')).json()) as {
      signed_in: boolean;
      staff: { roles: string[]; acr: string; display_name: string; locale: string };
      idle_expires_at: string;
      expires_at: string;
    };
    expect(view.signed_in).toBe(true);
    expect(view.staff).toMatchObject({ roles: ['ADM'], acr: 'aal3', display_name: 'BFF Integration', locale: 'en' });
    expect(Date.parse(view.expires_at) - Date.now()).toBeGreaterThan(7.9 * 3_600_000);
    expect(Date.parse(view.idle_expires_at) - Date.now()).toBeLessThanOrEqual(30 * 60_000);
    const token = upstream.find((c) => c.url.endsWith('/oauth/token'))!;
    expect(token.headers.get('dpop')).toBeTruthy();
    // The auth host and the /id proxy clear their sign-in cookies once the code is issued: the session cookie is left,
    // with the staff member's language from admin.staff_me (AC4, GD-05; no secret).
    expect([...browser.cookies.keys()].sort()).toEqual([SESSION_COOKIE, 'cpa_locale']);
    expect(browser.cookies.get('cpa_locale')).toBe('en');
  });

  it('forwards admin.flags_list with the DPoP-bound token and CarPal-Client cp-web-admin', async () => {
    const res = await browser.fetch('/api/v1/admin/flags', { headers: { 'accept-language': 'en' } });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('carpal-contract')).toBe('1.3.0');
    const body = (await res.json()) as { items?: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
    const sent = upstream.filter((c) => c.url.startsWith(`${ADMIN_API}/v1/admin/flags`)).at(-1)!;
    expect(sent.headers.get('authorization')).toMatch(/^DPoP /);
    expect(sent.headers.get('dpop')).toBeTruthy();
    expect(sent.headers.get('carpal-client')).toBe('cp-web-admin/0.1.0 (web 1.0)');
  });

  it('answers 404 for a consumer path and 403 for a write without CSRF, without calling the backend', async () => {
    const before = upstream.length;
    expect((await browser.fetch('/api/v1/me')).status).toBe(404);
    expect((await browser.fetch('/api/v1/config/client')).status).toBe(404);
    const write = await browser.fetch('/api/v1/admin/flags/featured.enabled', {
      method: 'PATCH',
      body: JSON.stringify({ enabled: true, reason: 'integration test' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(write.status).toBe(403);
    expect(((await write.json()) as { code: string }).code).toBe('CSRF_FAILED');
    expect(upstream.length).toBe(before);
  });

  it('reads admin.staff_me through the forwarder and a PURP read without a work item is refused by the backend', async () => {
    const me = await browser.fetch('/api/v1/admin/me');
    expect(me.status).toBe(200);
    expect(((await me.json()) as { platform_roles: string[] }).platform_roles).toEqual(['platform_admin']);
    const read = await browser.fetch('/api/v1/admin/users/0193a5b0-0000-7000-8000-00000000000a');
    expect(read.status).toBe(400);
    expect(((await read.json()) as { code: string }).code).toBe('MALFORMED_REQUEST');
  });

  it('never gives the browser an access token, a refresh token or an ID token', () => {
    const all = browserSaw.join('\n');
    expect(all).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./);
    expect(all).not.toMatch(/cprt_|access_token|refresh_token|id_token/);
    for (const name of browser.cookies.keys()) expect(name).not.toMatch(/token/i);
  });

  it('signs out: the refresh token is revoked and the next call answers 401', async () => {
    const csrf = await browser.csrf();
    const out = await browser.fetch('/bff/logout', { method: 'POST', headers: { 'x-csrf-token': csrf } });
    expect(out.status).toBe(200);
    expect(upstream.some((c) => c.url.endsWith('/oauth/revoke'))).toBe(true);
    expect((await browser.fetch('/api/v1/admin/flags')).status).toBe(401);
  });

  it('the CBOR encoder writes the canonical header sizes', () => {
    expect(cbor(23).toString('hex')).toBe('17');
    expect(cbor(24).toString('hex')).toBe('1818');
    expect(cbor(-7).toString('hex')).toBe('26');
    expect(cbor('fmt').toString('hex')).toBe('63666d74');
  });
});
