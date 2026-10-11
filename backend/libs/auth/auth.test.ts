import { createHash, generateKeyPairSync } from 'node:crypto';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';
import { CryptoServices, uuidv7 } from '#libs/crypto/index.js';
import { MemoryKeyValueStore } from '#libs/infra/index.js';
import { Authenticator, JwtKeyRing, SessionStore, TokenService, type AuthRequest } from './index.js';

const crypto = new CryptoServices('test-master-secret-0123456789-abcdefghij');
const ring = JwtKeyRing.derived(crypto.keys);
const ISS = 'https://id.carpal.app';
const API = 'https://api.carpal.app';
const ADMIN = 'https://admin-api.carpal.app';
const tokens = new TokenService(ring, ISS);

let kv: MemoryKeyValueStore;
let sessions: SessionStore;
const make = (strict = false) =>
  new Authenticator({ tokens, sessions, kv, hmac: crypto.hmac, audiences: { api: API, 'admin-api': ADMIN }, strict });

beforeEach(() => {
  kv = new MemoryKeyValueStore();
  sessions = new SessionStore(kv);
});

const req = (authorization: string | undefined, extra: Partial<AuthRequest> = {}): AuthRequest => ({
  host: 'api',
  authorization,
  dpop: undefined,
  clientId: 'cp-mobile',
  method: 'GET',
  htu: 'https://api.carpal.app/v1/me',
  ...extra,
});

async function userToken(o: { acr?: 'aal1' | 'aal2' | 'aal3'; authTime?: number; audience?: string; staff?: boolean } = {}) {
  const userId = uuidv7();
  const sid = uuidv7();
  const authTime = o.authTime ?? Math.floor(Date.now() / 1000);
  await sessions.create(
    { sid, userId, clientId: 'cp-mobile', acr: o.acr ?? 'aal1', authTime, createdAt: new Date().toISOString(), staff: !!o.staff },
    60_000,
  );
  const token = await tokens.issue({
    subject: userId,
    clientId: 'cp-mobile',
    audience: o.audience ?? API,
    sessionId: sid,
    acr: o.acr ?? 'aal1',
    authTime,
    scope: 'openid',
    ttlSeconds: 300,
  });
  return { userId, sid, token };
}

