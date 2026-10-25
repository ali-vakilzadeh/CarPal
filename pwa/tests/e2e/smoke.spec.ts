// P1.T10 smoke: locale routing, direction, fonts, themes and the 404 page, each checked with axe (updated in P3 for
// the shell: theme picker in the footer, W-SYS-01 404 text).
import { expect, test, type Page } from '@playwright/test';
import { decideCookies, expectNoAxeViolations, gotoReady } from './support';

async function fontLoaded(page: Page, family: string): Promise<boolean> {
  return page.evaluate(async (f) => {
    await document.fonts.ready;
    return [...document.fonts].some((face) => face.family.replace(/"/g, '') === f && face.status === 'loaded');
  }, family);
}

test.beforeEach(async ({ context, baseURL }) => decideCookies(context, baseURL!));

test('/ falls back to the region default locale', async ({ browser, baseURL }) => {
  // The default Playwright browser asks for en-US; a language CarPal does not offer falls back to fa.
  const context = await browser.newContext({ locale: 'de-DE' });
  await decideCookies(context, baseURL!);
  const page = await context.newPage();
  await page.goto('/');
  await expect(page).toHaveURL(/\/fa$/);
  await context.close();
});

test('/ follows Accept-Language', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ locale: 'en-US' });
  await decideCookies(context, baseURL!);
  const page = await context.newPage();
  await page.goto('/');
  await expect(page).toHaveURL(/\/en$/);
  await context.close();
});

test('/fa renders right-to-left in Persian with Vazirmatn', async ({ page }) => {
  await page.goto('/fa');
  const html = page.locator('html');
  await expect(html).toHaveAttribute('lang', 'fa');
  await expect(html).toHaveAttribute('dir', 'rtl');
  await expect(html).toHaveAttribute('data-theme', 'light');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('متخصص مطمئن');
  await expect.poll(() => fontLoaded(page, 'Vazirmatn')).toBe(true);
  expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toMatch(/^"?Vazirmatn/);
  await expectNoAxeViolations(page);
});

test('/en renders left-to-right in English with Atkinson Hyperlegible Next', async ({ page }) => {
  await page.goto('/en');
  const html = page.locator('html');
  await expect(html).toHaveAttribute('lang', 'en');
  await expect(html).toHaveAttribute('dir', 'ltr');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Find the right trusted expert');
  await expect.poll(() => fontLoaded(page, 'Atkinson Hyperlegible Next')).toBe(true);
  expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toMatch(/^"?Atkinson Hyperlegible Next/);
  await expectNoAxeViolations(page);
});

test('the theme picker switches Daylight, Sunlight and Night', async ({ page }) => {
  await gotoReady(page, '/en');
  const html = page.locator('html');
  const footer = page.getByRole('contentinfo');
  for (const [name, theme] of [
    ['Sunlight', 'sun'],
    ['Night', 'dark'],
    ['Daylight', 'light'],
  ] as const) {
    await footer.getByRole('link', { name }).click();
    await expect(html).toHaveAttribute('data-theme', theme);
    await expect(footer.getByRole('link', { name })).toHaveAttribute('aria-current', 'true');
    await expectNoAxeViolations(page);
  }
  // The Night theme really changes the ground colour (tokens.css).
  await footer.getByRole('link', { name: 'Night' }).click();
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(12, 17, 54)');
});

test('the theme links work before hydration (no JavaScript needed)', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  await decideCookies(context, baseURL!);
  const page = await context.newPage();
  await page.goto('/en');
  await page.getByRole('contentinfo').getByRole('link', { name: 'Sunlight' }).click();
  await expect(page).toHaveURL(/\/en$/);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'sun');
  await context.close();
});

test('the language link keeps the page and remembers the choice', async ({ page }) => {
  await page.goto('/fa');
  await page.getByRole('banner').getByRole('link', { name: 'English' }).click();
  await expect(page).toHaveURL(/\/en$/);
  await page.goto('/');
  await expect(page).toHaveURL(/\/en$/);
});

test('unknown pages answer a localized 404', async ({ page }) => {
  const response = await page.goto('/fa/no-such-page');
  expect(response?.status()).toBe(404);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { level: 1, name: 'این صفحه وجود ندارد' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'جستجو در کارپال' })).toHaveAttribute('href', '/fa#search');
  await expectNoAxeViolations(page);
});
