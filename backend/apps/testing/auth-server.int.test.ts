// S3 auth server (40 §6.2, SEC-AU): the hosted sign-in interaction,
// authorization code + PKCE, refresh rotation with family revocation, the
// anonymous and client-credentials grants, sign-up / sign-in enumeration
// resistance, one-time codes, TOTP second factor, email verification and
// password reset. The auth host and the api host share one set of adapters
// (sessions in the KV store), as in pnpm dev.
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { uuidv7 } from '#libs/crypto/index.js';
import { createInfra, type Infra } from '#libs/infra/index.js';
import { base32Decode, hotp, solvePow, totpStep } from '#modules/identity/domain/credentials.js';
import { AttestationVerifierPort } from '#libs/runtime/index.js';
import { OutboxRelayService } from '#workers/outbox-relay/outbox-relay.module.js';
import { createTestApp, createTestWorker, testConfig, testLogger, type TestApp } from './test-app.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- deep assertions on validated responses
type Json = Record<string, any>;

const REDIRECT = 'https://carpal.app/oauth/callback';
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

const form = (fields: Record<string, string>) => ({
  body: new URLSearchParams(fields).toString(),
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
});

const cookieOf = (setCookie: string | undefined): string => (setCookie ?? '').split(';')[0]!;

interface Pkce {
  verifier: string;
  challenge: string;
  state: string;
  nonce: string;
}
const pkce = (): Pkce => {
  const verifier = randomBytes(32).toString('base64url');
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
    state: randomBytes(16).toString('base64url'),
    nonce: randomBytes(16).toString('base64url'),
  };
};

function authorizePath(p: Pkce, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: 'cp-mobile',
    redirect_uri: REDIRECT,
    scope: 'openid offline_access',
    state: p.state,
    nonce: p.nonce,
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
    ...extra,
  });
  return `/oauth/authorize?${q.toString()}`;
}

/** auth.authorize → hosted sign-in: the interaction id and its cookie. */
async function startInteraction(p: Pkce): Promise<{ id: string; cookie: string }> {
  const res = await auth.request({ path: authorizePath(p), client: null });
  expect(res.status).toBe(302);
  const location = new URL(res.headers.location!);
  expect(`${location.origin}${location.pathname}`).toBe('https://id.carpal.app/signin');
  expect(res.headers['set-cookie']).toMatch(/^__Host-cp_ia=[0-9a-f-]{36}; Path=\/; Secure; HttpOnly; SameSite=Lax/);
  return { id: location.searchParams.get('interaction_id')!, cookie: cookieOf(res.headers['set-cookie']) };
}

const authPost = <T = Json>(path: string, cookie: string, body: Json) =>
  auth.request<T>({ method: 'POST', path, body, headers: { cookie, 'idempotency-key': uuidv7() } });

/** Back to auth.authorize with the cookie once complete: the code on the redirect URI. */
async function finish(p: Pkce, cookie: string): Promise<string> {
  const res = await auth.request({ path: authorizePath(p), client: null, headers: { cookie } });
  expect(res.status).toBe(302);
  const back = new URL(res.headers.location!);
  expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
  expect(back.searchParams.get('state')).toBe(p.state);
  expect(back.searchParams.get('iss')).toBe('https://id.carpal.app');
  return back.searchParams.get('code')!;
}

const token = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
  auth.request<Json>({ method: 'POST', path: '/oauth/token', ...form(fields), headers: { ...form(fields).headers, ...headers } });

async function exchange(p: Pkce, code: string) {
  return token({ grant_type: 'authorization_code', client_id: 'cp-mobile', code, redirect_uri: REDIRECT, code_verifier: p.verifier });
}

/** A signed-in user with a password: tokens through the full browser flow. */
async function signIn(email: string, password = PASSWORD) {
  const p = pkce();
  const { id, cookie } = await startInteraction(p);
  const next = await authPost('/v1/auth/signin', cookie, { interaction_id: id, email, password });
  expect(next.status).toBe(200);
  expect(next.body).toEqual({ next: 'complete' });
  const res = await exchange(p, await finish(p, cookie));
  expect(res.status).toBe(200);
  return res.body;
}

