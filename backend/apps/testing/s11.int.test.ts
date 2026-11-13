// S11 (contract 1.2.0, pilot readiness): strict authentication of the BFF clients (DPoP-bound tokens + private_key_jwt),
// the profile and settings fields of PWA DI-55, deactivate and reactivate, and USD prices with the admin exchange rate.
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT, type JWK, type CryptoKey } from 'jose';
import { uuidv7 } from '#libs/crypto/index.js';
import { createInfra, type Infra } from '#libs/infra/index.js';
import { jpegWithExif, type TestUser } from '#libs/testing/index.js';
import { solvePow } from '#modules/identity/domain/credentials.js';
import { channelsFor, defaultPreference, quietUntil } from '#modules/notification/domain/preferences.js';
import { rateNeedsSecondApprover } from '#modules/admin/application/platform-ops.js';
import { idem, MediaHarness, taxonomyNodes, type Json } from './s4-support.js';
import { REASON, staff } from './s8-support.js';
import { createTestApp, testConfig, testLogger, type TestApp } from './test-app.js';

const WEB = 'cp-web-consumer/1.0.0 (web 1.0)';
const SSR = 'cp-ssr/1.0.0 (web 1.0)';
const ISSUER = 'https://id.carpals.ir';
const TOKEN_URL = `${ISSUER}/oauth/token`;
const API = 'https://api.carpals.ir';
const REDIRECT = 'https://pwa.carpals.ir/bff/oauth/callback';
const PASSWORD = 'correct horse battery staple';

const formOf = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
const cookieOf = (setCookie: string | undefined): string => (setCookie ?? '').split(';')[0]!;

async function dpopKey() {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  return { privateKey, jwk: await exportJWK(publicKey) };
}

