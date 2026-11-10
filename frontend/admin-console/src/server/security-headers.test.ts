import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, createNonce, originsOf, pageSecurityHeaders } from './security-headers';

describe('page security headers (AC1.T5)', () => {
  it('never lets the console be framed, cached or indexed', () => {
    const h = pageSecurityHeaders({ nonce: 'n', dev: false, https: true, hsts: true });
    expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['cache-control']).toBe('private, no-store');
    expect(h['x-robots-tag']).toBe('noindex, nofollow');
    expect(h['referrer-policy']).toBe('no-referrer');
    expect(h['strict-transport-security']).toMatch(/^max-age=/);
  });

  it('uses a nonce with strict-dynamic and Trusted Types outside next dev', () => {
    const csp = contentSecurityPolicy({ nonce: 'abc', dev: false, https: false });
    expect(csp).toContain("script-src 'self' 'nonce-abc' 'strict-dynamic'");
    expect(csp).toContain("require-trusted-types-for 'script'");
    expect(csp).not.toContain('unsafe-eval');
    expect(contentSecurityPolicy({ nonce: 'abc', dev: true, https: false })).toContain("'unsafe-eval'");
  });

  it('allows passkeys and nothing else', () => {
    const p = pageSecurityHeaders({ nonce: 'n', dev: false, https: false, hsts: false })['permissions-policy'];
    expect(p).toContain('publickey-credentials-get=(self)');
    expect(p).toContain('camera=()');
  });

  it('allows display copies from the storage host only, for the media viewer (AC8)', () => {
    const csp = contentSecurityPolicy({
      nonce: 'n',
      dev: false,
      https: true,
      mediaOrigins: originsOf('https://media.carpal-usercontent.app/x?y=1'),
    });
    expect(csp).toContain("img-src 'self' data: blob: https://media.carpal-usercontent.app");
    expect(csp).toContain("media-src 'self' https://media.carpal-usercontent.app");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("connect-src 'self' https://media");
    expect(contentSecurityPolicy({ nonce: 'n', dev: false, https: true })).not.toContain('media-src');
    expect(originsOf('not a url')).toEqual([]);
  });

  it('lets the map load its style and tiles from the map style host only (AC9)', () => {
    const csp = contentSecurityPolicy({
      nonce: 'n',
      dev: false,
      https: true,
      mapOrigins: originsOf('https://tiles.carpals.ir/ir-pilot/style.json'),
    });
    expect(csp).toContain("img-src 'self' data: blob: https://tiles.carpals.ir");
    expect(csp).toContain("connect-src 'self' https://tiles.carpals.ir");
    expect(csp).toContain("worker-src 'self'");
    expect(contentSecurityPolicy({ nonce: 'n', dev: false, https: true })).toContain("connect-src 'self';");
  });

  it('makes a fresh nonce each time', () => {
    expect(createNonce()).not.toBe(createNonce());
    expect(atob(createNonce())).toHaveLength(16);
  });
});
