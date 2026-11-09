import { describe, expect, it } from 'vitest';
import { createPkce, randomToken, sha256Base64url, timingSafeEqual, uuidv7 } from './crypto';
import { hostCookie, parseCookies, readBody } from './http';

describe('crypto', () => {
  it('computes the RFC 7636 appendix B S256 challenge', async () => {
    expect(await sha256Base64url('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('creates PKCE pairs with a 43-character verifier that the challenge matches', async () => {
    const p = await createPkce();
    expect(p.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await sha256Base64url(p.verifier)).toBe(p.challenge);
    expect((await createPkce()).verifier).not.toBe(p.verifier);
  });

  it('random tokens are 256-bit base64url', () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set(Array.from({ length: 100 }, () => randomToken())).size).toBe(100);
  });

  it('compares strings in full', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
  });

  it('UUIDv7: version, variant and time order', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a.slice(0, 13) < b.slice(0, 13)).toBe(true);
    expect(parseInt(a.replace(/-/g, '').slice(0, 12), 16)).toBe(1_700_000_000_000);
  });
});

describe('http helpers', () => {
  it('parses cookies, first value wins', () => {
    expect(parseCookies('a=1; b=x=y;  a=2;bad; c=')).toEqual(
      new Map([
        ['a', '1'],
        ['b', 'x=y'],
        ['c', ''],
      ]),
    );
    expect(parseCookies(null).size).toBe(0);
  });

  it('writes __Host- cookies with Secure and Path=/ and no Domain', () => {
    expect(hostCookie('__Host-x', 'v', { sameSite: 'Strict', maxAgeS: 10.7 })).toBe(
      '__Host-x=v; Path=/; Secure; SameSite=Strict; HttpOnly; Max-Age=10',
    );
    expect(hostCookie('__Host-x', '', { sameSite: 'Lax', maxAgeS: -5 })).toContain('Max-Age=0');
  });

  it('reads bodies up to the limit', async () => {
    const req = (body: string, length?: string) =>
      new Request('http://x/', { method: 'POST', body, headers: length ? { 'content-length': length } : {} });
    expect(new TextDecoder().decode((await readBody(req('hello'), 5))!)).toBe('hello');
    expect(await readBody(req('hello!'), 5)).toBeNull();
    expect(await readBody(req('hi', '999'), 5)).toBeNull();
  });
});
