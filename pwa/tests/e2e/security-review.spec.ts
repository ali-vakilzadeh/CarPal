// P13.T4: the security review of the BFF and the pages, in the built PWA (the P2 header, allowlist and CSRF checks are in
// security.spec.ts; the allowlist's completeness against the registry is src/server/bff/allowlist.test.ts):
//   - the browser never holds a token (storage, readable cookies, every BFF response after a sign-in);
//   - no personal data in any URL; authenticated API answers are no-store;
//   - hostile return URLs never leave the site;
//   - link tokens stay in the fragment: never in a request URL or a Referer, and they leave the address bar;
//   - every private section is no-store + noindex; preference cookies are site-wide and SameSite;
//   - no CSP / Trusted Types violation on the public pages of both languages (the CSP is enforced, so a violation
//     would break the page; the listener reports what a report-only run would have reported);
//   - the P13.T7 legal pages: texts, version, support address, the cookie banner's link.
// Run it also against a backend in strict mode (CARPAL_STRICT_AUTH=1, P13.T11): pwa/README.md "Strict mode".
import { expect, test } from '@playwright/test';
import { backendUp, createUser } from './accounts';
import { hostedSignIn, signIn } from './flows';
import { decideCookies } from './support';
import { PRIVATE_SECTIONS } from '../../src/server/security-headers';

const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;

test('signed in, the browser never holds a token; no personal data in URLs; API answers are no-store', async ({
  page,
  context,
  request,
  baseURL,
}) => {
  test.skip(!(await backendUp(request)), 'needs the backend (`pnpm dev` in backend/)');
  test.setTimeout(120_000);
  await decideCookies(context, baseURL!);
  const leaks: string[] = [];
  page.on('response', async (r) => {
    if (!r.url().startsWith(baseURL!) || !/json|text\/html/.test(r.headers()['content-type'] ?? '')) return;
    const body = await r.text().catch(() => '');
    if (JWT.test(body) || /"(access|refresh|id)_token"/.test(body)) leaks.push(r.url());
  });
  const urls: string[] = [];
  page.on('request', (r) => urls.push(r.url()));
  const user = await createUser(request);
  await signIn(page, 'en', user);
  for (const path of ['/en/home', '/en/garage', '/en/settings/security', '/en/notifications']) await page.goto(path);
  const stored = await page.evaluate(() => ({
    local: JSON.stringify({ ...localStorage }),
    session: JSON.stringify({ ...sessionStorage }),
    cookies: document.cookie,
  }));
  for (const [where, value] of Object.entries(stored)) expect(value, where).not.toMatch(JWT);
  expect(stored.cookies).not.toContain('cp_sid');
  expect(leaks).toEqual([]);
  for (const u of urls) {
    expect(u, u).not.toContain(user.email);
    expect(u, u).not.toContain(encodeURIComponent(user.email));
  }
  const me = await page.request.get('/api/v1/me');
  expect(me.status()).toBe(200);
  expect(me.headers()['cache-control']).toContain('no-store');
});

test('a hostile return URL never leaves the site', async ({ page, context, request, baseURL }) => {
  test.skip(!(await backendUp(request)), 'needs the backend (`pnpm dev` in backend/)');
  test.setTimeout(90_000);
  await decideCookies(context, baseURL!);
  const user = await createUser(request);
  await page.goto(`/bff/login?return_to=${encodeURIComponent('https://evil.example/steal')}&locale=en`);
  await hostedSignIn(page, 'en', user, { onboarding: false });
  await page.waitForURL((u) => u.origin === new URL(baseURL!).origin && !u.pathname.startsWith('/id/'), { timeout: 30_000 });
  expect(page.url()).not.toContain('evil.example');
  for (const bad of ['//evil.example', '/\\evil.example', 'javascript:alert(1)', 'https://evil.example']) {
    const res = await request.get(`/bff/login?return_to=${encodeURIComponent(bad)}`, { maxRedirects: 0 });
    expect(res.status(), bad).toBeLessThan(400);
    expect(res.headers().location ?? '', bad).not.toContain('evil.example');
  }
});

