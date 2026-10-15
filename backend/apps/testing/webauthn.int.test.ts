// S9a WebAuthn (GD-31, OQ-04: @simplewebauthn/server; 40 auth.webauthn_options,
// me.webauthn_register_options, me.mfa_confirm, auth.mfa_verify; SEC-AU-9,
// SEC-AU-10, SEC-ADM-2): a security key is registered with "none"
// attestation and user verification, then proves the second factor (aal3,
// device-bound) or signs in on its own as a passkey; a wrong credential is
// refused, and the admin client accepts device-bound WebAuthn only.
import { createHash, randomBytes } from 'node:crypto';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '#libs/crypto/index.js';
import { createInfra, type Infra } from '#libs/infra/index.js';
import type { TestUser } from '#libs/testing/index.js';
import { SoftAuthenticator } from '#libs/testing/webauthn.js';
import type { Json } from './s4-support.js';
import { client } from './s5-support.js';
import { createTestApp, testConfig, testLogger, type TestApp } from './test-app.js';

const PASSWORD = 'correct horse battery staple';
let infra: Infra;
let auth: TestApp;
let api: TestApp;

beforeAll(async () => {
  const config = testConfig();
  infra = createInfra(config, { dataDir: null, logger: testLogger(config) });
  auth = await createTestApp({ host: 'auth', infra });
  api = await createTestApp({ host: 'api', infra });
});
afterAll(async () => {
  await api.close();
  await auth.close();
  await infra.close();
});

const CLIENTS = {
  'cp-mobile': 'https://carpal.app/oauth/callback',
  'cp-web-admin': 'https://admin.carpal.app/bff/oauth/callback',
} as const;

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
    state: randomBytes(16).toString('base64url'),
    nonce: randomBytes(16).toString('base64url'),
  };
}

const authorizePath = (p: ReturnType<typeof pkce>, clientId: keyof typeof CLIENTS) =>
  `/oauth/authorize?${new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CLIENTS[clientId],
    scope: clientId === 'cp-mobile' ? 'openid offline_access' : 'openid',
    state: p.state,
    nonce: p.nonce,
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
  }).toString()}`;

async function interaction(clientId: keyof typeof CLIENTS = 'cp-mobile') {
  const p = pkce();
  const res = await auth.request({ path: authorizePath(p, clientId), client: null });
  expect(res.status, res.text).toBe(302);
  const id = new URL(res.headers.location!).searchParams.get('interaction_id')!;
  const cookie = (res.headers['set-cookie'] ?? '').split(';')[0]!;
  const post = (path: string, body: Json) =>
    auth.request<Json>({ method: 'POST', path, body, headers: { cookie, 'idempotency-key': uuidv7() } });
  /** Completed interaction → code → tokens (cp-mobile). */
  const tokens = async () => {
    const back = await auth.request({ path: authorizePath(p, clientId), client: null, headers: { cookie } });
    const code = new URL(back.headers.location!).searchParams.get('code')!;
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: CLIENTS[clientId],
      code_verifier: p.verifier,
    });
    return auth.request<Json>({
      method: 'POST',
      path: '/oauth/token',
      body: form.toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
  };
  return { id, post, tokens };
}

/** Registers a credential through me.webauthn_register_options → me.mfa_confirm. */
async function register(user: TestUser, key: SoftAuthenticator) {
  const c = client(api, await api.fixtures.token(user, { acr: 'aal2' }));
  const opts = await c.post('/v1/me/mfa-methods/webauthn/options', { label: 'My security key' });
  expect(opts.status, opts.text).toBe(200);
  const pending = (await c.get('/v1/me/mfa-methods')).body.items.find((m: Json) => m.method_type === 'webauthn' && m.status === 'pending');
  expect(pending).toBeDefined();
  const confirmed = await c.post(`/v1/me/mfa-methods/${pending.id}/confirm`, { attestation: key.register(opts.body) });
  return { opts, pending, confirmed, c };
}

