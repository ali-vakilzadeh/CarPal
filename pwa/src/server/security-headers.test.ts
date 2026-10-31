import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, createNonce, framesDocuments, isPrivatePage, originsOf, pageSecurityHeaders } from './security-headers';

const base = { nonce: 'abc', dev: false, https: false, mediaOrigins: ['http://127.0.0.1:8083'], tileOrigins: [] as string[] };
const directives = (csp: string) => new Map(csp.split('; ').map((d) => [d.split(' ')[0]!, d.split(' ').slice(1).join(' ')]));

describe('page security headers (GD-15, SEC-WEB-4)', () => {
  it('production CSP: nonce + strict-dynamic, Trusted Types, no framing, no plugins, media host allowed', () => {
    const d = directives(contentSecurityPolicy(base));
    expect(d.get('script-src')).toBe("'self' 'nonce-abc' 'strict-dynamic'");
    expect(d.get('style-src')).toBe("'self' 'nonce-abc'");
    expect(d.get('img-src')).toBe("'self' data: blob: http://127.0.0.1:8083");
    expect(d.get('connect-src')).toBe("'self' http://127.0.0.1:8083");
    expect(d.get('frame-ancestors')).toBe("'none'");
    expect(d.get('object-src')).toBe("'none'");
    expect(d.get('base-uri')).toBe("'none'");
    expect(d.get('require-trusted-types-for')).toBe("'script'");
    expect(d.get('trusted-types')).toBe('nextjs nextjs#bundler default carpal-sw');
    expect(d.has('upgrade-insecure-requests')).toBe(false);
    expect(contentSecurityPolicy(base)).not.toContain('unsafe-inline');
    expect(contentSecurityPolicy(base)).not.toContain('unsafe-eval');
  });

  it('dev adds eval and the HMR socket and drops Trusted Types; https upgrades requests', () => {
    const dev = directives(contentSecurityPolicy({ ...base, dev: true }));
    expect(dev.get('script-src')).toContain("'unsafe-eval'");
    expect(dev.get('connect-src')).toContain('ws:');
    expect(dev.has('require-trusted-types-for')).toBe(false);
    expect(directives(contentSecurityPolicy({ ...base, https: true })).has('upgrade-insecure-requests')).toBe(true);
  });

  it('the other headers, HSTS only when asked', () => {
    const h = pageSecurityHeaders({ ...base, hsts: false });
    expect(h).toMatchObject({
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-resource-policy': 'same-origin',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    });
    expect(h['permissions-policy']).toMatch(/^geolocation=\(self\), camera=\(self\), microphone=\(\)/);
    expect(h['strict-transport-security']).toBeUndefined();
    expect(pageSecurityHeaders({ ...base, hsts: true })['strict-transport-security']).toContain('max-age=63072000');
  });

  it('nonces are fresh base64 of 128 bits; origins are deduplicated', () => {
    expect(createNonce()).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(createNonce()).not.toBe(createNonce());
    expect(originsOf('http://a.test/x', 'http://a.test/y', undefined, 'not a url')).toEqual(['http://a.test']);
  });

  it('knows the private pages', () => {
    for (const p of ['/fa/garage', '/en/settings/security', '/fa/home', '/id/signin', '/l/ri'])
      expect(isPrivatePage(p, ['fa', 'en']), p).toBe(true);
    for (const p of ['/fa', '/en/shop/reza', '/fa/search/abc', '/garage']) expect(isPrivatePage(p, ['fa', 'en']), p).toBe(false);
  });

  it('frames blob documents only on the garage pages (P7 in-place PDF preview)', () => {
    expect(directives(contentSecurityPolicy(base)).get('frame-src')).toBe("'none'");
    expect(directives(contentSecurityPolicy({ ...base, documentFrames: true })).get('frame-src')).toBe('blob:');
    expect(framesDocuments('/fa/garage/0193/documents', ['fa', 'en'])).toBe(true);
    for (const p of ['/fa/settings', '/en/shop/garage', '/garage']) expect(framesDocuments(p, ['fa', 'en']), p).toBe(false);
  });
});
