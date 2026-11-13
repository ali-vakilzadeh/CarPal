// S12 (contract 1.3.0, admin console prerequisites; frontend/admin-console/dev-plan.json AC2): staff sign-in on
// cp-web-admin end to end in strict mode (password → emailed code → first device-bound passkey → aal3 with it →
// DPoP-bound token by private_key_jwt → admin.staff_me), the enrolment rules (a synced passkey is refused and nothing is
// stored, a one-time code alone never opens enrolment, five wrong codes end it, non-staff never get it), and the
// first-run staff bootstrap (OQ-10: creates what is missing, never touches what exists).
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { calculateJwkThumbprint, decodeJwt, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';
import { CryptoServices, uuidv7 } from '#libs/crypto/index.js';
import { createInfra, type Infra } from '#libs/infra/index.js';
import type { TestUser } from '#libs/testing/index.js';
import { SoftAuthenticator } from '#libs/testing/webauthn.js';
import { solvePow } from '#modules/identity/domain/credentials.js';
import { bootstrapStaff, DEV_STAFF_PASSWORD, parseSpec } from '#tools/db/staff.js';
import type { Json } from './s4-support.js';
import { createTestApp, testConfig, testLogger, type TestApp } from './test-app.js';

const ADMIN = 'cp-web-admin/1.0.0 (web 1.0)';
const ISSUER = 'https://id.carpals.ir';
const TOKEN_URL = `${ISSUER}/oauth/token`;
const ADMIN_API = 'https://admin-api.carpals.ir';
const REDIRECT = 'https://admin.carpals.ir/bff/oauth/callback';
const ORIGIN = 'https://admin.carpals.ir';
const PASSWORD = 'correct horse battery staple';
const JWT_BEARER = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

const formOf = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
const cookieOf = (setCookie: string | undefined): string => (setCookie ?? '').split(';')[0]!;

async function dpopKey() {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  return { privateKey, jwk: await exportJWK(publicKey) };
}

function proof(key: { privateKey: CryptoKey; jwk: JWK }, o: { url?: string; method?: string; nonce?: string; accessToken?: string } = {}) {
  return new SignJWT({
    htm: o.method ?? 'POST',
    htu: o.url ?? TOKEN_URL,
    jti: uuidv7(),
    ...(o.nonce ? { nonce: o.nonce } : {}),
    ...(o.accessToken ? { ath: createHash('sha256').update(o.accessToken).digest('base64url') } : {}),
  })
    .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: key.jwk })
    .setIssuedAt()
    .sign(key.privateKey);
}

/** One cp-web-admin authorization (code + PKCE) and the hosted sign-in calls of its interaction. */
async function adminSignin(auth: TestApp, o: { pow?: boolean } = {}) {
  const verifier = randomBytes(32).toString('base64url');
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: 'cp-web-admin',
    redirect_uri: REDIRECT,
    scope: 'openid',
    state: randomBytes(16).toString('base64url'),
    nonce: randomBytes(16).toString('base64url'),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    acr_values: 'aal3',
  });
  const start = await auth.request({ path: `/oauth/authorize?${q.toString()}`, client: null });
  expect(start.status, start.text).toBe(302);
  // BR-02 needs no backend change: the auth host sends the browser to <issuer>/signin, which the console's /id proxy
  // serves on its own origin, as the PWA's does (pwa/src/server/bff/auth-proxy.ts rewriteLocation).
  expect(start.headers.location).toMatch(new RegExp(`^${ISSUER}/signin\\?interaction_id=`));
  const id = new URL(start.headers.location!).searchParams.get('interaction_id')!;
  const cookie = cookieOf(start.headers['set-cookie']);
  const post = async (path: string, body: Json) => {
    const headers: Record<string, string> = { cookie, 'idempotency-key': uuidv7() };
    if (o.pow && path === '/v1/auth/signin') {
      const c = await auth.request<Json>({ method: 'POST', path: '/oauth/challenge', body: { purpose: 'signin' }, client: ADMIN });
      headers['carpal-pow'] = `${c.body.challenge_id}.${solvePow(c.body.prefix, c.body.difficulty_bits)}`;
    }
    return auth.request<Json>({ method: 'POST', path, body: { interaction_id: id, ...body }, headers, client: ADMIN });
  };
  /** The completed interaction's authorization code. */
  const code = async () => {
    const back = await auth.request({ path: `/oauth/authorize?${q.toString()}`, client: null, headers: { cookie } });
    expect(back.status, back.text).toBe(302);
    return new URL(back.headers.location!).searchParams.get('code')!;
  };
  return { id, post, code, verifier };
}

