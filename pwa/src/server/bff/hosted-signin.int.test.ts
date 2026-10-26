// P4 integration: the hosted sign-in's calls against the live backend in lite mode (`pnpm dev` in backend/ with the
// env of pwa/README.md), played the way src/features/auth plays them: verification by code instead of the link,
// completion through the authorize URL kept in the /id proxy's resume cookie (without prompt=login), a step-up for an
// account without a second factor (BA-11), and the password reset link.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { readResumeCookie, restartUrl, resumeUrl } from './auth-proxy';
import { DEFAULT_LIFETIMES } from './config';
import { uuidv7 } from './crypto';
import { createBff, type Bff } from './index';
import { LiteSessionStore } from './session/store';
import { Browser } from './test-support';

const API = process.env.CARPAL_API_URL ?? 'http://127.0.0.1:8080';
const AUTH = process.env.CARPAL_AUTH_URL ?? 'http://127.0.0.1:8082';
const OUTBOX = join(import.meta.dirname, '..', '..', '..', '..', 'backend', '.data', 'outbox-mail.jsonl');
const ORIGIN = 'https://localhost:3000';

let bff: Bff;

beforeAll(async () => {
  const health = await fetch(`${API}/v1/health`).catch(() => null);
  if (!health?.ok) throw new Error(`backend not reachable at ${API}: run \`pnpm dev\` in backend/ with the env of pwa/README.md`);
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
    store: new LiteSessionStore({ sweepMs: 0 }),
  });
});

/** The newest mail of a template to an address (lite outbox). */
function mail(to: string, template: string): Record<string, string> {
  for (const line of readFileSync(OUTBOX, 'utf8').trim().split('\n').reverse()) {
    const m = JSON.parse(line) as { to: string; template: string; variables: Record<string, string> };
    if (m.to === to && m.template === template) return m.variables;
  }
  throw new Error(`no ${template} mail for ${to}`);
}

const post = (browser: Browser, path: string, body: unknown) =>
  browser.fetch(path, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'idempotency-key': uuidv7() },
  });