const linkToken = (link: string | undefined): string => link!.split('#')[1]!;

describe('discovery and keys', () => {
  it('serves the OIDC discovery document and the Ed25519 JWKS, cacheable, without any header', async () => {
    const d = await auth.request<Json>({ path: '/.well-known/openid-configuration', client: null });
    expect(d.status).toBe(200);
    expect(d.headers['cache-control']).toBe('public, max-age=3600');
    expect(d.body).toMatchObject({
      issuer: 'https://id.carpal.app',
      code_challenge_methods_supported: ['S256'],
      id_token_signing_alg_values_supported: ['EdDSA'],
      dpop_signing_alg_values_supported: ['ES256'],
    });
    const j = await auth.request<Json>({ path: '/.well-known/jwks.json', client: null });
    expect(j.headers['cache-control']).toBe('public, max-age=600');
    expect(j.body.keys[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig' });
    expect(j.body.keys[0].d).toBeUndefined();
  });
});

describe('E2E (S3 acceptance): signup → email verify → authorize/token → me.get → refresh → reuse revokes the family', () => {
  it('runs the whole flow', async () => {
    const email = `e2e-${uuidv7()}@test.carpal.app`;
    // Sign-up inside an interaction.
    const p0 = pkce();
    const { id, cookie } = await startInteraction(p0);
    const signup = await authPost('/v1/auth/signup', cookie, {
      interaction_id: id,
      full_name: 'Sara Example',
      email: email.toUpperCase(),
      password: PASSWORD,
      locale: 'fa',
      terms_version: '1.0',
      privacy_policy_version: '1.0',
    });
    expect(signup.status).toBe(202);
    expect(signup.body).toEqual({ next: 'verify_email' });
    // Unverified: the correct password leads back to verification, not to a session.
    expect((await authPost('/v1/auth/signin', cookie, { interaction_id: id, email, password: PASSWORD })).body).toEqual({
      next: 'verify_email',
    });

    // Email verification link (ev, single use).
    const mail = auth.mail(email, 'identity.email_verification').at(-1)!;
    expect(mail.variables.link).toMatch(/^https:\/\/carpal\.app\/l\/ev#cp_ev_[A-Za-z0-9_-]{43}$/);
    const ev = linkToken(mail.variables.link);
    const verified = await auth.request<Json>({ method: 'POST', path: '/v1/auth/email/verify', body: { token: ev } });
    expect(verified.status).toBe(200);
    expect(verified.body).toEqual({ ok: true });
    const again = await auth.request<Json>({ method: 'POST', path: '/v1/auth/email/verify', body: { token: ev } });
    expect(again.status).toBe(410);
    expect(again.body.code).toBe('LINK_USED');
    // user.registered is in the outbox (first verification).
    const events = await auth.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
      db
        .selectFrom('core.domain_event_outbox')
        .innerJoin('identity.user_accounts as u', 'u.id', 'core.domain_event_outbox.aggregate_id')
        .select(['event_type'])
        .where('u.email', '=', email)
        .execute(),
    );
    expect(events.map((e) => e.event_type)).toEqual(['user.registered']);

    // Authorization code + PKCE.
    const tokens = await signIn(email);
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 300, scope: 'openid offline_access' });
    expect(tokens.refresh_token).toMatch(/^cprt_[A-Za-z0-9_-]{43}$/);
    expect(tokens.id_token.split('.')).toHaveLength(3);

    // me.get on the api host with the issued access token.
    const me = await api.request<Json>({ path: '/v1/me', token: tokens.access_token });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ email, status: 'active', locale: 'fa', mfa_enabled: false });
    expect(me.body.preference).toMatchObject({ calendar_system: 'jalali', digit_style: 'persian' });
    expect(me.body.memberships.map((m: Json) => m.role)).toEqual(['individual']);
    expect(me.body.subscription).toMatchObject({ plan_key: 'individual_free', max_vehicles: 5, active_vehicles: 0 });
    expect(me.headers['cache-control']).toBe('no-store');

    // Refresh rotation.
    const r1 = await token({ grant_type: 'refresh_token', client_id: 'cp-mobile', refresh_token: tokens.refresh_token });
    expect(r1.status).toBe(200);
    expect(r1.body.refresh_token).not.toBe(tokens.refresh_token);
    expect((await api.request({ path: '/v1/me', token: r1.body.access_token })).status).toBe(200);

    // Reuse of the rotated token revokes the whole family (session) and alerts the user.
    const reuse = await token({ grant_type: 'refresh_token', client_id: 'cp-mobile', refresh_token: tokens.refresh_token });
    expect(reuse.status).toBe(400);
    expect(reuse.body).toEqual({ error: 'invalid_grant', error_description: 'refresh token reused' });
    expect(reuse.headers['content-type']).toBe('application/json');
    expect((await api.request<Json>({ path: '/v1/me', token: r1.body.access_token })).status).toBe(401);
    const r2 = await token({ grant_type: 'refresh_token', client_id: 'cp-mobile', refresh_token: r1.body.refresh_token });
    expect(r2.status).toBe(400);
    expect(auth.mail(email, 'identity.security_alert')).toHaveLength(1);
  });
});

