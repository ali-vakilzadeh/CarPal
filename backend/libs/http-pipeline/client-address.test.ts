// S26c.T2 (NI-19): the caller's address behind nginx and the BFFs.
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { FORWARDED_CLIENT_TYP, ForwardedClientVerifier, forwardedFor, normalizeIp } from './client-address.js';

describe('X-Forwarded-For', () => {
  const trusted = new Set(['127.0.0.1', '::1', '10.0.0.2']);

  it('normalizes addresses', () => {
    expect(normalizeIp('::FFFF:203.0.113.9')).toBe('203.0.113.9');
    expect(normalizeIp(' 2001:DB8::1 ')).toBe('2001:db8::1');
    expect(normalizeIp('not-an-ip')).toBeUndefined();
  });

  it('is read only from a trusted peer, right to left, skipping trusted proxies', () => {
    expect(forwardedFor('::ffff:127.0.0.1', '203.0.113.9', trusted)).toBe('203.0.113.9');
    // A client that forges its own X-Forwarded-For: nginx appends the address it saw, which is the one used.
    expect(forwardedFor('127.0.0.1', '1.2.3.4, 203.0.113.9', trusted)).toBe('203.0.113.9');
    expect(forwardedFor('127.0.0.1', '198.51.100.7, 10.0.0.2', trusted)).toBe('198.51.100.7');
    // An untrusted peer's header is ignored.
    expect(forwardedFor('198.51.100.20', '1.2.3.4', trusted)).toBe('198.51.100.20');
    expect(forwardedFor('127.0.0.1', '1.2.3.4', new Set())).toBe('127.0.0.1');
    // A malformed hop: nothing to its left is trusted.
    expect(forwardedFor('127.0.0.1', '1.2.3.4, junk', trusted)).toBe('127.0.0.1');
    expect(forwardedFor('127.0.0.1', undefined, trusted)).toBe('127.0.0.1');
  });
});

describe('CarPal-Forwarded-Client', () => {
  const API = 'https://api.carpals.ir';
  const check = { audience: API, method: 'GET', htu: `${API}/v1/health` };
  let key: CryptoKey;
  let other: CryptoKey;
  let verifier: ForwardedClientVerifier;

  beforeAll(async () => {
    const pair = await generateKeyPair('ES256', { extractable: true });
    key = pair.privateKey;
    other = (await generateKeyPair('ES256')).privateKey;
    const pub = await exportJWK(pair.publicKey);
    verifier = new ForwardedClientVerifier({
      'cp-web-consumer': { keys: [{ ...pub, kid: 'k1' }] },
      // A public client's key is never used for forwarded addresses.
      'cp-mobile': { keys: [{ ...pub, kid: 'k1' }] },
    });
  });

  const statement = (
    claims: Record<string, unknown> = {},
    o: { iss?: string; typ?: string; signer?: CryptoKey; lifetime?: number } = {},
  ) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ htm: 'GET', htu: `${API}/v1/health`, cip: '203.0.113.9', ...claims })
      .setProtectedHeader({ alg: 'ES256', typ: o.typ ?? FORWARDED_CLIENT_TYP, kid: 'k1' })
      .setIssuer(o.iss ?? 'cp-web-consumer')
      .setSubject(o.iss ?? 'cp-web-consumer')
      .setAudience(API)
      .setIssuedAt(now)
      .setExpirationTime(now + (o.lifetime ?? 30))
      .sign(o.signer ?? key);
  };

  it('accepts a confidential client statement bound to this request', async () => {
    expect(await verifier.verify(await statement(), check)).toEqual({ clientId: 'cp-web-consumer', ip: '203.0.113.9' });
    expect(await verifier.verify(await statement({ cip: '::ffff:198.51.100.4' }), check)).toMatchObject({ ip: '198.51.100.4' });
  });

  it('refuses statements for another request, a long lifetime, another key or a public client', async () => {
    const refused = async (token: Promise<string>) => expect(await verifier.verify(await token, check)).toHaveProperty('refused');
    await refused(statement({ htu: `${API}/v1/other` }));
    await refused(statement({ htm: 'POST' }));
    await refused(statement({ cip: 'nobody' }));
    await refused(statement({}, { lifetime: 600 }));
    await refused(statement({}, { signer: other }));
    await refused(statement({}, { typ: 'JWT' }));
    await refused(statement({}, { iss: 'cp-mobile' }));
    expect(await verifier.verify(await statement(), { ...check, audience: 'https://admin-api.carpals.ir' })).toHaveProperty('refused');
    expect(await verifier.verify('junk', check)).toEqual({ refused: 'malformed' });
  });
});
