// P2.T8/T9: page security headers (nonce CSP with Trusted Types, framing, COOP/CORP, Permissions-Policy), private
// pages never cached or indexed, and the BFF's refusals that need no backend (allowlist 404, CSRF 403, guest session).
import { expect, test } from '@playwright/test';
import { decideCookies } from './support';

test('pages carry a nonce CSP with Trusted Types and run without a policy violation', async ({ page, context, baseURL }) => {
  await decideCookies(context, baseURL!);
  const violations: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') violations.push(m.text());
  });
  page.on('pageerror', (e) => violations.push(e.message));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`));
  });
  const res = await page.goto('/en');
  const headers = res!.headers();
  const csp = headers['content-security-policy']!;
  const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
  expect(nonce).toBeTruthy();
  expect(csp).toContain("'strict-dynamic'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("base-uri 'none'");
  expect(csp).toContain("require-trusted-types-for 'script'");
  expect(headers['cross-origin-opener-policy']).toBe('same-origin');
  expect(headers['cross-origin-resource-policy']).toBe('same-origin');
  expect(headers['permissions-policy']).toContain('geolocation=(self)');
  expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect(headers['x-content-type-options']).toBe('nosniff');

  // Next.js put the nonce on every script it rendered (and on the theme boot script); the page hydrated (the theme picker works).
  // Every script tag the server sent carries the nonce; chunks the runtime adds later are trusted through
  // 'strict-dynamic' and load through the Trusted Types default policy (P3).
  const tags = (await res!.text()).match(/<script\b[^>]*>/g) ?? [];
  expect(tags.length).toBeGreaterThan(0);
  expect(tags.filter((t) => !t.includes(`nonce="${nonce}"`))).toEqual([]);
  await page.locator('html[data-hydrated="true"]').waitFor({ state: 'attached' });
  await page.getByRole('contentinfo').getByRole('link', { name: 'Night' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(violations).toEqual([]);

  // A new nonce per response.
  const again = await page.request.get('/en');
  expect(again.headers()['content-security-policy']).not.toContain(nonce!);
});

test('private pages and the hosted sign-in are no-store and noindex', async ({ request }) => {
  for (const path of ['/en/garage', '/fa/settings', '/id/signin', '/l/ri']) {
    const res = await request.get(path, { maxRedirects: 0 });
    expect(res.headers()['cache-control'], path).toContain('no-store');
    expect(res.headers()['x-robots-tag'], path).toContain('noindex');
    expect(res.headers()['content-security-policy'], path).toContain("frame-ancestors 'none'");
  }
  const pub = await request.get('/en');
  expect(pub.headers()['x-robots-tag']).toBeUndefined();
});

test('the forwarder 404s paths outside the consumer audience without calling the backend', async ({ request }) => {
  for (const path of [
    '/api/v1/admin/flags',
    '/api/v1/orgs/0193/locations',
    '/api/v1/no-such-route',
    '/api/v1/me/../admin',
    '/api/v1/me%2Fvehicles',
  ]) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(404);
    expect(res.headers()['content-type']).toBe('application/problem+json');
    expect((await res.json()).code).toBe('NOT_FOUND');
    expect(res.headers()['cache-control']).toBe('no-store');
  }
  // The auth host's token endpoint is the BFF's alone.
  expect((await request.post('/id/oauth/token', { form: { grant_type: 'client_credentials' } })).status()).toBe(404);
});

test('state changes without a CSRF token or from another origin are refused', async ({ request, baseURL }) => {
  const noToken = await request.post('/api/v1/me/vehicles', { data: {}, headers: { origin: baseURL!, 'sec-fetch-site': 'same-origin' } });
  expect(noToken.status()).toBe(403);
  expect(await noToken.json()).toMatchObject({ code: 'CSRF_FAILED' });

  const { csrf_token } = await (await request.get('/bff/csrf')).json();
  const foreign = await request.post('/api/v1/me/vehicles', {
    data: {},
    headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', 'x-csrf-token': csrf_token },
  });
  expect(foreign.status()).toBe(403);
  expect(await foreign.json()).toMatchObject({ code: 'CSRF_FAILED', reason: 'origin' });

  const logout = await request.post('/bff/logout', { headers: { origin: baseURL!, 'sec-fetch-site': 'same-origin' } });
  expect(logout.status()).toBe(403);
});

test('a guest session view holds no tokens and the session cookie is __Host-, HttpOnly and SameSite=Strict', async ({ request }) => {
  const csrf = await request.get('/bff/csrf', { headers: { 'accept-language': 'en' } });
  const cookie = csrf.headers()['set-cookie']!;
  expect(cookie).toMatch(/^__Host-cp_sid=[A-Za-z0-9_-]{43}; Path=\/; Secure; SameSite=Strict; HttpOnly; Max-Age=\d+$/);
  const session = await request.get('/bff/session');
  expect(await session.json()).toEqual({ signed_in: false, user: null, locale: 'en', pending_intents: [] });
});

test('the built server forwards a guest call to the backend and keeps one session across route bundles', async ({ request }) => {
  const backend = await fetch(`${process.env.CARPAL_API_URL ?? 'http://127.0.0.1:8080'}/v1/health`).catch(() => null);
  test.skip(!backend?.ok, 'backend not running (`pnpm dev` in backend/)');
  const { csrf_token } = await (await request.get('/bff/csrf')).json();
  const res = await request.get('/api/v1/config/client', { headers: { 'accept-language': 'en' } });
  expect(res.status()).toBe(200);
  expect(await res.json()).toHaveProperty('flags');
  // /bff and /api are separate route bundles; the pre-session made by /bff/csrf is the one /api used.
  expect(res.headers()['set-cookie']).toBeUndefined();
  expect((await (await request.get('/bff/csrf')).json()).csrf_token).toBe(csrf_token);
});