describe('WebAuthn (GD-31)', () => {
  it('registers a security key, proves the second factor at aal3 and signs in with it as a passkey', async () => {
    const user = await api.fixtures.user();
    await api.fixtures.withPassword(user, PASSWORD);
    const key = new SoftAuthenticator();
    const { opts, confirmed } = await register(user, key);
    expect(opts.body).toMatchObject({
      rp: { id: 'carpal.app', name: 'CarPal' },
      attestation: 'none',
      authenticatorSelection: { userVerification: 'required' },
    });
    expect(confirmed.status, confirmed.text).toBe(200);
    expect(confirmed.body.method).toMatchObject({ method_type: 'webauthn', status: 'active', label: 'My security key' });
    expect(confirmed.body.recovery_codes).toHaveLength(10);

    // Password, then the key as second factor.
    const a = await interaction();
    expect((await a.post('/v1/auth/signin', { interaction_id: a.id, email: user.email, password: PASSWORD })).body).toEqual({
      next: 'mfa',
      mfa_methods: ['webauthn'],
    });
    const wrong = new SoftAuthenticator();
    const o1 = await a.post('/v1/auth/webauthn/options', { interaction_id: a.id, purpose: 'mfa' });
    expect(o1.status, o1.text).toBe(200);
    expect(o1.body.allowCredentials).toEqual([expect.objectContaining({ id: key.id })]);
    const refused = await a.post('/v1/auth/mfa/verify', { interaction_id: a.id, method: 'webauthn', assertion: wrong.assert(o1.body) });
    expect(refused.status).toBe(401);
    expect(refused.body.code).toBe('INVALID_CREDENTIALS');
    const o2 = await a.post('/v1/auth/webauthn/options', { interaction_id: a.id, purpose: 'mfa' });
    const ok = await a.post('/v1/auth/mfa/verify', { interaction_id: a.id, method: 'webauthn', assertion: key.assert(o2.body) });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body).toEqual({ next: 'complete' });
    const t = await a.tokens();
    expect(t.status, t.text).toBe(200);
    expect(decodeJwt(t.body.access_token as string).acr).toBe('aal3');

    // A replayed assertion (same challenge) is refused: the ceremony and the interaction are consumed.
    const replay = await a.post('/v1/auth/mfa/verify', { interaction_id: a.id, method: 'webauthn', assertion: key.assert(o2.body) });
    expect([401, 410]).toContain(replay.status);

    // The same key alone signs in (passkey, user verification required).
    const b = await interaction();
    const o3 = await b.post('/v1/auth/webauthn/options', { interaction_id: b.id, purpose: 'signin' });
    expect(o3.status, o3.text).toBe(200);
    expect(o3.body.userVerification).toBe('required');
    const signin = await b.post('/v1/auth/mfa/verify', { interaction_id: b.id, method: 'webauthn', assertion: key.assert(o3.body) });
    expect(signin.status, signin.text).toBe(200);
    expect(signin.body).toEqual({ next: 'complete' });
    const t2 = await b.tokens();
    expect(t2.status, t2.text).toBe(200);
    expect(decodeJwt(t2.body.access_token as string).sub).toBe(user.id);
    // Second factor options need a first factor first.
    const c = await interaction();
    expect((await c.post('/v1/auth/webauthn/options', { interaction_id: c.id, purpose: 'mfa' })).status).toBe(401);
  });

  it('refuses an attestation for another challenge, and staff sign-in accepts device-bound keys only (SEC-ADM-2)', async () => {
    const user = await api.fixtures.user();
    const key = new SoftAuthenticator();
    const c = client(api, await api.fixtures.token(user, { acr: 'aal2' }));
    await c.post('/v1/me/mfa-methods/webauthn/options', { label: 'Key A' });
    const pending = (await c.get('/v1/me/mfa-methods')).body.items.find(
      (m: Json) => m.method_type === 'webauthn' && m.status === 'pending',
    );
    const bad = await c.post(`/v1/me/mfa-methods/${pending.id}/confirm`, {
      attestation: key.register({ challenge: 'bm90LXRoZS1jaGFsbGVuZ2U' }),
    });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('CODE_INVALID');
    expect((await c.post(`/v1/me/mfa-methods/${pending.id}/confirm`, { code: '123456' })).status).toBe(422);

    // A staff member with a synced passkey (multi-device): the admin client refuses it.
    const staff = await api.fixtures.staff('platform_admin');
    await api.fixtures.withPassword(staff, PASSWORD);
    const synced = new SoftAuthenticator('carpal.app', 'https://admin.carpal.app', true);
    expect((await register(staff, synced)).confirmed.status).toBe(200);
    const s = await interaction('cp-web-admin');
    expect((await s.post('/v1/auth/signin', { interaction_id: s.id, email: staff.email, password: PASSWORD })).body).toEqual({
      next: 'mfa',
      mfa_methods: ['webauthn'],
    });
    const o = await s.post('/v1/auth/webauthn/options', { interaction_id: s.id, purpose: 'mfa' });
    const denied = await s.post('/v1/auth/mfa/verify', { interaction_id: s.id, method: 'webauthn', assertion: synced.assert(o.body) });
    expect(denied.status).toBe(401);
    // With a device-bound key the staff interaction completes at aal3.
    const hw = new SoftAuthenticator('carpal.app', 'https://admin.carpal.app');
    expect((await register(staff, hw)).confirmed.status).toBe(200);
    const s2 = await interaction('cp-web-admin');
    await s2.post('/v1/auth/signin', { interaction_id: s2.id, email: staff.email, password: PASSWORD });
    const o2 = await s2.post('/v1/auth/webauthn/options', { interaction_id: s2.id, purpose: 'mfa' });
    const ok = await s2.post('/v1/auth/mfa/verify', { interaction_id: s2.id, method: 'webauthn', assertion: hw.assert(o2.body) });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body).toEqual({ next: 'complete' });
  });
});
