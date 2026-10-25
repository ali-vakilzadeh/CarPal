import { SignJWT, decodeJwt, decodeProtectedHeader, exportJWK, generateKeyPair, type JWK } from 'jose';
import { describe, expect, it } from 'vitest';
import { sha256Base64url } from '../crypto';
import { fakeBackend, ISSUER, oauthError, problemResponse } from '../test-support';
import { dpopProof, generateDpopKey, jwkThumbprint } from './dpop';
import { leadingZeroBits, solvePow } from './pow';
import { errorOf, noClientAuthentication, privateKeyJwt, TokenClient, TokenEndpointError } from './token-client';

const header = (id: string) => `${id}/0.1.0 (web 1.0)`;

async function client(o: Pick<ConstructorParameters<typeof TokenClient>[0], 'powUpFront' | 'clientAuth'> = {}) {
  const backend = await fakeBackend();
  return { backend, tc: new TokenClient({ authUrl: 'http://auth.test', clientHeader: header, fetch: backend.fetch, ...o }) };
}

describe('error mapping (BA-12)', () => {
  it('reads RFC 6749 JSON, problem+json and other bodies', async () => {
    const a = await errorOf(oauthError(400, 'invalid_grant'));
    expect([a.kind, a.error, a.invalidGrant]).toEqual(['oauth', 'invalid_grant', true]);
    const b = await errorOf(problemResponse(429, 'RATE_LIMITED', { 'carpal-retry-after-ms': '2500', 'carpal-request-id': 'r9' }));
    expect([b.kind, b.error, b.retryAfterMs, b.requestId, b.invalidGrant]).toEqual(['problem', 'RATE_LIMITED', 2500, 'r9', false]);
    const c = await errorOf(new Response('oops', { status: 502 }));
    expect([c.kind, c.error]).toEqual(['network', 'http_502']);
  });

  it('a refused refresh is a TokenEndpointError with invalidGrant', async () => {
    const { tc } = await client();
    await expect(tc.refresh('cp-web-consumer', 'cprt_unknown')).rejects.toMatchObject({ invalidGrant: true, status: 400 });
  });

  it('an unreachable auth host is a network error', async () => {
    const tc = new TokenClient({
      authUrl: 'http://nowhere.test',
      clientHeader: header,
      fetch: (async () => {
        throw new TypeError('ECONNREFUSED');
      }) as typeof fetch,
    });
    await expect(tc.clientCredentials('cp-ssr')).rejects.toBeInstanceOf(TokenEndpointError);
  });
});

