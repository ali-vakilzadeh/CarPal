// AC15.T5: the security pass of AC11.T5 repeated on the whole app (deploy/security-pass.md "AC15"), method of PWA
// P13.T4, against the live backend (strict for the acceptance run):
//   - every page an administrator can open (and the moderator-only disputes queue) answers with the page headers of
//     SEC-WEB / GD-12, raises no CSP or Trusted Types violation, and every admin read it makes answers no-store;
//   - no request URL of the walk carries an email address or a token (personal data and secrets stay in bodies and
//     headers, SEC-ADM-7);
//   - hostile return addresses never leave the console: the signed-out page's "Sign in again" and /bff/login keep only
//     a same-origin path.
// Needs backend `pnpm int:env backend` (strict) and the console's settings (README "End-to-end tests").
import { expect, test, type Page } from '@playwright/test';
import { requireBackend, signInAs } from './staff';
import { gotoReady } from './support';

test.describe.configure({ timeout: 600_000 });

const JWT = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;
const EMAIL = /[A-Za-z0-9._%+-]+(@|%40)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

const ROUTES = [
  '/',
  '/approvals',
  '/recoveries',
  '/verification',
  '/reviews',
  '/content',
  '/inventory',
  '/privacy',
  '/support',
  '/users',
  '/orgs',
  '/taxonomy',
  '/ai',
  '/mcp',
  '/analytics',
  '/audit',
  '/plans',
  '/flags',
  '/rates',
  '/retention',
  '/policies',
  '/notifications',
  '/staff',
  '/security',
  '/no-such-page',
];

function expectPageHeaders(h: Record<string, string>, where: string) {
  expect(h['cache-control'], where).toBe('private, no-store');
  expect(h['x-content-type-options'], where).toBe('nosniff');
  expect(h['x-frame-options'], where).toBe('DENY');
  expect(h['referrer-policy'], where).toBe('no-referrer');
  expect(h['cross-origin-opener-policy'], where).toBe('same-origin');
  expect(h['content-security-policy'], where).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
  expect(h['content-security-policy'], where).toContain("require-trusted-types-for 'script'");
  expect(h['content-security-policy'], where).toContain("frame-ancestors 'none'");
  expect(h['x-robots-tag'], where).toContain('noindex');
}

/** Collects CSP and Trusted Types violations, the browser's refusals in the console, and every request URL. */
async function watch(page: Page) {
  const seen = { urls: [] as string[], refusals: [] as string[], apiCache: [] as string[] };
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  page.on('request', (r) => seen.urls.push(r.url()));
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy|TrustedHTML|TrustedScript|Trusted Type/i.test(m.text()))
      seen.refusals.push(m.text());
  });
  page.on('response', async (r) => {
    const u = new URL(r.url());
    if (!u.pathname.startsWith('/api/v1/admin/')) return;
    const cache = (await r.allHeaders())['cache-control'];
    if (cache !== 'no-store') seen.apiCache.push(`${u.pathname} ${r.status()} cache-control=${cache}`);
  });
  return seen;
}

async function visit(page: Page, path: string) {
  const res = await gotoReady(page, path);
  // An unknown page inside the console is its not-found state with 200 (D-26: notFound() leaves a blank page under the
  // Trusted Types CSP); it still carries every page header.
  expect(res?.status(), path).toBe(200);
  expectPageHeaders(res!.headers(), path);
  if (path === '/no-such-page') await expect(page.getByTestId('not-found')).toBeVisible();
  await expect(page.locator('[data-state="loading"]')).toHaveCount(0, { timeout: 45_000 });
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp), `${path}: CSP violations`).toEqual([]);
}

test('every page: headers, no CSP or Trusted Types violation, no-store reads, no personal data in URLs', async ({ browser }) => {
  await requireBackend();
  const adm = await browser.newContext();
  const page = await adm.newPage();
  const seen = await watch(page);
  await signInAs(adm, page, ['ADM']);
  for (const path of ROUTES) await test.step(path, () => visit(page, path));

  // The moderator-only queue.
  const mod = await browser.newContext({ locale: 'fa-IR' });
  const modPage = await mod.newPage();
  const modSeen = await watch(modPage);
  await signInAs(mod, modPage, ['MOD'], { locale: 'fa' });
  await test.step('/disputes (MOD, fa)', () => visit(modPage, '/disputes'));

  for (const s of [seen, modSeen]) {
    expect(s.refusals, 'CSP / Trusted Types refusals in the console').toEqual([]);
    expect(s.apiCache, 'admin reads without no-store').toEqual([]);
    // The sign-in's own steps may name the account in the auth host's form posts (bodies), never in a URL.
    const leaks = s.urls.filter((u) => EMAIL.test(decodeURIComponent(u)) || JWT.test(u));
    expect(leaks, 'URLs with an email address or a token').toEqual([]);
  }
  await adm.close();
  await mod.close();
});

test('hostile return addresses stay on the console', async ({ page, request }) => {
  await requireBackend();
  for (const hostile of ['https://evil.example/x', '//evil.example/x', '/\\evil.example', 'javascript:alert(1)', '/%2F%2Fevil.example']) {
    await test.step(hostile, async () => {
      await gotoReady(page, `/id/signed-out?reason=logout&return_to=${encodeURIComponent(hostile)}`);
      const href = await page.getByRole('link', { name: 'Sign in again' }).getAttribute('href');
      expect(href, hostile).toMatch(/^\/bff\/login\?return_to=%2F/);
      // The return address is a path of this console: resolved against the origin it stays on it ('/%2F%2Fevil.example'
      // is a path with encoded slashes, a not-found page here, never '//evil.example').
      const back = new URL(href!, 'http://localhost:3300').searchParams.get('return_to')!;
      expect(back.startsWith('/') && !back.startsWith('//') && !back.includes('\\'), hostile).toBe(true);
      expect(new URL(back, 'http://localhost:3300').origin, hostile).toBe('http://localhost:3300');

      // /bff/login itself: it goes to the sign-in host, never to the hostile address.
      const res = await request.get(`/bff/login?return_to=${encodeURIComponent(hostile)}`, { maxRedirects: 0 });
      expect([302, 303, 307], hostile).toContain(res.status());
      const location = res.headers()['location'] ?? '';
      expect(location, hostile).not.toContain('evil.example');
      expect(location, hostile).not.toMatch(/^javascript:/i);
    });
  }
});
