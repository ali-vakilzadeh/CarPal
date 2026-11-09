// AC3.T7: the token client in strict mode — private_key_jwt with the cp-web-admin key, the DPoP nonce retry, and the
// error mapping the forwarder relies on.
import { decodeJwt, decodeProtectedHeader, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { fakeBackend, ISSUER, oauthError, problemResponse } from '../test-support';
import { generateDpopKey } from './dpop';
import { errorOf, noClientAuthentication, privateKeyJwt, TokenClient } from './token-client';

const header = (id: string) => `${id}/0.1.0 (web 1.0)`;

describe('token client', () => {
  it('signs a 60-second private_key_jwt for the token endpoint with the cp-web-admin key (ES256, kid)', async () => {
    const backend = await fakeBackend();
    const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
    const key = { ...(await exportJWK(privateKey)), kid: 'admin-1' };
    const tc = new TokenClient({ authUrl: 'http://auth.test', clientHeader: header, fetch: backend.fetch, clientAuth: privateKeyJwt(key) });
    await expect(tc.refresh('cp-web-admin', 'cprt_unknown')).rejects.toMatchObject({ invalidGrant: true });
    const call = backend.calls.find((c) => c.url.endsWith('/oauth/token'))!;
    const form = new URLSearchParams(call.body);
    expect(form.get('client_id')).toBe('cp-web-admin');
    expect(form.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    const assertion = form.get('client_assertion')!;
    expect(decodeProtectedHeader(assertion)).toMatchObject({ alg: 'ES256', kid: 'admin-1' });
    const { payload } = await jwtVerify(assertion, publicKey, {
      issuer: 'cp-web-admin',
      subject: 'cp-web-admin',
      audience: `${ISSUER}/oauth/token`,
    });
    expect(payload.exp! - payload.iat!).toBe(60);
    expect(call.headers.get('carpal-client')).toBe('cp-web-admin/0.1.0 (web 1.0)');
    expect(noClientAuthentication.method).toBe('none');
  });

  it('retries once with the server nonce after use_dpop_nonce, with a proof for the public token endpoint', async () => {
    const backend = await fakeBackend();
    const tc = new TokenClient({ authUrl: 'http://auth.test', clientHeader: header, fetch: backend.fetch });
    let first = true;
    backend.token.handler = () => {
      if (!first) return undefined;
      first = false;
      return oauthError(400, 'use_dpop_nonce', { 'dpop-nonce': 'server-nonce-1' });
    };
    const login = backend.issueCode({ nonce: 'n' });
    await tc.authorizationCode('cp-web-admin', { code: login, redirectUri: 'x', verifier: 'v', dpopKey: await generateDpopKey() });
    const proofs = backend.calls.filter((c) => c.url.endsWith('/oauth/token')).map((c) => decodeJwt(c.headers.get('dpop')!));
    expect(proofs).toHaveLength(2);
    expect(proofs[0]!.nonce).toBeUndefined();
    expect(proofs[1]).toMatchObject({ nonce: 'server-nonce-1', htu: `${ISSUER}/oauth/token`, htm: 'POST' });
  });

  it('maps RFC 6749 JSON, problem+json and other bodies; an unreachable host is a network error', async () => {
    const a = await errorOf(oauthError(400, 'invalid_grant'));
    expect([a.kind, a.error, a.invalidGrant]).toEqual(['oauth', 'invalid_grant', true]);
    const b = await errorOf(problemResponse(429, 'RATE_LIMITED', { 'carpal-retry-after-ms': '2500', 'carpal-request-id': 'r9' }));
    expect([b.kind, b.error, b.retryAfterMs, b.requestId, b.invalidGrant]).toEqual(['problem', 'RATE_LIMITED', 2500, 'r9', false]);
    const c = await errorOf(new Response('oops', { status: 502 }));
    expect([c.kind, c.error]).toEqual(['network', 'http_502']);
    const tc = new TokenClient({
      authUrl: 'http://nowhere.test',
      clientHeader: header,
      fetch: (async () => {
        throw new TypeError('ECONNREFUSED');
      }) as typeof fetch,
    });
    await expect(tc.refresh('cp-web-admin', 'x')).rejects.toMatchObject({ kind: 'network', status: 502 });
  });
});