test('link tokens stay in the fragment: never in a request URL or a Referer, and they leave the address bar', async ({
  page,
  context,
  baseURL,
}) => {
  await decideCookies(context, baseURL!);
  const seen: string[] = [];
  page.on('request', (r) => seen.push(r.url(), r.headers().referer ?? ''));
  for (const type of ['pr', 'ev', 'ri', 'ci', 'cn', 'mi']) {
    await page.goto(`/l/${type}#cp_${type}_e2eSecretTokenValue0123456789abcdef`);
    await page.locator('html[data-hydrated="true"]').waitFor({ state: 'attached' });
    await expect(page).toHaveURL(new RegExp(`/l/${type}$`));
  }
  expect(seen.filter((u) => u.includes('e2eSecretTokenValue'))).toEqual([]);
});

test('every private section is no-store and noindex; preference cookies are site-wide and SameSite', async ({ request }) => {
  test.setTimeout(120_000);
  for (const section of PRIVATE_SECTIONS) {
    for (const l of ['en', 'fa']) {
      const res = await request.get(`/${l}/${section}`, { maxRedirects: 0 });
      expect(res.headers()['cache-control'], `${l}/${section}`).toContain('no-store');
      expect(res.headers()['x-robots-tag'], `${l}/${section}`).toContain('noindex');
    }
  }
  const pub = await request.get('/en/privacy');
  expect(pub.status()).toBe(200);
  expect(pub.headers()['x-robots-tag']).toBeUndefined();
  const res = await request.get('/fa');
  for (const c of (res.headers()['set-cookie'] ?? '').split('\n').filter(Boolean)) {
    expect(c, c).toMatch(/Path=\//i);
    expect(c, c).toMatch(/SameSite=(Lax|Strict)/i);
  }
});

test('no CSP or Trusted Types violation on the public pages of both languages', async ({ page, context, baseURL }) => {
  test.setTimeout(150_000);
  await decideCookies(context, baseURL!);
  const violations: string[] = [];
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) =>
      console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`),
    );
  });
  page.on('console', (m) => {
    if (m.type() === 'error' && m.text().startsWith('CSP violation')) violations.push(`${page.url()} ${m.text()}`);
  });
  await page.route('https://cdn.carpal.app/**', (r) => r.abort());
  for (const l of ['en', 'fa'])
    for (const path of [
      '',
      '/how-ranking-works',
      '/privacy',
      '/terms',
      '/questions',
      '/search',
      '/map',
      '/offline',
      '/tehran/suspension',
    ]) {
      await page.goto(`/${l}${path}`);
      await page.locator('html[data-hydrated="true"]').waitFor({ state: 'attached' });
    }
  expect(violations).toEqual([]);
});

test('legal pages: both texts, English-only note in FA, the support address, the cookie banner link, the sitemap', async ({
  page,
  context,
  baseURL,
}) => {
  await page.goto('/en/privacy');
  await expect(page.getByRole('heading', { level: 1, name: 'CarPal Privacy Policy' })).toBeVisible();
  await expect(page.locator('#section-10-4')).toContainText('Cookies');
  await expect(page.getByRole('link', { name: 'support@carpal.app' }).first()).toHaveAttribute('href', 'mailto:support@carpal.app');
  await expect(page.getByRole('region', { name: 'Cookies and privacy' }).getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute(
    'href',
    '/en/privacy#section-10-4',
  );
  await decideCookies(context, baseURL!);
  await page.goto('/fa/terms');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { level: 1, name: 'CarPal User Agreement' })).toHaveAttribute('dir', 'ltr');
  await expect(page.getByText('این متن فعلاً فقط به زبان انگلیسی در دسترس است.', { exact: false })).toBeVisible();
  await expect(page.getByRole('contentinfo').getByRole('link', { name: 'سیاست حریم خصوصی' })).toHaveAttribute('href', '/fa/privacy');
  const sitemap = await (await page.request.get('/sitemaps/pages.xml')).text();
  expect(sitemap).toContain('/en/privacy');
  expect(sitemap).toContain('/fa/terms');
});