describe('authorization request rules (SEC-AU-1)', () => {
  it('never redirects to an unregistered URI; other errors go back to the client', async () => {
    const p = pkce();
    const bad = await auth.request<Json>({ path: authorizePath(p, { redirect_uri: 'https://evil.example/cb' }), client: null });
    expect(bad.status).toBe(400);
    expect(bad.headers.location).toBeUndefined();
    const scope = await auth.request({ path: authorizePath(p, { scope: 'openid admin' }), client: null });
    expect(scope.status).toBe(302);
    expect(new URL(scope.headers.location!).searchParams.get('error')).toBe('invalid_scope');
    const none = await auth.request({ path: authorizePath(p, { prompt: 'none' }), client: null });
    expect(new URL(none.headers.location!).searchParams.get('error')).toBe('login_required');
    // PKCE S256 only; state and nonce required by the schema.
    expect((await auth.request({ path: authorizePath(p, { code_challenge_method: 'plain' }), client: null })).status).toBe(422);
  });

  it('a code is single use, bound to the verifier and redirect URI; a replay revokes what it issued', async () => {
    const user = await auth.fixtures.user();
    await auth.fixtures.withPassword(user, PASSWORD);
    const p = pkce();
    const { id, cookie } = await startInteraction(p);
    await authPost('/v1/auth/signin', cookie, { interaction_id: id, email: user.email, password: PASSWORD });
    const code = await finish(p, cookie);
    const wrong = await token({
      grant_type: 'authorization_code',
      client_id: 'cp-mobile',
      code,
      redirect_uri: REDIRECT,
      code_verifier: pkce().verifier,
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe('invalid_grant');

    const p2 = pkce();
    const s2 = await startInteraction(p2);
    await authPost('/v1/auth/signin', s2.cookie, { interaction_id: s2.id, email: user.email, password: PASSWORD });
    const code2 = await finish(p2, s2.cookie);
    const first = await exchange(p2, code2);
    expect(first.status).toBe(200);
    const replay = await exchange(p2, code2);
    expect(replay.status).toBe(400);
    expect((await api.request({ path: '/v1/me', token: first.body.access_token })).status).toBe(401);
  });

  it('the interaction cookie must match the interaction (SEC-WEB-3 binding)', async () => {
    const p = pkce();
    const a = await startInteraction(p);
    const b = await startInteraction(pkce());
    const res = await authPost('/v1/auth/signin', b.cookie, { interaction_id: a.id, email: 'x@test.carpal.app', password: 'whatever-123' });
    expect(res.status).toBe(410);
    const unknown = await authPost('/v1/auth/signin', '', {
      interaction_id: uuidv7(),
      email: 'x@test.carpal.app',
      password: 'whatever-123',
    });
    expect(unknown.status).toBe(410);
  });
});

describe('enumeration resistance (SEC-AU-11)', () => {
  it('sign-up with an existing email answers the same and sends a notice instead', async () => {
    const user = await auth.fixtures.user();
    const { id, cookie } = await startInteraction(pkce());
    const res = await authPost('/v1/auth/signup', cookie, {
      interaction_id: id,
      full_name: 'Someone Else',
      email: user.email,
      password: 'another long passphrase',
      locale: 'en',
      terms_version: '1.0',
      privacy_policy_version: '1.0',
    });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ next: 'verify_email' });
    expect(auth.mail(user.email, 'identity.account_exists')).toHaveLength(1);
    expect(auth.mail(user.email, 'identity.email_verification')).toHaveLength(0);
  });

  it('sign-in failures are always INVALID_CREDENTIALS; breached passwords are refused at sign-up', async () => {
    const user = await auth.fixtures.user();
    await auth.fixtures.withPassword(user, PASSWORD);
    const { id, cookie } = await startInteraction(pkce());
    for (const body of [
      { email: user.email, password: 'wrong password!!' },
      { email: `nobody-${uuidv7()}@test.carpal.app`, password: PASSWORD },
    ]) {
      const res = await authPost('/v1/auth/signin', cookie, { interaction_id: id, ...body });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('INVALID_CREDENTIALS');
    }
    const breached = await authPost('/v1/auth/signup', cookie, {
      interaction_id: id,
      full_name: 'Weak Password',
      email: `weak-${uuidv7()}@test.carpal.app`,
      password: 'password1234',
      locale: 'en',
      terms_version: '1.0',
      privacy_policy_version: '1.0',
    });
    expect(breached.status).toBe(422);
    expect(breached.body.errors).toEqual([{ pointer: '/password', code: 'pattern' }]);
  });

  it('applies the fixed minimum latency to unknown and known accounts alike', async () => {
    const slow = await createTestApp({ host: 'auth', env: { CARPAL_AUTH_MIN_LATENCY_MS: '200' } });
    try {
      const p = pkce();
      const res = await slow.request({ path: authorizePath(p), client: null });
      const interactionId = new URL(res.headers.location!).searchParams.get('interaction_id')!;
      const c = cookieOf(res.headers['set-cookie']);
      for (const email of [`nobody-${uuidv7()}@test.carpal.app`, (await slow.fixtures.user()).email]) {
        const t0 = performance.now();
        const r = await slow.request({ method: 'POST', path: '/v1/auth/password-reset', body: { email } });
        expect(r.status).toBe(202);
        expect(performance.now() - t0).toBeGreaterThanOrEqual(195);
      }
      const t0 = performance.now();
      await slow.request({
        method: 'POST',
        path: '/v1/auth/signin',
        body: { interaction_id: interactionId, email: 'a@test.carpal.app', password: 'x' },
        headers: { cookie: c },
      });
      expect(performance.now() - t0).toBeGreaterThanOrEqual(195);
    } finally {
      await slow.close();
    }
  });
});