type Signin = Awaited<ReturnType<typeof adminSignin>>;

/** Password → enrol_passkey → emailed code → register `key` → mfa with it → complete. */
async function enrolAndComplete(auth: TestApp, s: Signin, user: TestUser, key: SoftAuthenticator) {
  expect((await s.post('/v1/auth/signin', { email: user.email, password: PASSWORD })).body).toEqual({ next: 'enrol_passkey' });
  const code = auth.mail(user.email, 'identity.otp_code').at(-1)!.variables.code!;
  const options = await s.post('/v1/auth/passkey-enrolment/options', { code });
  expect(options.status, options.text).toBe(200);
  expect(options.body).toMatchObject({
    rp: { id: 'carpals.ir' },
    attestation: 'none',
    authenticatorSelection: { userVerification: 'required' },
  });
  const enrolled = await s.post('/v1/auth/passkey-enrolment', { attestation: key.register(options.body) });
  expect(enrolled.status, enrolled.text).toBe(200);
  // S16a: the first key comes with the staff recovery codes, shown once.
  expect(enrolled.body).toMatchObject({ next: 'mfa', mfa_methods: ['webauthn'] });
  expect(enrolled.body.recovery_codes).toHaveLength(10);
  const o = await s.post('/v1/auth/webauthn/options', { purpose: 'mfa' });
  const ok = await s.post('/v1/auth/mfa/verify', { method: 'webauthn', assertion: key.assert(o.body) });
  expect(ok.status, ok.text).toBe(200);
  expect(ok.body).toEqual({ next: 'complete' });
}

