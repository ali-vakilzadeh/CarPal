import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
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