describe('one-time codes (SEC-AU-8)', () => {
  it('signs in with an email code; five wrong codes invalidate it', async () => {
    const user = await auth.fixtures.user();
    const p = pkce();
    const { id, cookie } = await startInteraction(p);
    const start = await authPost('/v1/auth/otp/start', cookie, {
      interaction_id: id,
      channel: 'email',
      destination: user.email,
      purpose: 'signin',
    });
    expect(start.status).toBe(202);
    const code = auth.mail(user.email, 'identity.otp_code').at(-1)!.variables.code!;
    const wrong = code === '000000' ? '111111' : '000000';
    const bad = await authPost('/v1/auth/otp/verify', cookie, { interaction_id: id, code: wrong });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('CODE_INVALID');
    const ok = await authPost('/v1/auth/otp/verify', cookie, { interaction_id: id, code });
    expect(ok.body).toEqual({ next: 'complete' });
    expect((await exchange(p, await finish(p, cookie))).status).toBe(200);

    const s2 = await startInteraction(pkce());
    await authPost('/v1/auth/otp/start', s2.cookie, {
      interaction_id: s2.id,
      channel: 'email',
      destination: user.email,
      purpose: 'signin',
    });
    const code2 = auth.mail(user.email, 'identity.otp_code').at(-1)!.variables.code!;
    for (let i = 0; i < 5; i++)
      await authPost('/v1/auth/otp/verify', s2.cookie, { interaction_id: s2.id, code: code2 === '222222' ? '333333' : '222222' });
    expect((await authPost('/v1/auth/otp/verify', s2.cookie, { interaction_id: s2.id, code: code2 })).body.code).toBe('CODE_INVALID');
  });

  it('answers 202 for unknown destinations without sending; SMS only to allowlisted countries', async () => {
    const { id, cookie } = await startInteraction(pkce());
    const nobody = `nobody-${uuidv7()}@test.carpal.app`;
    const res = await authPost('/v1/auth/otp/start', cookie, {
      interaction_id: id,
      channel: 'email',
      destination: nobody,
      purpose: 'signin',
    });
    expect(res.status).toBe(202);
    expect(auth.mail(nobody)).toHaveLength(0);
    const foreign = await authPost('/v1/auth/otp/start', cookie, {
      interaction_id: id,
      channel: 'sms',
      destination: '+15551234567',
      purpose: 'signin',
    });
    expect(foreign.status).toBe(422);
    const mismatch = await authPost('/v1/auth/otp/start', cookie, {
      interaction_id: id,
      channel: 'sms',
      destination: nobody,
      purpose: 'signin',
    });
    expect(mismatch.status).toBe(422);
  });
});

