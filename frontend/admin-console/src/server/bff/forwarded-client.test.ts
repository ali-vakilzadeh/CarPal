// AC14b.T7 unit tests of CarPal-Forwarded-Client (Docs/40 1.5.0 §1.3, backend S26c.T2): the statement verifies with
// the options the backend uses (backend libs/http-pipeline/client-address.ts ForwardedClientVerifier: EdDSA or ES256,
// typ carpal-fwd+jwt, iss = sub = the client, aud the host, htm/htu of the call, cip, at most 60 s); the forwarder
// sends it to admin-api (aud = the admin API audience) and the /id proxy to the auth host (aud = the issuer); the
// browser's own X-Forwarded-For never reaches the backend; no address or a failing signer leaves the header out and the
// call goes on.
import { exportJWK, generateKeyPair, jwtVerify, type JWK } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  FORWARDED_CLIENT_HEADER,
  forwardedClientHeader,
  forwardedClientSigner,
  normalizeIp,
  visitorIp,
  type ForwardedClientSigner,
} from './forwarded-client';
import { AUDIENCE, ISSUER, testBff } from './test-support';

let publicKey: CryptoKey;
let signer: ForwardedClientSigner;

beforeAll(async () => {
  const pair = await generateKeyPair('ES256', { extractable: true });
  publicKey = pair.publicKey;
  const jwk = { ...(await exportJWK(pair.privateKey)), kid: 'cp-web-admin-1' } as JWK & { kid: string };
  signer = forwardedClientSigner(jwk, 'ES256', 'cp-web-admin');
});

/** The backend's check (client-address.ts), for one host and call. */
async function verify(token: string, audience: string, method: string, htu: string) {
  const { payload, protectedHeader } = await jwtVerify(token, publicKey, {
    algorithms: ['EdDSA', 'ES256'],
    typ: 'carpal-fwd+jwt',
    issuer: 'cp-web-admin',
    subject: 'cp-web-admin',
    audience,
    requiredClaims: ['iss', 'sub', 'aud', 'iat', 'exp', 'htm', 'htu', 'cip'],
  });
  expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(60);
  expect(payload.htm).toBe(method);
  expect(payload.htu).toBe(htu);
  expect(protectedHeader.kid).toBe('cp-web-admin-1');
  return payload.cip;
}

const req = (xff?: string) => new Request('http://localhost:3200/x', { headers: xff ? { 'x-forwarded-for': xff } : {} });

describe('visitor address', () => {
  it('is the last X-Forwarded-For hop (the one nginx appended), in canonical form', () => {
    expect(visitorIp(req('198.51.100.7'))).toBe('198.51.100.7');
    expect(visitorIp(req('6.6.6.6, 203.0.113.9'))).toBe('203.0.113.9');
    expect(visitorIp(req('203.0.113.9, ::ffff:192.0.2.1'))).toBe('192.0.2.1');
    expect(visitorIp(req('2001:DB8::1'))).toBe('2001:db8::1');
    expect(visitorIp(req('1.2.3.4, not-an-ip'))).toBeNull();
    expect(visitorIp(req())).toBeNull();
    expect(normalizeIp('[2001:db8::2]')).toBe('2001:db8::2');
    expect(normalizeIp('1.2.3.4:5678')).toBeNull();
  });
});

describe('the statement', () => {
  it('verifies as the backend checks it', async () => {
    const token = await signer({ audience: AUDIENCE, method: 'GET', htu: `${AUDIENCE}/v1/admin/flags`, ip: '203.0.113.9' });
    expect(await verify(token, AUDIENCE, 'GET', `${AUDIENCE}/v1/admin/flags`)).toBe('203.0.113.9');
  });

  it('is left out without a signer or an address, or when signing fails', async () => {
    const check = { audience: AUDIENCE, method: 'GET', htu: `${AUDIENCE}/v1/admin/flags` };
    expect(await forwardedClientHeader(undefined, req('203.0.113.9'), check)).toBeNull();
    expect(await forwardedClientHeader(signer, req(), check)).toBeNull();
    const broken: ForwardedClientSigner = async () => {
      throw new Error('bad key');
    };
    expect(await forwardedClientHeader(broken, req('203.0.113.9'), check)).toBeNull();
  });
});

describe('sent by the BFF (AC14b.T7)', () => {
  it('admin-api: aud the admin API audience, htu without the query; the browser X-Forwarded-For is not passed on', async () => {
    const t = await testBff({}, { forwardedClient: signer });
    t.backend.api.handler = (r) => (r.url.startsWith('http://admin.test/v1/admin/flags') ? Response.json({ items: [] }) : undefined);
    expect((await t.browser.signIn(t.backend)).status).toBe(303);
    const res = await t.browser.fetch('/api/v1/admin/flags?limit=5', { headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' } });
    expect(res.status).toBe(200);
    const sent = t.backend.calls.filter((c) => c.url.startsWith('http://admin.test/v1/admin/flags')).at(-1)!;
    expect(sent.headers.get('x-forwarded-for')).toBeNull();
    const cip = await verify(sent.headers.get(FORWARDED_CLIENT_HEADER)!, AUDIENCE, 'GET', `${AUDIENCE}/v1/admin/flags`);
    expect(cip).toBe('203.0.113.9');
  });

  it("auth host through /id: aud and htu are the issuer's; Origin and Sec-Fetch-Site still go along", async () => {
    const t = await testBff({}, { forwardedClient: signer });
    const res = await t.browser.fetch('/id/v1/auth/signin', {
      method: 'POST',
      body: '{"interaction_id":"x"}',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.7' },
    });
    expect(res.status).toBe(200);
    const sent = t.backend.calls.find((c) => c.url === 'http://auth.test/v1/auth/signin')!;
    expect(await verify(sent.headers.get(FORWARDED_CLIENT_HEADER)!, ISSUER, 'POST', `${ISSUER}/v1/auth/signin`)).toBe('198.51.100.7');
    expect(sent.headers.get('origin')).toBe('http://localhost:3200');
    expect(sent.headers.get('sec-fetch-site')).toBe('same-origin');
    expect(sent.headers.get('x-forwarded-for')).toBeNull();
  });

  it('without a key (lite dev) nothing is added and the calls work as before', async () => {
    const t = await testBff();
    const res = await t.browser.fetch('/id/v1/auth/signin', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.7' },
    });
    expect(res.status).toBe(200);
    expect(t.backend.calls.find((c) => c.url === 'http://auth.test/v1/auth/signin')!.headers.get(FORWARDED_CLIENT_HEADER)).toBeNull();
  });
});