describe('S12 strict mode: staff sign-in on cp-web-admin (BR-01, BR-03, BR-04)', () => {
  let infra: Infra;
  let auth: TestApp;
  let admin: TestApp;
  let adminKey: CryptoKey;
  let nonce = '';

  const assertion = (key: CryptoKey) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ jti: uuidv7() })
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuer('cp-web-admin')
      .setSubject('cp-web-admin')
      .setAudience(TOKEN_URL)
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .sign(key);
  };
  const token = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
    auth.request<Json>({
      method: 'POST',
      path: '/oauth/token',
      body: formOf(fields),
      client: ADMIN,
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    });
  async function withNonce(fields: () => Promise<Record<string, string>>, key: { privateKey: CryptoKey; jwk: JWK }) {
    const first = await token(await fields(), { dpop: await proof(key, nonce ? { nonce } : {}) });
    if (first.body.error !== 'use_dpop_nonce') return first;
    nonce = first.headers['dpop-nonce']!;
    return token(await fields(), { dpop: await proof(key, { nonce }) });
  }

  beforeAll(async () => {
    const consumer = await generateKeyPair('ES256');
    const ssr = await generateKeyPair('ES256');
    const adm = await generateKeyPair('ES256');
    adminKey = adm.privateKey;
    const jwks = JSON.stringify({
      'cp-web-consumer': { keys: [await exportJWK(consumer.publicKey)] },
      'cp-ssr': { keys: [await exportJWK(ssr.publicKey)] },
      'cp-web-admin': { keys: [await exportJWK(adm.publicKey)] },
    });
    const env = { CARPAL_STRICT_AUTH: '1', CARPAL_OAUTH_CLIENT_JWKS: jwks };
    const config = testConfig(env);
    infra = createInfra(config, { dataDir: null, logger: testLogger(config) });
    auth = await createTestApp({ host: 'auth', infra, env });
    admin = await createTestApp({ host: 'admin-api', infra, env });
  });
  afterAll(async () => {
    await admin?.close();
    await auth?.close();
    await infra?.close();
  });

  it('a new staff member enrols a passkey inside the sign-in, gets a DPoP-bound aal3 token and reads admin.staff_me', async () => {
    const staff = await auth.fixtures.staff('platform_admin', 'platform_community_reviewer');
    await auth.fixtures.withPassword(staff, PASSWORD);
    const key = new SoftAuthenticator('carpals.ir', ORIGIN);
    const s = await adminSignin(auth, { pow: true });
    await enrolAndComplete(auth, s, staff, key);
    expect(auth.mail(staff.email, 'identity.staff_passkey_added')).toHaveLength(1);

    const code = await s.code();
    const dpop = await dpopKey();
    const fields = async () => ({
      grant_type: 'authorization_code',
      client_id: 'cp-web-admin',
      code,
      redirect_uri: REDIRECT,
      code_verifier: s.verifier,
      client_assertion_type: JWT_BEARER,
      client_assertion: await assertion(adminKey),
    });
    // Without an assertion: invalid_client, and the code is not spent (it is checked first).
    const bare = await token({
      grant_type: 'authorization_code',
      client_id: 'cp-web-admin',
      code,
      redirect_uri: REDIRECT,
      code_verifier: s.verifier,
    });
    expect(bare.status).toBe(401);
    expect(bare.body.error).toBe('invalid_client');
    const res = await withNonce(fields, dpop);
    expect(res.status, res.text).toBe(200);
    expect(res.body.token_type).toBe('DPoP');
    expect(res.body.refresh_token).toBeDefined();
    const accessToken = res.body.access_token as string;
    const claims = decodeJwt(accessToken) as Json;
    expect(claims).toMatchObject({ acr: 'aal3', aud: ADMIN_API, client_id: 'cp-web-admin' });
    expect(claims.cnf.jkt).toBe(await calculateJwkThumbprint(dpop.jwk, 'sha256'));

    const url = `${ADMIN_API}/v1/admin/me`;
    const me = await admin.request<Json>({
      path: '/v1/admin/me',
      token: accessToken,
      client: ADMIN,
      headers: { dpop: await proof(dpop, { method: 'GET', url, accessToken }) },
    });
    expect(me.status, me.text).toBe(200);
    expect(me.body).toMatchObject({
      user_id: staff.id,
      email: staff.email,
      platform_roles: ['platform_admin', 'platform_community_reviewer'],
      acr: 'aal3',
    });
    const left = Date.parse(me.body.session_expires_at as string) - Date.now();
    expect(left).toBeGreaterThan(7.9 * 3_600_000);
    expect(left).toBeLessThanOrEqual(8 * 3_600_000);
    // The token alone (no proof) is refused on the admin plane.
    expect((await admin.request({ path: '/v1/admin/me', token: accessToken, client: ADMIN })).status).toBe(401);

    // A later sign-in goes straight to the passkey (no enrolment, no code).
    const again = await adminSignin(auth, { pow: true });
    expect((await again.post('/v1/auth/signin', { email: staff.email, password: PASSWORD })).body).toEqual({
      next: 'mfa',
      mfa_methods: ['webauthn'],
    });
  });
});