describe('TOTP second factor (SEC-AU-9) at sign-in', () => {
  it('needs the second factor after the password, issues aal2, refuses a replayed step; recovery codes work once', async () => {
    const user = await api.fixtures.user();
    await api.fixtures.withPassword(user, PASSWORD);
    const t = await api.fixtures.token(user, { mfaEnrolled: false });
    const enrol = await api.request<Json>({
      method: 'POST',
      path: '/v1/me/mfa-methods/totp',
      token: t,
      body: { label: 'Phone' },
      headers: { 'idempotency-key': uuidv7() },
    });
    expect(enrol.status).toBe(201);
    const secret = base32Decode(new URL(enrol.body.otpauth_uri).searchParams.get('secret')!);
    const step = totpStep();
    const confirm = await api.request<Json>({
      method: 'POST',
      path: `/v1/me/mfa-methods/${enrol.body.method.id}/confirm`,
      token: t,
      body: { code: hotp(secret, step) },
    });
    expect(confirm.status).toBe(200);
    const recovery = confirm.body.recovery_codes as string[];
    expect(recovery).toHaveLength(10);

    const p = pkce();
    const { id, cookie } = await startInteraction(p);
    expect((await authPost('/v1/auth/signin', cookie, { interaction_id: id, email: user.email, password: PASSWORD })).body).toEqual({
      next: 'mfa',
      mfa_methods: ['totp_mfa'],
    });
    // The code used at confirmation cannot be replayed.
    expect(
      (await authPost('/v1/auth/mfa/verify', cookie, { interaction_id: id, method: 'totp_mfa', code: hotp(secret, step) })).status,
    ).toBe(401);
    const ok = await authPost('/v1/auth/mfa/verify', cookie, { interaction_id: id, method: 'totp_mfa', code: hotp(secret, step + 1) });
    expect(ok.body).toEqual({ next: 'complete' });
    const tokens = (await exchange(p, await finish(p, cookie))).body;
    const claims = JSON.parse(Buffer.from(tokens.access_token.split('.')[1], 'base64url').toString()) as Json;
    expect(claims.acr).toBe('aal2');

    // Recovery code: single use.
    for (const expected of [{ next: 'complete' }, null]) {
      const pp = pkce();
      const s = await startInteraction(pp);
      await authPost('/v1/auth/signin', s.cookie, { interaction_id: s.id, email: user.email, password: PASSWORD });
      const r = await authPost('/v1/auth/mfa/verify', s.cookie, {
        interaction_id: s.id,
        method: 'recovery_code',
        recovery_code: recovery[0]!,
      });
      if (expected) expect(r.body).toEqual(expected);
      else expect(r.status).toBe(401);
    }
  });
});

