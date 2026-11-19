// S26c.T2 (NI-19): the web edge. Per-IP limits see the client behind nginx (X-Forwarded-For from a trusted proxy only)
// and behind a BFF (its signed CarPal-Forwarded-Client); a forged X-Forwarded-For from anywhere else is ignored;
// cross-site browser requests to the auth host's /v1/auth/* are refused (SEC-WEB-3); PoW difficulty per client.
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './test-app.js';

type Json = Record<string, unknown>;

// health.get is PUB: public.read applies. Two requests per minute per IP prefix make the windows easy to see.
const TWO_PER_IP = JSON.stringify({ 'public.read': [{ limit: 2, windowMs: 60_000, scope: 'ip' }] });

let key: CryptoKey;
let jwks: string;
let behindProxy: TestApp;
let direct: TestApp;
let auth: TestApp;

beforeAll(async () => {
  const pair = await generateKeyPair('ES256', { extractable: true });
  key = pair.privateKey;
  jwks = JSON.stringify({ 'cp-web-consumer': { keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'bff' }] } });
  const env = { CARPAL_RATE_LIMIT_SCALE: '1', CARPAL_RATE_LIMITS: TWO_PER_IP, CARPAL_OAUTH_CLIENT_JWKS: jwks };
  behindProxy = await createTestApp({ host: 'api', env: { ...env, CARPAL_TRUSTED_PROXIES: '["127.0.0.1","::1"]' } });
  direct = await createTestApp({ host: 'api', env });
  auth = await createTestApp({ host: 'auth', env: { CARPAL_POW_CLIENT_DIFFICULTY_BITS: '{"cp-web-consumer":10}' } });
}, 120_000);

afterAll(async () => {
  await behindProxy?.close();
  await direct?.close();
  await auth?.close();
});

const health = (app: TestApp, headers: Record<string, string> = {}) => app.request({ path: '/v1/health', headers, client: null });

/** A BFF's statement of its visitor's address for GET /v1/health on the API host. */
async function statement(cip: string, o: { htu?: string } = {}): Promise<string> {
  const api = behindProxy.config.http.audiences.api;
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ htm: 'GET', htu: o.htu ?? `${api}/v1/health`, cip })
    .setProtectedHeader({ alg: 'ES256', typ: 'carpal-fwd+jwt', kid: 'bff' })
    .setIssuer('cp-web-consumer')
    .setSubject('cp-web-consumer')
    .setAudience(api)
    .setIssuedAt(now)
    .setExpirationTime(now + 30)
    .sign(key);
}

describe('client addresses (NI-19 b)', () => {
  it('reads X-Forwarded-For from a trusted proxy: each client has its own per-IP window', async () => {
    const a = { 'x-forwarded-for': '203.0.113.7' };
    expect((await health(behindProxy, a)).status).toBe(200);
    expect((await health(behindProxy, a)).status).toBe(200);
    expect((await health(behindProxy, a)).status).toBe(429);
    // Another client behind the same nginx is not limited by the first one.
    expect((await health(behindProxy, { 'x-forwarded-for': '198.51.100.7' })).status).toBe(200);
    // A client that forges its own header: nginx appends the real address, which is the one that counts.
    expect((await health(behindProxy, { 'x-forwarded-for': '192.0.2.99, 203.0.113.7' })).status).toBe(429);
  });

  it('ignores a forged X-Forwarded-For from an address that is not a trusted proxy', async () => {
    expect((await health(direct, { 'x-forwarded-for': '203.0.113.8' })).status).toBe(200);
    expect((await health(direct, { 'x-forwarded-for': '203.0.114.8' })).status).toBe(200);
    const third = await health(direct, { 'x-forwarded-for': '203.0.115.8' });
    expect(third.status).toBe(429);
  });

  it("uses a BFF's signed visitor address, and ignores one that does not verify", async () => {
    // The socket's own window is spent by the test above; the visitor stated by the BFF has its own.
    expect((await health(direct, { 'carpal-forwarded-client': await statement('192.0.2.10') })).status).toBe(200);
    expect((await health(direct, { 'carpal-forwarded-client': await statement('192.0.2.10') })).status).toBe(200);
    expect((await health(direct, { 'carpal-forwarded-client': await statement('192.0.2.10') })).status).toBe(429);
    expect((await health(direct, { 'carpal-forwarded-client': await statement('192.0.3.10') })).status).toBe(200);
    // Bound to another URL: ignored, so the socket's spent window applies (the request is not refused for it).
    const wrong = await statement('192.0.4.10', { htu: `${direct.config.http.audiences.api}/v1/other` });
    expect((await health(direct, { 'carpal-forwarded-client': wrong })).status).toBe(429);
    expect((await health(direct, { 'carpal-forwarded-client': 'not-a-jws' })).status).toBe(429);
  });
});

describe('SEC-WEB-3 on the auth host (NI-19 a)', () => {
  const signin = (headers: Record<string, string>) =>
    auth.request<Json>({ method: 'POST', path: '/v1/auth/signin', body: { interaction_id: 'x', email: 'a@b.example' }, headers });

  it('refuses cross-site browser requests with CSRF_FAILED', async () => {
    for (const headers of <Record<string, string>[]>[
      { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site', origin: 'https://pwa.carpals.ir' },
      { origin: 'https://evil.example' },
    ]) {
      const res = await signin(headers);
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(res.body.code).toBe('CSRF_FAILED');
    }
  });

  it('lets same-origin requests from allowed origins and non-browser requests through to the operation', async () => {
    const issuer = new URL(auth.config.http.issuer).origin;
    for (const headers of <Record<string, string>[]>[
      { origin: issuer, 'sec-fetch-site': 'same-origin' },
      { origin: 'https://pwa.carpals.ir', 'sec-fetch-site': 'same-origin' },
      { origin: 'http://localhost:3000', 'sec-fetch-site': 'same-origin' },
      {},
    ]) {
      const res = await signin(headers);
      expect(res.body.code, JSON.stringify(headers)).not.toBe('CSRF_FAILED');
    }
    // Safe methods and the token endpoint are not browser state changes of /v1/auth/*.
    const discovery = await auth.request({ path: '/.well-known/openid-configuration', headers: { 'sec-fetch-site': 'cross-site' } });
    expect(discovery.status).toBe(200);
  });
});

describe('PoW difficulty per client (NI-19 d)', () => {
  it('uses the configured value for the named client and the base for the others', async () => {
    const web = await auth.request<Json>({
      method: 'POST',
      path: '/oauth/challenge',
      body: { purpose: 'signup' },
      client: 'cp-web-consumer/1.0.0 (web 1.0)',
    });
    const other = await auth.request<Json>({ method: 'POST', path: '/oauth/challenge', body: { purpose: 'signup' } });
    expect(web.body.difficulty_bits).toBe(10);
    expect(other.body.difficulty_bits).toBe(auth.config.auth.powDifficultyBits);
  });
});