/** /bff/login → authorize → the hosted sign-in URL; returns the interaction and the resume info the page would get. */
async function startSignin(browser: Browser, query: string) {
  const login = await browser.fetch(`/bff/login?${query}`);
  const authorize = new URL(login.headers.get('location')!);
  const toSignin = await browser.fetch(`${authorize.pathname}${authorize.search}`);
  expect(toSignin.status).toBe(302);
  const interaction = new URL(toSignin.headers.get('location')!).searchParams.get('interaction_id')!;
  const cookie = [...browser.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  const info = readResumeCookie(cookie, interaction);
  expect(info).not.toBeNull();
  return { interaction, info: info!, authorize };
}

/** Completion: the hosted page re-requests the authorize URL from the resume cookie, then the BFF callback runs. */
async function complete(browser: Browser, resume: string): Promise<Response> {
  const back = await browser.fetch(resume);
  expect(back.status).toBe(302);
  const cb = new URL(back.headers.get('location')!);
  expect(cb.pathname).toBe('/bff/oauth/callback');
  expect(browser.cookies.has('__Host-cp_iar')).toBe(false);
  return browser.fetch(`${cb.pathname}${cb.search}`);
}

describe('hosted sign-in against the live backend (P4)', () => {
  it('sign-up without a password, verified by code, completes through the resume cookie', async () => {
    const browser = new Browser(bff, ORIGIN);
    const email = `p4-${uuidv7()}@test.carpal.app`;
    const { interaction, info } = await startSignin(browser, 'return_to=%2Fen%2Fonboarding%3Fnext%3D%252Fen%252Fgarage&screen=signup');
    expect(restartUrl(info, { origin: ORIGIN })).toMatch(/^\/bff\/login\/restart\?state=/);

    const signup = await post(browser, '/id/v1/auth/signup', {
      interaction_id: interaction,
      full_name: 'Sara Example',
      email,
      locale: 'en',
      terms_version: '2026-10',
      privacy_policy_version: '2026-10',
    });
    expect(await signup.json()).toEqual({ next: 'verify_email' });
    const start = await post(browser, '/id/v1/auth/otp/start', {
      interaction_id: interaction,
      channel: 'email',
      destination: email,
      purpose: 'verify',
    });
    expect(start.status).toBe(202);
    const { code } = mail(email, 'identity.otp_code');
    expect(code).toMatch(/^\d{6}$/);
    const wrong = await post(browser, '/id/v1/auth/otp/verify', {
      interaction_id: interaction,
      code: code === '000000' ? '111111' : '000000',
    });
    expect((await wrong.json()).code).toBe('CODE_INVALID');
    const verified = await post(browser, '/id/v1/auth/otp/verify', { interaction_id: interaction, code });
    expect(await verified.json()).toEqual({ next: 'complete' });

    const done = await complete(browser, resumeUrl(info));
    expect(done.headers.get('location')).toBe('/en/onboarding?next=%2Fen%2Fgarage');
    const view = (await (await browser.fetch('/bff/session')).json()) as { signed_in: boolean; user: { acr: string } };
    expect(view.signed_in).toBe(true);

    // A new account has no onboarding flow yet; the first save creates it with If-Match "v1" (BA-14).
    const csrf = await browser.csrf();
    const list = (await (await browser.fetch('/api/v1/me/onboarding')).json()) as { items: { flow_type: string }[] };
    expect(list.items.filter((f) => f.flow_type === 'individual')).toEqual([]);
    const saved = await browser.fetch('/api/v1/me/onboarding/individual', {
      method: 'PUT',
      body: JSON.stringify({ current_step: 'vehicle', completed_step: 'role' }),
      headers: { 'content-type': 'application/json', 'if-match': '"v1"', 'x-csrf-token': csrf },
    });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { version: number }).version).toBe(1);
  });

  it('a step-up of an account without a second factor completes at aal1 after a fresh sign-in (BA-11)', async () => {
    const browser = new Browser(bff, ORIGIN);
    const email = `p4-${uuidv7()}@test.carpal.app`;
    const password = 'correct horse battery staple';
    const first = await startSignin(browser, 'return_to=%2Fen%2Fgarage');
    await post(browser, '/id/v1/auth/signup', {
      interaction_id: first.interaction,
      full_name: 'Sara Example',
      email,
      password,
      locale: 'en',
      terms_version: '2026-10',
      privacy_policy_version: '2026-10',
    });
    await post(browser, '/id/v1/auth/otp/start', {
      interaction_id: first.interaction,
      channel: 'email',
      destination: email,
      purpose: 'verify',
    });
    await post(browser, '/id/v1/auth/otp/verify', { interaction_id: first.interaction, code: mail(email, 'identity.otp_code').code });
    expect((await complete(browser, resumeUrl(first.info))).headers.get('location')).toBe('/en/garage');

    const step = await startSignin(browser, 'return_to=%2Fen%2Fsettings&step_up=aal2');
    expect(step.authorize.searchParams.get('prompt')).toBe('login');
    expect(resumeUrl(step.info)).not.toContain('prompt=');
    const signin = await post(browser, '/id/v1/auth/signin', { interaction_id: step.interaction, email, password });
    expect(await signin.json()).toEqual({ next: 'complete' });
    const done = await complete(browser, resumeUrl(step.info));
    expect(done.headers.get('location')).toBe('/en/settings');
  });

  it('password reset: same answer for unknown addresses; the link sets a new password', async () => {
    const browser = new Browser(bff, ORIGIN);
    const email = `p4-${uuidv7()}@test.carpal.app`;
    const { interaction } = await startSignin(browser, 'return_to=%2Fen');
    await post(browser, '/id/v1/auth/signup', {
      interaction_id: interaction,
      full_name: 'Sara Example',
      email,
      password: 'correct horse battery staple',
      locale: 'en',
      terms_version: '2026-10',
      privacy_policy_version: '2026-10',
    });
    const known = await post(browser, '/id/v1/auth/password-reset', { email });
    const unknown = await post(browser, '/id/v1/auth/password-reset', { email: `nobody-${uuidv7()}@test.carpal.app` });
    expect([known.status, unknown.status]).toEqual([202, 202]);
    expect(await known.json()).toEqual(await unknown.json());
    const token = mail(email, 'identity.password_reset').link!.split('#')[1]!;
    const breached = await post(browser, '/id/v1/auth/password-reset/complete', { token, new_password: 'password1234' });
    expect(((await breached.json()) as { errors: { pointer: string; code: string }[] }).errors).toEqual([
      expect.objectContaining({ pointer: '/new_password', code: 'pattern' }),
    ]);
    const ok = await post(browser, '/id/v1/auth/password-reset/complete', { token, new_password: 'winter tyres on the E90' });
    expect(ok.status).toBe(200);
    const again = await post(browser, '/id/v1/auth/password-reset/complete', { token, new_password: 'winter tyres on the E90' });
    expect(((await again.json()) as { code: string }).code).toBe('LINK_USED');
  });
});