describe('password reset', () => {
  it('sends a pr link, sets the new password once and ends every session', async () => {
    const user = await auth.fixtures.user();
    await auth.fixtures.withPassword(user, PASSWORD);
    const tokens = await signIn(user.email);
    expect((await auth.request({ method: 'POST', path: '/v1/auth/password-reset', body: { email: user.email } })).status).toBe(202);
    const pr = linkToken(auth.mail(user.email, 'identity.password_reset').at(-1)!.variables.link);
    expect(pr).toMatch(/^cp_pr_/);
    const weak = await auth.request<Json>({
      method: 'POST',
      path: '/v1/auth/password-reset/complete',
      body: { token: pr, new_password: '123456789012' },
    });
    expect(weak.status).toBe(422);
    const done = await auth.request<Json>({
      method: 'POST',
      path: '/v1/auth/password-reset/complete',
      body: { token: pr, new_password: 'a brand new passphrase' },
    });
    expect(done.status).toBe(200);
    expect(
      (
        await auth.request<Json>({
          method: 'POST',
          path: '/v1/auth/password-reset/complete',
          body: { token: pr, new_password: 'a brand new passphrase' },
        })
      ).body.code,
    ).toBe('LINK_USED');
    expect((await api.request({ path: '/v1/me', token: tokens.access_token })).status).toBe(401);
    expect((await token({ grant_type: 'refresh_token', client_id: 'cp-mobile', refresh_token: tokens.refresh_token })).status).toBe(400);
    await signIn(user.email, 'a brand new passphrase');
    // Unknown or malformed tokens are LINK_EXPIRED (no oracle).
    const unknown = await auth.request<Json>({
      method: 'POST',
      path: '/v1/auth/password-reset/complete',
      body: { token: `cp_pr_${randomBytes(32).toString('base64url')}`, new_password: 'a brand new passphrase' },
    });
    expect(unknown.body.code).toBe('LINK_EXPIRED');
  });
});

describe('other grants and revocation', () => {
  it('anonymous grant: 15 min, public.read search, DPoP-bound when a proof is sent; works on PUB routes', async () => {
    const plain = await token({ grant_type: 'urn:carpal:params:oauth:grant-type:anonymous', client_id: 'cp-mobile' });
    expect(plain.status).toBe(200);
    expect(plain.body).toMatchObject({ token_type: 'Bearer', expires_in: 900, scope: 'public.read search' });
    expect((await api.request({ path: '/v1/plans', token: plain.body.access_token })).status).toBe(200);

    const { privateKey, publicKey } = await generateKeyPair('ES256');
    const proof = await new SignJWT({
      htm: 'POST',
      htu: 'https://id.carpal.app/oauth/token',
      jti: uuidv7(),
      iat: Math.floor(Date.now() / 1000),
    })
      .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: await exportJWK(publicKey) })
      .sign(privateKey);
    const bound = await token({ grant_type: 'urn:carpal:params:oauth:grant-type:anonymous', client_id: 'cp-mobile' }, { dpop: proof });
    expect(bound.body.token_type).toBe('DPoP');
    const claims = JSON.parse(Buffer.from(bound.body.access_token.split('.')[1], 'base64url').toString()) as Json;
    expect(claims.cnf.jkt).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The same proof again is a replay.
    expect(
      (await token({ grant_type: 'urn:carpal:params:oauth:grant-type:anonymous', client_id: 'cp-mobile' }, { dpop: proof })).body.error,
    ).toBe('invalid_dpop_proof');
  });

  it('client credentials only for cp-ssr with public.read; unknown grants and clients are refused', async () => {
    const ssr = await token({ grant_type: 'client_credentials', client_id: 'cp-ssr' }, { 'carpal-client': 'cp-ssr/1.0.0 (web 1.0)' });
    expect(ssr.status).toBe(200);
    expect(ssr.body.scope).toBe('public.read');
    expect((await token({ grant_type: 'client_credentials', client_id: 'cp-mobile' })).body.error).toBe('unauthorized_client');
    expect((await token({ grant_type: 'password', client_id: 'cp-mobile' })).body.error).toBe('unsupported_grant_type');
    const bad = await token({ grant_type: 'refresh_token', client_id: 'cp-unknown', refresh_token: 'x' });
    expect(bad.status).toBe(401);
    expect(bad.body.error).toBe('invalid_client');
  });

  it('auth.revoke ends the session of a refresh or access token and always answers 200', async () => {
    const user = await auth.fixtures.user();
    await auth.fixtures.withPassword(user, PASSWORD);
    const a = await signIn(user.email);
    expect((await auth.request({ method: 'POST', path: '/oauth/revoke', ...form({ token: a.refresh_token }) })).status).toBe(200);
    expect((await api.request({ path: '/v1/me', token: a.access_token })).status).toBe(401);
    const b = await signIn(user.email);
    expect((await auth.request({ method: 'POST', path: '/oauth/revoke', ...form({ token: b.access_token }) })).status).toBe(200);
    expect((await api.request({ path: '/v1/me', token: b.access_token })).status).toBe(401);
    expect((await auth.request({ method: 'POST', path: '/oauth/revoke', ...form({ token: 'garbage' }) })).status).toBe(200);
  });
});

