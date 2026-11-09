// AC1 smoke (AC1.T6): language and direction without a locale segment, fonts, the three themes, the environment
// badge, the security headers and the 404 page, each checked with axe.
import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations, gotoReady } from './support';

async function fontLoaded(page: Page, family: string): Promise<boolean> {
  return page.evaluate(async (f) => {
    await document.fonts.ready;
    return [...document.fonts].some((face) => face.family.replace(/"/g, '') === f && face.status === 'loaded');
  }, family);
}

test('falls back to Persian, right to left, for a language the console does not offer', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'de-DE' });
  const page = await context.newPage();
  await gotoReady(page, '/');
  const html = page.locator('html');
  await expect(html).toHaveAttribute('lang', 'fa');
  await expect(html).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('کنسول مدیریت');
  await expect(page.getByTestId('env-badge')).toContainText('توسعه');
  await expect.poll(() => fontLoaded(page, 'Vazirmatn')).toBe(true);
  await expectNoAxeViolations(page);
  await context.close();
});

test('renders English left to right with the environment badge and the admin contract', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'en-US' });
  const page = await context.newPage();
  await gotoReady(page, '/');
  const html = page.locator('html');
  await expect(html).toHaveAttribute('lang', 'en');
  await expect(html).toHaveAttribute('dir', 'ltr');
  await expect(page.getByTestId('env-badge')).toContainText('DEV');
  await expect(page.getByTestId('contract-line')).toHaveText('Admin contract 1.2.0: 67 operations');
  await expect.poll(() => fontLoaded(page, 'Atkinson Hyperlegible Next')).toBe(true);
  await expectNoAxeViolations(page);
  await context.close();
});

test('the language link switches the page and remembers the choice', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'en-US' });
  const page = await context.newPage();
  await gotoReady(page, '/');
  await page.getByRole('link', { name: 'فارسی' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  const cookies = await context.cookies();
  expect(cookies.find((c) => c.name === 'cpa_locale')?.value).toBe('fa');
  await context.close();
});

test('the theme links switch Daylight, Sunlight and Night, without JavaScript', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'en-US', javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto('/');
  const html = page.locator('html');
  for (const [name, theme] of [
    ['Sunlight', 'sun'],
    ['Night', 'dark'],
    ['Daylight', 'light'],
  ] as const) {
    await page.getByRole('link', { name, exact: true }).click();
    await expect(html).toHaveAttribute('data-theme', theme);
    await expect(page.getByRole('link', { name, exact: true })).toHaveAttribute('aria-current', 'true');
  }
  await context.close();
});

test('every page answers no-store, noindex and no framing', async ({ request }) => {
  const response = await request.get('/');
  const h = response.headers();
  expect(h['cache-control']).toBe('private, no-store');
  expect(h['x-robots-tag']).toBe('noindex, nofollow');
  expect(h['x-frame-options']).toBe('DENY');
  expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(h['content-security-policy']).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
});

test('unknown pages answer a 404 inside the console frame', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'fa-IR' });
  const page = await context.newPage();
  const response = await page.goto('/no-such-page');
  expect(response?.status()).toBe(404);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { level: 1, name: 'این صفحه وجود ندارد' })).toBeVisible();
  await expect(page.getByTestId('env-badge')).toBeVisible();
  await expectNoAxeViolations(page);
  await context.close();
});
