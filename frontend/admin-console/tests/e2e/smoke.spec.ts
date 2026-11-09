// AC1 smoke (AC1.T6), updated in AC4: every console page now needs a staff session, so the checks that need no backend
// run on the pages outside the console (the sign-in page without an interaction, the signed-out page, the 404):
// language and direction without a locale segment, fonts, the themes, the environment badge, the security headers and
// the signed-out redirect, each checked with axe.
import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations, gotoReady } from './support';

async function fontLoaded(page: Page, family: string): Promise<boolean> {
  return page.evaluate(async (f) => {
    await document.fonts.ready;
    return [...document.fonts].some((face) => face.family.replace(/"/g, '') === f && face.status === 'loaded');
  }, family);
}

test('a signed-out browser is sent to the staff sign-in, back to the same page afterwards', async ({ request }) => {
  const res = await request.get('/flags?tab=all', { maxRedirects: 0 });
  expect([303, 307]).toContain(res.status());
  expect(res.headers()['location']).toBe('/bff/login?return_to=%2Fflags%3Ftab%3Dall');
  const home = await request.get('/', { maxRedirects: 0 });
  expect(home.headers()['location']).toBe('/bff/login?return_to=%2F');
});

test('a file the browser asks for by itself never starts a sign-in (it would replace one in progress)', async ({ request }) => {
  const res = await request.get('/favicon.ico', { maxRedirects: 0 });
  expect(res.status()).toBe(404);
  expect(res.headers()['location']).toBeUndefined();
  const icon = await request.get('/icon.svg');
  expect(icon.status()).toBe(200);
});

test('a refused sign-in never loops: it shows the reason on the signed-out page', async ({ request }) => {
  const res = await request.get('/reviews?signin=not_staff', { maxRedirects: 0 });
  expect(res.headers()['location']).toBe('/id/signed-out?reason=not_staff&return_to=%2Freviews');
});

test('falls back to Persian, right to left, for a language the console does not offer', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'de-DE' });
  const page = await context.newPage();
  await gotoReady(page, '/id/signin');
  const html = page.locator('html');
  await expect(html).toHaveAttribute('lang', 'fa');
  await expect(html).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('اعتبار این صفحهٔ ورود تمام شده است');
  await expect(page.getByTestId('env-badge')).toContainText('DEV');
  await expect.poll(() => fontLoaded(page, 'Vazirmatn')).toBe(true);
  await expectNoAxeViolations(page);
  await context.close();
});

test('renders English left to right with the environment badge', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'en-US' });
  const page = await context.newPage();
  await gotoReady(page, '/id/signed-out?reason=idle&return_to=%2Fflags');
  const html = page.locator('html');
  await expect(html).toHaveAttribute('lang', 'en');
  await expect(html).toHaveAttribute('dir', 'ltr');
  await expect(page.getByTestId('env-badge')).toContainText('DEV');
  await expect(page.getByRole('heading', { level: 1, name: 'You were signed out' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in again' })).toHaveAttribute('href', '/bff/login?return_to=%2Fflags');
  await expect.poll(() => fontLoaded(page, 'Atkinson Hyperlegible Next')).toBe(true);
  await expectNoAxeViolations(page);
  await context.close();
});

test('the language link switches the page, keeps its query and remembers the choice', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'en-US' });
  const page = await context.newPage();
  await gotoReady(page, '/id/signed-out?reason=logout');
  await page.getByRole('link', { name: 'فارسی' }).click();
  await expect(page).toHaveURL(/\/id\/signed-out\?reason=logout$/);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { level: 1, name: 'خارج شدید' })).toBeVisible();
  const cookies = await context.cookies();
  expect(cookies.find((c) => c.name === 'cpa_locale')?.value).toBe('fa');
  await context.close();
});

test('the theme parameter switches Daylight, Sunlight and Night, without JavaScript', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'en-US', javaScriptEnabled: false });
  const page = await context.newPage();
  const html = page.locator('html');
  for (const theme of ['sun', 'dark', 'light'] as const) {
    await page.goto(`/id/signed-out?theme=${theme}`);
    await expect(page).toHaveURL(/\/id\/signed-out$/);
    await expect(html).toHaveAttribute('data-theme', theme);
  }
  await context.close();
});

test('every page answers no-store, noindex and no framing', async ({ request }) => {
  for (const path of ['/id/signin', '/id/signed-out']) {
    const h = (await request.get(path)).headers();
    expect(h['cache-control']).toBe('private, no-store');
    expect(h['x-robots-tag']).toBe('noindex, nofollow');
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(h['content-security-policy']).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
    expect(h['permissions-policy']).toContain('publickey-credentials-get=(self)');
  }
});

test('unknown pages outside the console answer a 404 in the plain frame', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'fa-IR' });
  const page = await context.newPage();
  const response = await page.goto('/no/such-page');
  expect(response?.status()).toBe(404);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { level: 1, name: 'این صفحه وجود ندارد' })).toBeVisible();
  await expect(page.getByTestId('env-badge')).toBeVisible();
  await expectNoAxeViolations(page);
  await context.close();
});