describe('S12 enrolment rules and the staff bootstrap (lite)', () => {
  let infra: Infra;
  let auth: TestApp;
  let admin: TestApp;
  let api: TestApp;

  beforeAll(async () => {
    const config = testConfig();
    infra = createInfra(config, { dataDir: null, logger: testLogger(config) });
    auth = await createTestApp({ host: 'auth', infra });
    admin = await createTestApp({ host: 'admin-api', infra });
    api = await createTestApp({ host: 'api', infra });
  });
  afterAll(async () => {
    await api?.close();
    await admin?.close();
    await auth?.close();
    await infra?.close();
  });

  const webauthnMethods = (user: TestUser) =>
    auth.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
      db
        .selectFrom('identity.authentication_methods')
        .select(['status'])
        .where('user_id', '=', user.id)
        .where('method_type', '=', 'webauthn')
        .where('deleted_at', 'is', null)
        .execute(),
    );

  it('refuses a synced passkey without storing it, then accepts a device-bound one', async () => {
    const staff = await auth.fixtures.staff('platform_moderator');
    await auth.fixtures.withPassword(staff, PASSWORD);
    const s = await adminSignin(auth);
    expect((await s.post('/v1/auth/signin', { email: staff.email, password: PASSWORD })).body).toEqual({ next: 'enrol_passkey' });
    const code = auth.mail(staff.email, 'identity.otp_code').at(-1)!.variables.code!;
    const synced = new SoftAuthenticator('carpals.ir', ORIGIN, true);
    const o1 = await s.post('/v1/auth/passkey-enrolment/options', { code });
    const refused = await s.post('/v1/auth/passkey-enrolment', { attestation: synced.register(o1.body) });
    expect(refused.status, refused.text).toBe(422);
    expect(refused.body.code).toBe('PASSKEY_NOT_DEVICE_BOUND');
    expect((await webauthnMethods(staff)).filter((m) => m.status === 'active')).toHaveLength(0);
    // The same code asks again (a cancelled or refused prompt does not spend it).
    const hw = new SoftAuthenticator('carpals.ir', ORIGIN);
    const o2 = await s.post('/v1/auth/passkey-enrolment/options', { code });
    expect(o2.status, o2.text).toBe(200);
    expect((await s.post('/v1/auth/passkey-enrolment', { attestation: hw.register(o2.body) })).body).toMatchObject({
      next: 'mfa',
      mfa_methods: ['webauthn'],
    });
    expect((await webauthnMethods(staff)).filter((m) => m.status === 'active')).toHaveLength(1);
    // Enrolment is over for this interaction: a second credential cannot be added through it.
    const o3 = await s.post('/v1/auth/passkey-enrolment/options', { code });
    expect(o3.status).toBe(401);
  });

  it('wrong codes count and five end the enrolment; the options need a code and an enrolment in progress', async () => {
    const staff = await auth.fixtures.staff('platform_support');
    await auth.fixtures.withPassword(staff, PASSWORD);
    const s = await adminSignin(auth);
    // Before the password: no enrolment.
    expect((await s.post('/v1/auth/passkey-enrolment/options', { code: '000000' })).status).toBe(401);
    expect((await s.post('/v1/auth/passkey-enrolment', { attestation: {} })).status).toBe(401);
    await s.post('/v1/auth/signin', { email: staff.email, password: PASSWORD });
    const code = auth.mail(staff.email, 'identity.otp_code').at(-1)!.variables.code!;
    const wrong = code === '123456' ? '654321' : '123456';
    for (let n = 0; n < 4; n++)
      expect((await s.post('/v1/auth/passkey-enrolment/options', { code: wrong })).body.code).toBe('CODE_INVALID');
    expect((await s.post('/v1/auth/passkey-enrolment/options', { code: wrong })).body.code).toBe('CODE_INVALID');
    // The fifth wrong code ended it: even the right one is refused now.
    expect((await s.post('/v1/auth/passkey-enrolment/options', { code })).status).toBe(401);
    // An attestation without options is refused too.
    expect((await s.post('/v1/auth/passkey-enrolment', { attestation: {} })).status).toBe(401);
  });

  it('a one-time code as first factor never opens enrolment, and non-staff never get it', async () => {
    const staff = await auth.fixtures.staff('platform_admin');
    const s = await adminSignin(auth);
    await s.post('/v1/auth/otp/start', { channel: 'email', destination: staff.email, purpose: 'signin' });
    const code = auth.mail(staff.email, 'identity.otp_code').at(-1)!.variables.code!;
    expect((await s.post('/v1/auth/otp/verify', { code })).body).toEqual({ next: 'mfa', mfa_methods: ['webauthn'] });
    expect((await s.post('/v1/auth/passkey-enrolment/options', { code })).status).toBe(401);

    const user = await auth.fixtures.user();
    await auth.fixtures.withPassword(user, PASSWORD);
    const u = await adminSignin(auth);
    expect((await u.post('/v1/auth/signin', { email: user.email, password: PASSWORD })).body).toEqual({
      next: 'mfa',
      mfa_methods: ['webauthn'],
    });
    expect(auth.mail(user.email, 'identity.otp_code')).toHaveLength(0);
  });

  it('a staff member with a device-bound passkey goes straight to it; the consumer client never enrols', async () => {
    const staff = await auth.fixtures.staff('platform_admin');
    await auth.fixtures.withPassword(staff, PASSWORD);
    await enrolAndComplete(auth, await adminSignin(auth), staff, new SoftAuthenticator('carpals.ir', ORIGIN));
    const next = await adminSignin(auth);
    expect((await next.post('/v1/auth/signin', { email: staff.email, password: PASSWORD })).body).toEqual({
      next: 'mfa',
      mfa_methods: ['webauthn'],
    });

    const other = await auth.fixtures.staff('platform_moderator');
    await auth.fixtures.withPassword(other, PASSWORD);
    const p = new URLSearchParams({
      response_type: 'code',
      client_id: 'cp-web-consumer',
      redirect_uri: 'https://pwa.carpals.ir/bff/oauth/callback',
      scope: 'openid',
      state: randomBytes(16).toString('base64url'),
      nonce: randomBytes(16).toString('base64url'),
      code_challenge: createHash('sha256').update('v'.repeat(43)).digest('base64url'),
      code_challenge_method: 'S256',
    });
    const start = await auth.request({ path: `/oauth/authorize?${p.toString()}`, client: null });
    const id = new URL(start.headers.location!).searchParams.get('interaction_id')!;
    const signin = await auth.request<Json>({
      method: 'POST',
      path: '/v1/auth/signin',
      body: { interaction_id: id, email: other.email, password: PASSWORD },
      headers: { cookie: cookieOf(start.headers['set-cookie']), 'idempotency-key': uuidv7() },
    });
    expect(signin.body).toEqual({ next: 'complete' });
  });

  it('admin.staff_me answers every staff role with its own roles, and nobody else', async () => {
    for (const roles of [
      ['platform_admin'],
      ['platform_moderator'],
      ['platform_support'],
      ['platform_community_reviewer', 'platform_moderator'],
    ]) {
      const staff = await admin.fixtures.staff(...roles);
      const t = await admin.fixtures.token(staff, { staff: true });
      const me = await admin.request<Json>({ path: '/v1/admin/me', token: t, client: ADMIN });
      expect(me.status, me.text).toBe(200);
      expect([...(me.body.platform_roles as string[])].sort()).toEqual([...roles].sort());
      expect(me.body.display_name).toBe('Test User');
    }
    // Why admin.staff_me exists (admin console BR-04): the api host checks the api audience, so me.get and even the
    // PUB reads refuse a cp-web-admin token.
    const staff = await admin.fixtures.staff('platform_admin');
    const t = await admin.fixtures.token(staff, { staff: true });
    expect((await api.request({ path: '/v1/me', token: t, client: ADMIN })).status).toBe(401);
    expect((await api.request({ path: '/v1/config/client', token: t, client: ADMIN })).status).toBe(401);
  });

  it('staff:bootstrap creates what is missing, never touches what exists, and the account can enrol (OQ-10)', async () => {
    const crypto = new CryptoServices(testConfig().secrets.master);
    const tag = uuidv7().slice(-12);
    const specs = parseSpec(
      [
        { email: `b-adm-${tag}@test.carpal.app`, name: 'Boot Admin', roles: ['ADM'] },
        { email: `b-crv-${tag}@test.carpal.app`, name: 'Boot Reviewer', roles: ['CRV', 'MOD'], locale: 'en' },
      ],
      'dev',
    );
    const deps = { tx: auth.fixtures.worker, crypto, env: 'dev' as const };
    const first = await bootstrapStaff(deps, specs);
    expect(first.map((r) => [r.status, r.roles.join(','), r.password])).toEqual([
      ['created', 'ADM', DEV_STAFF_PASSWORD],
      ['created', 'CRV,MOD', DEV_STAFF_PASSWORD],
    ]);
    const second = await bootstrapStaff(deps, specs);
    expect(second.map((r) => [r.status, r.roles.join(','), r.password])).toEqual([
      ['exists', 'ADM', undefined],
      ['exists', 'CRV,MOD', undefined],
    ]);
    // Outside dev the password is generated and printed once.
    const prod = await bootstrapStaff(
      { ...deps, env: 'prod' },
      parseSpec([{ email: `b-p-${tag}@test.carpal.app`, name: 'Prod Admin', roles: ['ADM'] }], 'prod'),
    );
    expect(prod[0]!.password).toMatch(/^[A-Za-z0-9_-]{24}$/);

    const audit = await auth.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
      db
        .selectFrom('analytics.audit_logs')
        .select(['action'])
        .where('action', '=', 'staff.bootstrap_created')
        .where('new_state_summary', '=', 'CRV,MOD')
        .execute(),
    );
    expect(audit.length).toBeGreaterThanOrEqual(1);

    // The bootstrapped account signs in with the password and is taken to enrolment.
    const s = await adminSignin(auth);
    expect((await s.post('/v1/auth/signin', { email: specs[0]!.email, password: DEV_STAFF_PASSWORD })).body).toEqual({
      next: 'enrol_passkey',
    });
  });
});