describe('token requests', () => {
  it('send the client id (no client authentication in lite) and CarPal-Client of that client', async () => {
    const { tc, backend } = await client();
    const t = await tc.clientCredentials('cp-ssr');
    expect(t.scope).toBe('public.read');
    const call = backend.calls.find((c) => c.url.endsWith('/oauth/token'))!;
    expect(new URLSearchParams(call.body).get('client_id')).toBe('cp-ssr');
    expect(new URLSearchParams(call.body).get('client_assertion')).toBeNull();
    expect(call.headers.get('carpal-client')).toBe('cp-ssr/0.1.0 (web 1.0)');
    expect(call.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(noClientAuthentication.method).toBe('none');
  });

  it('retry once with the server nonce after use_dpop_nonce (strict mode, SEC-AU-6)', async () => {
    const { tc, backend } = await client();
    let first = true;
    backend.token.handler = (r) => {
      if (!first) return undefined;
      first = false;
      expect(decodeJwt(r.headers.get('dpop')!).nonce).toBeUndefined();
      return oauthError(400, 'use_dpop_nonce', { 'dpop-nonce': 'server-nonce-1' });
    };
    await tc.anonymous('cp-web-consumer', await generateDpopKey());
    const proofs = backend.calls.filter((c) => c.url.endsWith('/oauth/token')).map((c) => decodeJwt(c.headers.get('dpop')!));
    expect(proofs).toHaveLength(2);
    expect(proofs[1]!.nonce).toBe('server-nonce-1');
    expect(proofs[1]!.htu).toBe(`${ISSUER}/oauth/token`);
  });

  it('solve the proof of work when an ATT grant is refused for it, and up front in strict mode (DI-22)', async () => {
    const { tc, backend } = await client();
    backend.token.handler = (r) => (r.headers.get('carpal-pow') ? undefined : problemResponse(403, 'ATTESTATION_REQUIRED'));
    await tc.anonymous('cp-web-consumer', await generateDpopKey());
    const tokens = backend.calls.filter((c) => c.url.endsWith('/oauth/token'));
    expect(tokens).toHaveLength(2);
    expect(tokens[1]!.headers.get('carpal-pow')).toMatch(/^ch-1\.\d+$/);
    expect(backend.calls.filter((c) => c.url.endsWith('/oauth/challenge'))).toHaveLength(1);

    const strict = await client({ powUpFront: true });
    await strict.tc.anonymous('cp-web-consumer', await generateDpopKey());
    const calls = strict.backend.calls.map((c) => new URL(c.url).pathname);
    expect(calls.indexOf('/oauth/challenge')).toBeLessThan(calls.indexOf('/oauth/token'));
    // Non-ATT grants never ask for a challenge.
    await strict.tc.clientCredentials('cp-ssr');
    expect(strict.backend.calls.filter((c) => c.url.endsWith('/oauth/challenge'))).toHaveLength(1);
  });

  it('private_key_jwt adds an RFC 7523 assertion for the token endpoint (strict-mode seam, P2.T10)', async () => {
    const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const key = { ...(await exportJWK(privateKey)), kid: 'bff-1' } as JWK & { kid: string };
    const { tc, backend } = await client({ clientAuth: () => privateKeyJwt(key) });
    await tc.clientCredentials('cp-ssr');
    const form = new URLSearchParams(backend.calls.find((c) => c.url.endsWith('/oauth/token'))!.body);
    expect(form.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    const assertion = form.get('client_assertion')!;
    expect(decodeProtectedHeader(assertion)).toMatchObject({ alg: 'EdDSA', kid: 'bff-1' });
    const claims = decodeJwt(assertion);
    expect(claims).toMatchObject({ iss: 'cp-ssr', sub: 'cp-ssr', aud: `${ISSUER}/oauth/token` });
    expect(claims.exp! - claims.iat!).toBe(60);
    expect(claims.jti).toBeTruthy();
    expect(publicKey).toBeTruthy();
  });
});

describe('ID token verification', () => {
  async function signed(over: { aud?: string; iss?: string; kid?: string; alg?: 'EdDSA' | 'ES256' } = {}) {
    const { privateKey } = await generateKeyPair(over.alg ?? 'EdDSA', { crv: 'Ed25519' });
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ nonce: 'n1' })
      .setProtectedHeader({ alg: over.alg ?? 'EdDSA', kid: over.kid ?? 'k1' })
      .setIssuer(over.iss ?? ISSUER)
      .setAudience(over.aud ?? 'cp-web-consumer')
      .setSubject('u')
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .sign(privateKey);
  }

  it('rejects a token not signed by the JWKS key, and refetches the JWKS once for an unknown kid', async () => {
    const { tc, backend } = await client();
    await expect(tc.verifyIdToken(await signed(), { clientId: 'cp-web-consumer', nonce: 'n1' })).rejects.toThrow();
    await expect(tc.verifyIdToken(await signed({ kid: 'k2' }), { clientId: 'cp-web-consumer', nonce: 'n1' })).rejects.toThrow();
    expect(backend.calls.filter((c) => c.url.endsWith('/jwks.json'))).toHaveLength(2);
  });
});

describe('DPoP and PoW primitives', () => {
  it('proofs carry htm, htu without query, ath and the public key only', async () => {
    const key = await generateDpopKey();
    const proof = await dpopProof(key, { method: 'post', url: 'https://api.carpal.app/v1/me?x=1', accessToken: 'tok' });
    const h = decodeProtectedHeader(proof);
    expect(h).toMatchObject({ alg: 'ES256', typ: 'dpop+jwt' });
    expect((h.jwk as JWK).d).toBeUndefined();
    expect(decodeJwt(proof)).toMatchObject({ htm: 'POST', htu: 'https://api.carpal.app/v1/me', ath: await sha256Base64url('tok') });
    expect(await jwkThumbprint(key)).toBe(await jwkThumbprint(key));
  });

  it('counts leading zero bits and solves a challenge the way the backend checks it', async () => {
    expect(leadingZeroBits(new Uint8Array([0, 0x0f]))).toBe(12);
    expect(leadingZeroBits(new Uint8Array([0x80]))).toBe(0);
    const nonce = await solvePow({ prefix: 'abcdefghijklmnop', difficulty_bits: 10 });
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`abcdefghijklmnop${nonce}`)));
    expect(leadingZeroBits(hash)).toBeGreaterThanOrEqual(10);
  });
});