describe('TokenService', () => {
  it('issues EdDSA at+jwt tokens and publishes a JWKS', async () => {
    const t = await tokens.issue({
      subject: uuidv7(),
      clientId: 'cp-mobile',
      audience: API,
      acr: 'anonymous',
      scope: 'public.read search',
      ttlSeconds: 900,
    });
    const header = JSON.parse(Buffer.from(t.split('.')[0]!, 'base64url').toString()) as Record<string, string>;
    expect(header).toEqual({ alg: 'EdDSA', typ: 'at+jwt', kid: 'cp-ed25519-1' });
    expect(ring.jwks().keys[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519', kid: 'cp-ed25519-1', alg: 'EdDSA' });
    expect(JSON.stringify(ring.jwks())).not.toContain('"d"');
    await expect(tokens.issue({ subject: 'x', clientId: 'c', audience: API, acr: 'aal1', scope: '', ttlSeconds: 3600 })).rejects.toThrow(
      /lifetime/,
    );
  });

  it('rejects wrong audience, expired tokens, unknown kid, other algorithms and embedded keys (SEC-AU-2)', async () => {
    const { token } = await userToken();
    await expect(tokens.verify(token, ADMIN)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const old = await tokens.issue({
      subject: uuidv7(),
      clientId: 'cp-mobile',
      audience: API,
      sessionId: uuidv7(),
      acr: 'aal1',
      authTime: 1,
      scope: '',
      ttlSeconds: 300,
      now: 1_000_000,
    });
    await expect(tokens.verify(old, API)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    const other = JwtKeyRing.derived(new CryptoServices('another-master-secret-0123456789-xyz').keys, ['cp-ed25519-9']);
    const foreign = await new TokenService(other, ISS).issue({
      subject: 'x',
      clientId: 'cp-mobile',
      audience: API,
      acr: 'anonymous',
      scope: '',
      ttlSeconds: 60,
    });
    await expect(tokens.verify(foreign, API)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    // Same key id but HS256 with the public key as secret (algorithm confusion).
    const hs = await new SignJWT({ client_id: 'cp-mobile', acr: 'anonymous', scope: '' })
      .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt', kid: 'cp-ed25519-1' })
      .setIssuer(ISS)
      .setAudience(API)
      .setSubject('x')
      .setJti('j')
      .setIssuedAt()
      .setNotBefore('0s')
      .setExpirationTime('1m')
      .sign(new TextEncoder().encode('secret-secret-secret-secret-secret!!'));
    await expect(tokens.verify(hs, API)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    const { privateKey } = generateKeyPairSync('ed25519');
    const withJwk = await new SignJWT({ client_id: 'cp-mobile', acr: 'anonymous', scope: '' })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt', kid: 'cp-ed25519-1', jwk: { kty: 'OKP', crv: 'Ed25519', x: 'AAAA' } })
      .setIssuer(ISS)
      .setAudience(API)
      .setSubject('x')
      .setJti('j')
      .setIssuedAt()
      .setNotBefore('0s')
      .setExpirationTime('1m')
      .sign(privateKey);
    await expect(tokens.verify(withJwk, API)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});

describe('Authenticator', () => {
  it('authenticates users against a live session and anonymous tokens by device key', async () => {
    const { token, userId, sid } = await userToken();
    const p = await make().authenticate(req(`DPoP ${token}`));
    expect(p).toMatchObject({ kind: 'user', userId, sessionId: sid, acr: 'aal1' });

    const anon = await tokens.issue({
      subject: uuidv7(),
      clientId: 'cp-mobile',
      audience: API,
      acr: 'anonymous',
      scope: 'public.read search',
      ttlSeconds: 900,
      cnf: { jkt: 'device-key' },
    });
    const a = await make().authenticate(req(`Bearer ${anon}`));
    expect(a).toMatchObject({ kind: 'anonymous', scopes: ['public.read', 'search'] });
    expect(a.kind === 'anonymous' && a.anonKey).toMatch(/^[0-9a-f]{32}$/);

    await sessions.revoke(sid);
    await expect(make().authenticate(req(`DPoP ${token}`))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('requires a token, a known scheme and the matching CarPal-Client', async () => {
    const { token } = await userToken();
    await expect(make().authenticate(req(undefined))).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
      headers: { 'www-authenticate': expect.any(String) },
    });
    await expect(make().authenticate(req(`Basic ${token}`))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(make().authenticate(req(`DPoP ${token}`, { clientId: 'cp-web-portal' }))).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('accepts only aal3 staff sessions on the admin plane', async () => {
    const consumer = await userToken({ audience: ADMIN });
    await expect(make().authenticate(req(`Bearer ${consumer.token}`, { host: 'admin-api' }))).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    const weakStaff = await userToken({ audience: ADMIN, staff: true, acr: 'aal2' });
    await expect(make().authenticate(req(`Bearer ${weakStaff.token}`, { host: 'admin-api' }))).rejects.toMatchObject({
      code: 'STEP_UP_REQUIRED',
    });
    const staff = await userToken({ audience: ADMIN, staff: true, acr: 'aal3' });
    expect(await make().authenticate(req(`Bearer ${staff.token}`, { host: 'admin-api' }))).toMatchObject({ kind: 'staff' });
    const { token: apiToken } = await userToken();
    await expect(make().authenticate(req(`Bearer ${apiToken}`, { host: 'admin-api' }))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('enforces the step-up window (SEC-AU-10)', async () => {
    const auth = make();
    const now = Math.floor(Date.now() / 1000);
    const fresh = await auth.authenticate(req(`DPoP ${(await userToken({ acr: 'aal2', authTime: now - 60 })).token}`));
    expect(() => auth.requireAssurance(fresh, 'aal2')).not.toThrow();
    expect(() => auth.requireAssurance(fresh, 'aal3')).toThrow(expect.objectContaining({ code: 'STEP_UP_REQUIRED' }));
    const stale = await auth.authenticate(req(`DPoP ${(await userToken({ acr: 'aal2', authTime: now - 601 })).token}`));
    try {
      auth.requireAssurance(stale, 'aal2');
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({
        code: 'STEP_UP_REQUIRED',
        headers: { 'www-authenticate': 'DPoP error="insufficient_user_authentication", acr_values="aal2", max_age=600' },
      });
    }
  });

  it('strict mode: requires a valid, fresh, non-replayed DPoP proof bound to cnf.jkt', async () => {
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    const jwk = await exportJWK(publicKey);
    const jkt = await calculateJwkThumbprint(jwk);
    const userId = uuidv7();
    const sid = uuidv7();
    const now = Math.floor(Date.now() / 1000);
    await sessions.create({ sid, userId, clientId: 'cp-mobile', acr: 'aal1', authTime: now, createdAt: '', staff: false }, 60_000);
    const token = await tokens.issue({
      subject: userId,
      clientId: 'cp-mobile',
      audience: API,
      sessionId: sid,
      acr: 'aal1',
      authTime: now,
      scope: '',
      ttlSeconds: 300,
      cnf: { jkt },
    });
    const proof = (o: { htm?: string; htu?: string; jti?: string; iat?: number } = {}) =>
      new SignJWT({
        htm: o.htm ?? 'GET',
        htu: o.htu ?? 'https://api.carpal.app/v1/me',
        ath: createHash('sha256').update(token).digest('base64url'),
      })
        .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk })
        .setJti(o.jti ?? uuidv7())
        .setIssuedAt(o.iat ?? now)
        .sign(privateKey);
    const strict = make(true);
    await expect(strict.authenticate(req(`DPoP ${token}`))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const p1 = await proof({ jti: 'same' });
    expect(await strict.authenticate(req(`DPoP ${token}`, { dpop: p1 }))).toMatchObject({ kind: 'user' });
    await expect(strict.authenticate(req(`DPoP ${token}`, { dpop: p1 }))).rejects.toMatchObject({
      detail: expect.stringMatching(/replayed/),
    });
    await expect(strict.authenticate(req(`DPoP ${token}`, { dpop: await proof({ htm: 'POST' }) }))).rejects.toMatchObject({
      detail: 'DPoP htm',
    });
    await expect(strict.authenticate(req(`DPoP ${token}`, { dpop: await proof({ iat: now - 120 }) }))).rejects.toMatchObject({
      detail: 'DPoP iat',
    });
    // Non-strict mode ignores the binding (GD-06 deviation).
    expect(await make(false).authenticate(req(`DPoP ${token}`))).toMatchObject({ kind: 'user' });
    // Attestation is enforced only in strict mode.
    await expect(make(false).checkAttestation({ opId: 'auth.signup' })).resolves.toBeUndefined();
    await expect(strict.checkAttestation({ opId: 'auth.signup' })).rejects.toMatchObject({ code: 'ATTESTATION_REQUIRED' });
  });
});