function proof(
  key: { privateKey: CryptoKey; jwk: JWK },
  o: { url?: string; method?: string; nonce?: string; accessToken?: string } = {},
): Promise<string> {
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

describe('strict mode: BFF clients (GD-06 amendment 2026-11-04)', () => {
  let infra: Infra;
  let auth: TestApp;
  let api: TestApp;
  let consumerKey: CryptoKey;
  let ssrKey: CryptoKey;
  let nonce = '';

  const assertion = (
    client: string,
    key: CryptoKey,
    o: { aud?: string; iss?: string; sub?: string; expIn?: number; jti?: string } = {},
  ) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ jti: o.jti ?? uuidv7() })
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuer(o.iss ?? client)
      .setSubject(o.sub ?? client)
      .setAudience(o.aud ?? TOKEN_URL)
      .setIssuedAt(now)
      .setExpirationTime(now + (o.expIn ?? 60))
      .sign(key);
  };

  const token = (fields: Record<string, string>, client: string, headers: Record<string, string> = {}) =>
    auth.request<Json>({
      method: 'POST',
      path: '/oauth/token',
      body: formOf(fields),
      client,
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    });

  /** A token request answered with a fresh server nonce (the BFF retries the same way). */
  async function withNonce(fields: () => Promise<Record<string, string>>, client: string, key: { privateKey: CryptoKey; jwk: JWK }) {
    const first = await token(await fields(), client, { dpop: await proof(key, nonce ? { nonce } : {}) });
    if (first.body.error !== 'use_dpop_nonce') return first;
    nonce = first.headers['dpop-nonce']!;
    return token(await fields(), client, { dpop: await proof(key, { nonce }) });
  }

  const ssrFields = async (): Promise<Record<string, string>> => ({
    grant_type: 'client_credentials',
    client_id: 'cp-ssr',
    scope: 'public.read',
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: await assertion('cp-ssr', ssrKey),
  });

  beforeAll(async () => {
    const consumer = await generateKeyPair('ES256');
    const ssr = await generateKeyPair('ES256');
    consumerKey = consumer.privateKey;
    ssrKey = ssr.privateKey;
    const jwks = JSON.stringify({
      'cp-web-consumer': { keys: [await exportJWK(consumer.publicKey)] },
      'cp-ssr': { keys: [await exportJWK(ssr.publicKey)] },
    });
    const env = { CARPAL_STRICT_AUTH: '1', CARPAL_OAUTH_CLIENT_JWKS: jwks };
    const config = testConfig(env);
    infra = createInfra(config, { dataDir: null, logger: testLogger(config) });
    auth = await createTestApp({ host: 'auth', infra, env });
    api = await createTestApp({ host: 'api', infra, env });
  });
  afterAll(async () => {
    await api?.close();
    await auth?.close();
    await infra?.close();
  });

  it('refuses a confidential client without a valid assertion: 401 invalid_client', async () => {
    const base = { grant_type: 'client_credentials', client_id: 'cp-ssr', scope: 'public.read' };
    const type = { client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer' };
    const refused = async (fields: Record<string, string>) => {
      const res = await token(fields, SSR);
      expect(res.status, res.text).toBe(401);
      expect(res.body.error).toBe('invalid_client');
    };
    await refused(base);
    await refused({ ...base, ...type, client_assertion: 'not.a.jwt' });
    await refused({ ...base, ...type, client_assertion: await assertion('cp-ssr', ssrKey, { aud: 'https://elsewhere.example' }) });
    await refused({ ...base, ...type, client_assertion: await assertion('cp-ssr', ssrKey, { iss: 'cp-web-consumer' }) });
    await refused({ ...base, ...type, client_assertion: await assertion('cp-ssr', ssrKey, { sub: 'cp-web-consumer' }) });
    await refused({ ...base, ...type, client_assertion: await assertion('cp-ssr', ssrKey, { expIn: -120 }) });
    await refused({ ...base, ...type, client_assertion: await assertion('cp-ssr', ssrKey, { expIn: 3600 }) });
    // Signed with the other client's key.
    await refused({ ...base, ...type, client_assertion: await assertion('cp-ssr', consumerKey) });
    // A client with no registered key (its BFF does not exist yet, NI-08).
    const portal = await token(
      {
        grant_type: 'refresh_token',
        client_id: 'cp-web-portal',
        refresh_token: 'cprt_x',
        ...type,
        client_assertion: await assertion('cp-web-portal', ssrKey),
      },
      'cp-web-portal/1.0.0 (web 1.0)',
    );
    expect(portal.status).toBe(401);
    expect(portal.body.error).toBe('invalid_client');
  });

  it('refuses a replayed assertion and accepts the issuer as audience', async () => {
    const key = await dpopKey();
    const jti = uuidv7();
    const fields = async () => ({ ...(await ssrFields()), client_assertion: await assertion('cp-ssr', ssrKey, { jti, aud: ISSUER }) });
    const first = await token(await fields(), SSR, { dpop: await proof(key, nonce ? { nonce } : {}) });
    expect(first.body.error === undefined || first.body.error === 'use_dpop_nonce', first.text).toBe(true);
    const replay = await token(await fields(), SSR, { dpop: await proof(key) });
    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe('invalid_client');
  });

  it('cp-ssr: a DPoP proof with the server nonce binds the token, and the API needs the proof', async () => {
    const key = await dpopKey();
    const noProof = await token(await ssrFields(), SSR);
    expect(noProof.status).toBe(400);
    expect(noProof.body.error).toBe('invalid_dpop_proof');

    const res = await withNonce(ssrFields, SSR, key);
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ token_type: 'DPoP', scope: 'public.read' });
    const claims = JSON.parse(Buffer.from(res.body.access_token.split('.')[1], 'base64url').toString()) as Json;
    expect(claims.cnf.jkt).toBe(await calculateJwkThumbprint(key.jwk, 'sha256'));

    const accessToken = res.body.access_token as string;
    const unbound = await api.request({ path: '/v1/plans', token: accessToken, client: SSR });
    expect(unbound.status).toBe(401);
    const signed = await api.request({
      path: '/v1/plans',
      token: accessToken,
      client: SSR,
      headers: { dpop: await proof(key, { method: 'GET', url: `${API}/v1/plans`, accessToken }) },
    });
    expect(signed.status, signed.text).toBe(200);
  });

  it('cp-web-consumer: code flow, a nonce retry keeps the code, refresh keeps the key, signed-in calls work', async () => {
    const user = await auth.fixtures.user();
    await auth.fixtures.withPassword(user, PASSWORD);
    const verifier = randomBytes(32).toString('base64url');
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: 'cp-web-consumer',
      redirect_uri: REDIRECT,
      scope: 'openid offline_access',
      state: randomBytes(16).toString('base64url'),
      nonce: randomBytes(16).toString('base64url'),
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    });
    const start = await auth.request({ path: `/oauth/authorize?${q.toString()}`, client: null });
    expect(start.status, start.text).toBe(302);
    const interaction = new URL(start.headers.location!).searchParams.get('interaction_id')!;
    const cookie = cookieOf(start.headers['set-cookie']);
    const challenge = await auth.request<Json>({ method: 'POST', path: '/oauth/challenge', body: { purpose: 'signin' } });
    const pow = `${challenge.body.challenge_id}.${solvePow(challenge.body.prefix, challenge.body.difficulty_bits)}`;
    const signin = await auth.request<Json>({
      method: 'POST',
      path: '/v1/auth/signin',
      body: { interaction_id: interaction, email: user.email, password: PASSWORD },
      headers: { cookie, 'idempotency-key': uuidv7(), 'carpal-pow': pow },
    });
    expect(signin.body, signin.text).toEqual({ next: 'complete' });
    const back = await auth.request({ path: `/oauth/authorize?${q.toString()}`, client: null, headers: { cookie } });
    const code = new URL(back.headers.location!).searchParams.get('code')!;

    const key = await dpopKey();
    const assertionType = { client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer' };
    const codeFields = async () => ({
      grant_type: 'authorization_code',
      client_id: 'cp-web-consumer',
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      ...assertionType,
      client_assertion: await assertion('cp-web-consumer', consumerKey),
    });
    // A stale nonce: the answer is use_dpop_nonce, and the code is still good for the retry.
    const stale = await token(await codeFields(), WEB, { dpop: await proof(key, { nonce: 'stale' }) });
    expect(stale.body.error).toBe('use_dpop_nonce');
    nonce = stale.headers['dpop-nonce']!;
    const res = await token(await codeFields(), WEB, { dpop: await proof(key, { nonce }) });
    expect(res.status, res.text).toBe(200);
    expect(res.body.token_type).toBe('DPoP');

    const accessToken = res.body.access_token as string;
    const me = await api.request<Json>({
      path: '/v1/me',
      token: accessToken,
      client: WEB,
      headers: { dpop: await proof(key, { method: 'GET', url: `${API}/v1/me`, accessToken }) },
    });
    expect(me.status, me.text).toBe(200);
    expect(me.body.email).toBe(user.email);
    expect((await api.request({ path: '/v1/me', token: accessToken, client: WEB })).status).toBe(401);

    const refreshFields = async (refresh: string) => ({
      grant_type: 'refresh_token',
      client_id: 'cp-web-consumer',
      refresh_token: refresh,
      ...assertionType,
      client_assertion: await assertion('cp-web-consumer', consumerKey),
    });
    const rotated = await withNonce(() => refreshFields(res.body.refresh_token as string), WEB, key);
    expect(rotated.status, rotated.text).toBe(200);
    expect(rotated.body.token_type).toBe('DPoP');
    const other = await dpopKey();
    const wrongKey = await withNonce(() => refreshFields(rotated.body.refresh_token as string), WEB, other);
    expect(wrongKey.status).toBe(400);
    expect(wrongKey.body.error).toBe('invalid_grant');
  });

  it('the anonymous grant of cp-web-consumer also needs its assertion', async () => {
    const res = await token({ grant_type: 'urn:carpal:params:oauth:grant-type:anonymous', client_id: 'cp-web-consumer' }, WEB);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_client');
  });
});

