// P1.T10 smoke: locale routing, direction, fonts, themes and the 404 page, each checked with axe.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

async function fontLoaded(page: Page, family: string): Promise<boolean> {
  return page.evaluate(async (f) => {
    await document.fonts.ready;
    return [...document.fonts].some((face) => face.family.replace(/"/g, '') === f && face.status === 'loaded');
  }, family);
}

test('/ falls back to the region default locale', async ({ browser }) => {
  // The default Playwright browser asks for en-US; a language CarPal does not offer falls back to fa.
  const context = await browser.newContext({ locale: 'de-DE' });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page).toHaveURL(/\/fa$/);
  await context.close();
});

test('/ follows Accept-Language', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'en-US' });
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
  expect(await fontLoaded(page, 'Vazirmatn')).toBe(true);
  expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toMatch(/^"?Vazirmatn/);
  await expectNoAxeViolations(page);
});

test('/en renders left-to-right in English with Atkinson Hyperlegible Next', async ({ page }) => {
  await page.goto('/en');
  const html = page.locator('html');
  await expect(html).toHaveAttribute('lang', 'en');
  await expect(html).toHaveAttribute('dir', 'ltr');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Find the right trusted expert');
  expect(await fontLoaded(page, 'Atkinson Hyperlegible Next')).toBe(true);
  expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toMatch(/^"?Atkinson Hyperlegible Next/);
  await expectNoAxeViolations(page);
});

test('the theme links switch Daylight, Sunlight and Night', async ({ page }) => {
  await page.goto('/en');
  const html = page.locator('html');
  for (const [name, theme] of [
    ['Sunlight', 'sun'],
    ['Night', 'dark'],
    ['Daylight', 'light'],
  ] as const) {
    await page.getByRole('link', { name }).click();
    await expect(html).toHaveAttribute('data-theme', theme);
    await expect(page).toHaveURL(/\/en$/);
    await expect(page.getByRole('link', { name })).toHaveAttribute('aria-current', 'true');
    await expectNoAxeViolations(page);
  }
  // The Night theme really changes the ground colour (tokens.css).
  await page.getByRole('link', { name: 'Night' }).click();
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(12, 17, 54)');
});

test('the language link keeps the page and remembers the choice', async ({ page }) => {
  await page.goto('/fa');
  await page.getByRole('link', { name: 'English' }).click();
  await expect(page).toHaveURL(/\/en$/);
  await page.goto('/');
  await expect(page).toHaveURL(/\/en$/);
});

test('unknown pages answer a localized 404', async ({ page }) => {
  const response = await page.goto('/fa/no-such-page');
  expect(response?.status()).toBe(404);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { level: 1, name: 'صفحه پیدا نشد' })).toBeVisible();
  await expectNoAxeViolations(page);
});