describe('proof of work (SEC-BF-7)', () => {
  it('issues a challenge whose solution the ATT verifier accepts exactly once', async () => {
    const res = await auth.request<Json>({ method: 'POST', path: '/oauth/challenge', body: { purpose: 'signup' } });
    expect(res.status).toBe(200);
    expect(res.body.difficulty_bits).toBe(8);
    const nonce = solvePow(res.body.prefix, res.body.difficulty_bits);
    const verifier = auth.app.get(AttestationVerifierPort, { strict: false });
    const pow = `${res.body.challenge_id}.${nonce}`;
    expect(await verifier.verify({ pow, opId: 'auth.signup' })).toBe(true);
    expect(await verifier.verify({ pow, opId: 'auth.signup' })).toBe(false);
    expect(await verifier.verify({ attestation: 'app-attest-token', opId: 'auth.signup' })).toBe(false);
  });
});

describe('user.registered through the worker (41 §6.2)', () => {
  it('the relay delivers it to billing, which creates Individual Free', async () => {
    const email = `worker-${uuidv7()}@test.carpal.app`;
    const { id, cookie } = await startInteraction(pkce());
    await authPost('/v1/auth/signup', cookie, {
      interaction_id: id,
      full_name: 'Worker Test',
      email,
      locale: 'en',
      terms_version: '1.0',
      privacy_policy_version: '1.0',
    });
    const ev = linkToken(auth.mail(email, 'identity.email_verification').at(-1)!.variables.link);
    expect((await auth.request({ method: 'POST', path: '/v1/auth/email/verify', body: { token: ev } })).status).toBe(200);
    const worker = await createTestWorker({ infra });
    try {
      // Deterministic delivery: relay the pending outbox rows, then wait until the bus has delivered them.
      await worker.get(OutboxRelayService).relay.settle();
      await worker.get(OutboxRelayService).relay.drainOnce();
      await infra.bus.idle();
      const rows = await auth.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
        db
          .selectFrom('billing.subscriptions as s')
          .innerJoin('identity.user_accounts as u', 'u.id', 's.subscriber_id')
          .innerJoin('billing.plans as p', 'p.id', 's.plan_id')
          .select(['p.plan_key', 's.status'])
          .where('u.email', '=', email)
          .execute(),
      );
      const outbox = await auth.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
        db
          .selectFrom('core.domain_event_outbox as o')
          .innerJoin('identity.user_accounts as u', 'u.id', 'o.aggregate_id')
          .select(['o.status', 'o.attempts', 'o.last_error'])
          .where('u.email', '=', email)
          .execute(),
      );
      expect({ rows, outbox }).toEqual({
        rows: [{ plan_key: 'individual_free', status: 'active' }],
        outbox: [{ status: 'published', attempts: 1, last_error: null }],
      });
    } finally {
      await worker.close();
    }
  });
});