describe('contract 1.2.0 (lite)', () => {
  let infra: Infra;
  let auth: TestApp;
  let api: TestApp;
  let admin: TestApp;

  beforeAll(async () => {
    const config = testConfig();
    infra = createInfra(config, { dataDir: null, logger: testLogger(config) });
    auth = await createTestApp({ host: 'auth', infra });
    api = await createTestApp({ host: 'api', infra });
    admin = await createTestApp({ host: 'admin-api', infra });
  });
  afterAll(async () => {
    await admin?.close();
    await api?.close();
    await auth?.close();
    await infra?.close();
  });

  const fresh = () => ({ acr: 'aal2' as const, authTime: Math.floor(Date.now() / 1000) });
  const client = (t: string) => ({
    get: (path: string) => api.request<Json>({ path, token: t }),
    post: (path: string, body?: unknown) =>
      api.request<Json>({ method: 'POST', path, token: t, headers: idem(), ...(body !== undefined ? { body } : {}) }),
    patch: (path: string, body: unknown, version: number) =>
      api.request<Json>({ method: 'PATCH', path, token: t, body, headers: { 'if-match': `"v${version}"` } }),
    put: (path: string, body: unknown) => api.request<Json>({ method: 'PUT', path, token: t, body, headers: idem() }),
  });

  async function interaction() {
    const verifier = randomBytes(32).toString('base64url');
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: 'cp-mobile',
      redirect_uri: 'https://carpals.ir/oauth/callback',
      scope: 'openid offline_access',
      state: randomBytes(16).toString('base64url'),
      nonce: randomBytes(16).toString('base64url'),
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    });
    const res = await auth.request({ path: `/oauth/authorize?${q.toString()}`, client: null });
    return { id: new URL(res.headers.location!).searchParams.get('interaction_id')!, cookie: cookieOf(res.headers['set-cookie']) };
  }

  const authPost = (path: string, cookie: string, body: Json) =>
    auth.request<Json>({ method: 'POST', path, body, headers: { cookie, 'idempotency-key': uuidv7() } });

  const passwordUser = async (): Promise<TestUser> => {
    const u = await api.fixtures.user();
    await api.fixtures.withPassword(u, PASSWORD);
    return u;
  };

  describe('deactivate and reactivate', () => {
    it('ends every session, then a correct sign-in offers reactivation and a wrong one stays generic', async () => {
      const u = await passwordUser();
      const t = await api.fixtures.token(u, fresh());
      const c = client(t);
      const done = await c.post('/v1/me/deactivate', { reason: 'Taking a break' });
      expect(done.status, done.text).toBe(200);
      expect((await c.get('/v1/me')).status).toBe(401);

      const wrong = await interaction();
      const denied = await authPost('/v1/auth/signin', wrong.cookie, {
        interaction_id: wrong.id,
        email: u.email,
        password: 'not the password at all',
      });
      expect(denied.status).toBe(401);
      expect(denied.body.code).toBe('INVALID_CREDENTIALS');

      const ia = await interaction();
      const offered = await authPost('/v1/auth/signin', ia.cookie, { interaction_id: ia.id, email: u.email, password: PASSWORD });
      expect(offered.body, offered.text).toEqual({ next: 'reactivate' });
      const back = await authPost('/v1/auth/reactivate', ia.cookie, { interaction_id: ia.id });
      expect(back.status, back.text).toBe(200);
      expect(back.body).toEqual({ next: 'complete' });
      const again = await authPost('/v1/auth/reactivate', ia.cookie, { interaction_id: ia.id });
      expect(again.status).toBe(401);
      const me = await client(await api.fixtures.token(u)).get('/v1/me');
      expect(me.body.status).toBe('active');
    });

    it('reactivates through a one-time code as well', async () => {
      const u = await passwordUser();
      await client(await api.fixtures.token(u, fresh())).post('/v1/me/deactivate', {});
      const ia = await interaction();
      const started = await authPost('/v1/auth/otp/start', ia.cookie, {
        interaction_id: ia.id,
        channel: 'email',
        destination: u.email,
        purpose: 'signin',
      });
      expect(started.status, started.text).toBe(202);
      const code = auth.mail(u.email, 'identity.otp_code').at(-1)!.variables.code!;
      const offered = await authPost('/v1/auth/otp/verify', ia.cookie, { interaction_id: ia.id, code });
      expect(offered.body, offered.text).toEqual({ next: 'reactivate' });
    });

    it('a staff decision keeps the generic sign-in answer, even over a self-deactivation', async () => {
      const a = await staff(admin, 'platform_admin');
      const u = await passwordUser();
      await client(await api.fixtures.token(u, fresh())).post('/v1/me/deactivate', {});
      const res = await a.c.post(`/v1/admin/users/${u.id}/status`, { status: 'deactivated', reason: REASON });
      expect(res.status, res.text).toBeLessThan(300);
      const ia = await interaction();
      const denied = await authPost('/v1/auth/signin', ia.cookie, { interaction_id: ia.id, email: u.email, password: PASSWORD });
      expect(denied.status).toBe(401);
      expect(denied.body.code).toBe('INVALID_CREDENTIALS');
      expect((await authPost('/v1/auth/reactivate', ia.cookie, { interaction_id: ia.id })).status).toBe(401);
    });

    it('needs a recent strong sign-in', async () => {
      const u = await passwordUser();
      const stale = await client(await api.fixtures.token(u, { authTime: Math.floor(Date.now() / 1000) - 3600 })).post(
        '/v1/me/deactivate',
        {},
      );
      expect(stale.status).toBe(401);
      expect((stale.body as Json).code).toBe('STEP_UP_REQUIRED');
    });
  });

  describe('profile and preferences', () => {
    it("saves country, refuses another user's photo, and clears the photo with null", async () => {
      const u = await api.fixtures.user();
      const c = client(await api.fixtures.token(u));
      const me = await c.get('/v1/me');
      expect(me.body).toMatchObject({ country: null, avatar_url: null });
      const saved = await c.patch('/v1/me', { country: 'IR' }, me.body.version);
      expect(saved.status, saved.text).toBe(200);
      expect(saved.body.country).toBe('IR');
      const foreign = await c.patch('/v1/me', { avatar_media_id: uuidv7() }, saved.body.version);
      expect(foreign.status).toBe(422);
      const cleared = await c.patch('/v1/me', { avatar_media_id: null }, saved.body.version);
      expect(cleared.status, cleared.text).toBe(200);
      expect(cleared.body.avatar_url).toBeNull();
    });

    it('shows a clean photo of the owner; another purpose is refused; the photo leaves the account with null', async () => {
      const media = await MediaHarness.start(api);
      try {
        const u = await api.fixtures.user();
        const token = await api.fixtures.token(u);
        const c = client(token);
        const owner = { type: 'user' as const, id: u.id };
        const bytes = await jpegWithExif();
        const asset = await media.upload(token, { owner, purpose: 'avatar', mime: 'image/jpeg', bytes });
        const other = await media.upload(token, { owner, purpose: 'vehicle_photo', mime: 'image/jpeg', bytes });
        const me = await c.get('/v1/me');
        expect((await c.patch('/v1/me', { avatar_media_id: other.id }, me.body.version)).status).toBe(422);
        const set = await c.patch('/v1/me', { avatar_media_id: asset.id }, me.body.version);
        expect(set.status, set.text).toBe(200);
        expect(set.body.avatar_url).toMatch(/^https?:/);
        expect((await c.get('/v1/me')).body.avatar_url).toMatch(/^https?:/);
        const cleared = await c.patch('/v1/me', { avatar_media_id: null }, set.body.version);
        expect(cleared.body.avatar_url).toBeNull();
      } finally {
        await media.close();
      }
    });

    it('stores the per-feature switches and quiet hours; the personalised ones and email invitations need consent', async () => {
      const u = await api.fixtures.user();
      const c = client(await api.fixtures.token(u, fresh()));
      const p = await c.get('/v1/me/preferences');
      expect(p.body).toMatchObject({
        ai_help_me_personalised: false,
        ai_personalised_matching: false,
        ai_writing_help: true,
        ai_show_reasons: true,
        review_invitation_channel: 'in_app',
        quiet_hours: null,
      });
      expect((await c.patch('/v1/me/preferences', { ai_help_me_personalised: true }, p.body.version)).status).toBe(403);
      expect((await c.patch('/v1/me/preferences', { ai_personalised_matching: true }, p.body.version)).status).toBe(403);
      expect((await c.patch('/v1/me/preferences', { review_invitation_channel: 'email' }, p.body.version)).status).toBe(403);
      expect((await c.patch('/v1/me/preferences', { quiet_hours: { start: '25:00', end: '07:00' } }, p.body.version)).status).toBe(422);
      expect((await c.patch('/v1/me/preferences', { quiet_hours: { start: '07:00', end: '07:00' } }, p.body.version)).status).toBe(422);
      const saved = await c.patch(
        '/v1/me/preferences',
        { ai_show_reasons: false, ai_writing_help: false, quiet_hours: { start: '22:00', end: '07:00' }, preferred_currency: 'IRR' },
        p.body.version,
      );
      expect(saved.status, saved.text).toBe(200);
      expect(saved.body).toMatchObject({
        ai_show_reasons: false,
        ai_writing_help: false,
        quiet_hours: { start: '22:00', end: '07:00' },
        preferred_currency: 'IRR',
      });
      const off = await c.patch('/v1/me/preferences', { quiet_hours: null, preferred_currency: 'USD' }, saved.body.version);
      expect(off.body.quiet_hours).toBeNull();
      expect((await c.patch('/v1/me/preferences', { preferred_currency: 'EUR' }, off.body.version)).status).toBe(422);
    });

    it('withdrawing a consent turns off what depends on it', async () => {
      const u = await api.fixtures.user();
      const c = client(await api.fixtures.token(u, fresh()));
      const ai = await c.post('/v1/me/consents', {
        consent_type: 'ai_personalization',
        policy_version: '1.0',
        granted_to: { type: 'platform' },
      });
      expect(ai.status, ai.text).toBe(201);
      const invites = await c.post('/v1/me/consents', { consent_type: 'review_invitations', policy_version: '1.0' });
      expect(invites.status, invites.text).toBe(201);
      const p = await c.get('/v1/me/preferences');
      const on = await c.patch('/v1/me/preferences', { ai_help_me_personalised: true, review_invitation_channel: 'email' }, p.body.version);
      expect(on.status, on.text).toBe(200);
      await c.post(`/v1/me/consents/${ai.body.id}/withdraw`);
      await c.post(`/v1/me/consents/${invites.body.id}/withdraw`);
      expect((await c.get('/v1/me/preferences')).body).toMatchObject({
        ai_help_me_personalised: false,
        review_invitation_channel: 'in_app',
      });
    });

    it('names the business of an active share', async () => {
      const org = await api.fixtures.org('provider', { status: 'active' });
      const u = await api.fixtures.user();
      const c = client(await api.fixtures.token(u, fresh()));
      const share = await c.post('/v1/me/consents', {
        consent_type: 'ai_personalization',
        policy_version: '1.0',
        granted_to: { type: 'organization', id: org.id },
      });
      expect(share.status, share.text).toBe(201);
      expect(share.body.granted_to_organization).toMatchObject({ id: org.id });
      const list = await c.get('/v1/me/consents?limit=10');
      expect(list.body.items[0].granted_to_organization).toMatchObject({ id: org.id });
    });

    it('allows SMS only for the categories that may use it', async () => {
      const c = client(await api.fixtures.token(await api.fixtures.user()));
      const sms = (category: string) => ({ channel: 'sms', category, enabled: true, frequency: 'immediate' });
      expect((await c.put('/v1/me/notification-preferences', { items: [sms('marketing')] })).status).toBe(422);
      expect((await c.put('/v1/me/notification-preferences', { items: [sms('community')] })).status).toBe(422);
      const ok = await c.put('/v1/me/notification-preferences', { items: [sms('appointments')] });
      expect(ok.status, ok.text).toBe(200);
      expect(ok.body.items.find((i: Json) => i.channel === 'sms' && i.category === 'appointments').enabled).toBe(true);
    });
  });

  describe('quiet hours and channels', () => {
    const at = (iso: string) => new Date(iso);
    const quiet = { start: '22:00', end: '07:00' };

    it("holds until the window ends on the user's clock, across midnight", () => {
      expect(quietUntil(at('2026-11-05T23:00:00Z'), 'UTC', quiet)).toEqual(at('2026-11-06T07:00:00Z'));
      expect(quietUntil(at('2026-11-05T03:00:00Z'), 'UTC', quiet)).toEqual(at('2026-11-05T07:00:00Z'));
      expect(quietUntil(at('2026-11-05T12:00:00Z'), 'UTC', quiet)).toBeNull();
      expect(quietUntil(at('2026-11-05T12:00:00Z'), 'UTC', null)).toBeNull();
      // 20:00 UTC is 23:30 in Tehran.
      expect(quietUntil(at('2026-11-05T20:00:00Z'), 'Asia/Tehran', quiet)).toEqual(at('2026-11-06T03:30:00Z'));
      expect(quietUntil(at('2026-11-05T10:30:00Z'), 'UTC', { start: '09:00', end: '12:00' })).toEqual(at('2026-11-05T12:00:00Z'));
    });

    it('sends SMS only for allowed categories, and never for critical ones', () => {
      const enabled = (category: 'appointments' | 'marketing') => [{ ...defaultPreference('sms', category), enabled: true }];
      const decide = (category: 'appointments' | 'marketing', priority: 'normal' | 'critical' = 'normal') =>
        channelsFor({ category, priority, preferences: enabled(category), criticalAlertsOnly: false, allowed: ['sms'] });
      expect(decide('appointments')).toEqual([{ channel: 'sms', outcome: 'send' }]);
      expect(decide('marketing')).toEqual([{ channel: 'sms', outcome: 'suppressed' }]);
      expect(decide('appointments', 'critical')).toEqual([]);
    });
  });

  describe('USD and the exchange rate (GD-41)', () => {
    it('config.client serves the base currency, the display currencies and the rate', async () => {
      const res = await api.request<Json>({ path: '/v1/config/client', token: await api.fixtures.anonymousToken() });
      expect(res.status, res.text).toBe(200);
      expect(res.body.contract_version).toBe('1.4.0'); // the server's current version (contract 1.4.0 since S13)
      expect(res.body.region).toMatchObject({ currency: 'USD', display_currencies: ['IRR', 'USD'] });
      const irr = res.body.region.exchange_rates.find((r: Json) => r.currency === 'IRR');
      expect(Number(irr.per_usd)).toBeGreaterThan(0);
    });

    it('asks a second admin for a change over 20 %', () => {
      expect(rateNeedsSecondApprover('1000000.0000', '1100000')).toBe(false);
      expect(rateNeedsSecondApprover('1000000.0000', '1200000')).toBe(false);
      expect(rateNeedsSecondApprover('1000000.0000', '1200001')).toBe(true);
      expect(rateNeedsSecondApprover('1000000.0000', '700000')).toBe(true);
    });

    it('an audited admin change reaches config.client; a large one waits for approval', async () => {
      const a = await staff(admin, 'platform_admin');
      const b = await staff(admin, 'platform_admin');
      const list = await a.c.get('/v1/admin/exchange-rates');
      expect(list.status, list.text).toBe(200);
      const rate = list.body.items.find((r: Json) => r.currency === 'IRR');
      const current = Number(rate.per_usd);
      const put = (client: typeof a, body: Json, version: number) =>
        client.c.put('/v1/admin/exchange-rates/IRR', body, { 'if-match': `"v${version}"` });

      expect((await put(a, { per_usd: '0', reason: REASON }, rate.version)).status).toBe(422);
      expect((await put(a, { per_usd: String(current), reason: REASON }, 999)).status).toBe(412);
      expect((await a.c.put('/v1/admin/exchange-rates/IRR', { per_usd: '1', reason: REASON })).status).toBe(428);

      const small = (current * 1.05).toFixed(4);
      const done = await put(a, { per_usd: small, reason: REASON }, rate.version);
      expect(done.status, done.text).toBe(200);
      expect(Number(done.body.per_usd)).toBe(Number(small));
      const config = await api.request<Json>({ path: '/v1/config/client', token: await api.fixtures.anonymousToken() });
      expect(Number(config.body.region.exchange_rates.find((r: Json) => r.currency === 'IRR').per_usd)).toBe(Number(small));

      const large = (Number(small) * 2).toFixed(4);
      const pending = await put(a, { per_usd: large, reason: REASON }, done.body.version);
      expect(pending.status, pending.text).toBe(202);
      expect(pending.body).toMatchObject({ op_id: 'admin.exchange_rate_update', status: 'pending' });
      const approved = await b.c.post(`/v1/admin/four-eyes/${pending.body.change_id}/decision`, { decision: 'approve', reason: REASON });
      expect(approved.status, approved.text).toBe(200);
      const after = (await a.c.get('/v1/admin/exchange-rates')).body.items.find((r: Json) => r.currency === 'IRR');
      expect(Number(after.per_usd)).toBe(Number(large));
      // Back to the rate this test found, for the other tests of the shared database.
      const restore = await put(a, { per_usd: String(current), reason: REASON }, after.version);
      expect(restore.status).toBe(202);
      await b.c.post(`/v1/admin/four-eyes/${restore.body.change_id}/decision`, { decision: 'approve', reason: REASON });
    });

    it('needs staff', async () => {
      const u = await api.fixtures.user();
      const res = await admin.request({ path: '/v1/admin/exchange-rates', token: await api.fixtures.token(u) });
      expect(res.status).toBeGreaterThanOrEqual(401);
    });

    it('refuses a price or cost in another currency', async () => {
      const u = await api.fixtures.user();
      const c = client(await api.fixtures.token(u));
      const nodes = await taxonomyNodes(api);
      // The currency is checked before anything else of the record.
      const res = await c.post(`/v1/me/vehicles/${uuidv7()}/service-records`, {
        service_date: '2026-10-01',
        service_system_node_id: nodes.system,
        source_type: 'user_manual',
        visibility: 'private',
        cost: { amount: '100.00', currency: 'IRR' },
      });
      expect(res.status).toBe(422);
      expect(JSON.stringify(res.body)).toContain('/cost/currency');
    });
  });
});
