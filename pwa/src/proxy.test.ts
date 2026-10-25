import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';
import { proxy } from './proxy';

const request = (path: string, headers: Record<string, string> = {}) =>
  new NextRequest(new URL(path, 'http://localhost:3000'), { headers });

describe('proxy (locale routing)', () => {
  it('redirects paths without a locale to the negotiated one, keeping path and query', () => {
    const res = proxy(request('/garage?tab=docs', { 'accept-language': 'en-US,en;q=0.9' }));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost:3000/en/garage?tab=docs');
    expect(res.headers.get('vary')).toContain('Accept-Language');
  });

  it('uses the remembered locale and the region default', () => {
    expect(proxy(request('/', { cookie: 'cp_locale=en' })).headers.get('location')).toBe('http://localhost:3000/en');
    expect(proxy(request('/')).headers.get('location')).toBe('http://localhost:3000/fa');
  });

  it('stores a theme choice and drops the parameter', () => {
    const res = proxy(request('/fa?theme=sun&x=1'));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('http://localhost:3000/fa?x=1');
    expect(res.cookies.get('cp_theme')?.value).toBe('sun');
  });

  it('?theme=auto deletes the stored choice (P3.T3)', () => {
    const res = proxy(request('/fa?theme=auto', { cookie: 'cp_theme=dark' }));
    expect(res.status).toBe(303);
    expect(res.cookies.get('cp_theme')?.value).toBe('');
    expect(res.headers.get('set-cookie')).toMatch(/cp_theme=;.*Max-Age=0/i);
  });

  it('ignores unknown themes', () => {
    const res = proxy(request('/en?theme=neon'));
    expect(res.headers.get('location')).toBe('http://localhost:3000/en');
    expect(res.cookies.get('cp_theme')).toBeUndefined();
  });

  it('passes localized requests through with the locale header and remembers the locale', () => {
    const res = proxy(request('/en/garage'));
    expect(res.headers.get('x-middleware-request-x-carpal-locale')).toBe('en');
    expect(res.cookies.get('cp_locale')?.value).toBe('en');
  });
});

describe('proxy (system pages, P3.T8)', () => {
  /** A fresh proxy module whose (cached) server env sees `vars`. */
  async function proxyWith(vars: Record<string, string>) {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    Object.assign(process.env, vars);
    vi.resetModules();
    try {
      const mod = await import('./proxy');
      mod.proxy(request('/fa')); // reads and caches the env now
      return mod.proxy;
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it('never trusts a system marker sent by the client', () => {
    const res = proxy(request('/fa/system/gone', { 'x-carpal-system': 'gone' }));
    expect(res.headers.get('x-middleware-request-x-carpal-system')).toBeNull();
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
  });

  it('maintenance answers every localized page with the 503 system page', async () => {
    const p = await proxyWith({ CARPAL_PWA_MAINTENANCE: 'on' });
    const res = p(request('/en/shop/reza-auto'));
    expect(res.status).toBe(503);
    expect(res.headers.get('x-middleware-rewrite')).toBe('http://localhost:3000/en/system/maintenance');
    expect(res.headers.get('retry-after')).toBe('300');
    expect(res.headers.get('content-security-policy')).toContain("'nonce-");
  });

  it('demo builds rewrite /<locale>/dev-kit/status/<kind> with its status; other builds do not', async () => {
    const demo = await proxyWith({ CARPAL_PWA_DEMO: '1' });
    expect(demo(request('/fa/dev-kit/status/gone')).status).toBe(410);
    expect(demo(request('/fa/dev-kit/status/no-access')).status).toBe(403);
    expect(demo(request('/fa/dev-kit/status/suspended')).headers.get('x-middleware-rewrite')).toBeNull();
    expect(proxy(request('/fa/dev-kit/status/gone')).headers.get('x-middleware-rewrite')).toBeNull();
  });
});

describe('proxy (security headers, P2.T8)', () => {
  it('puts a fresh CSP nonce on the response and on the request Next.js renders with', () => {
    const a = proxy(request('/en'));
    const csp = a.headers.get('content-security-policy')!;
    const nonce = /'nonce-([^']+)'/.exec(csp)![1]!;
    expect(a.headers.get('x-middleware-request-content-security-policy')).toBe(csp);
    expect(a.headers.get('x-middleware-request-x-nonce')).toBe(nonce);
    expect(proxy(request('/en')).headers.get('content-security-policy')).not.toContain(nonce);
    expect(a.headers.get('x-frame-options')).toBe('DENY');
    expect(a.headers.get('cache-control')).toBeNull();
  });

  it('marks private pages no-store and noindex, redirects included', () => {
    const page = proxy(request('/fa/garage'));
    expect(page.headers.get('cache-control')).toBe('private, no-store');
    expect(page.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(proxy(request('/fa/garage?theme=dark')).headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });

  it('serves the hosted sign-in and link pages without locale routing', () => {
    for (const path of ['/id/signin?interaction_id=1', '/l/ri']) {
      const res = proxy(request(path));
      expect(res.headers.get('location'), path).toBeNull();
      expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
      expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    }
  });

  it('is not run for the BFF, the API, the auth-host proxy, Next.js internals and files', async () => {
    const { config } = await import('./proxy');
    const matcher = new RegExp(`^${config.matcher[0]}$`);
    for (const p of [
      '/api/v1/me',
      '/bff/login',
      '/id/oauth/authorize',
      '/id/v1/auth/signin',
      '/id/.well-known/jwks.json',
      '/_next/static/x.js',
      '/ds/tokens.css',
      '/favicon.ico',
    ])
      expect(matcher.test(p), p).toBe(false);
    for (const p of ['/', '/fa', '/en/garage', '/id/signin', '/l/ri', '/apiary', '/identity']) expect(matcher.test(p), p).toBe(true);
  });
});
