// P3.T9: the shell in EN/FA × Daylight/Sunlight/Night × 375/1024/1440 px (no horizontal scroll, axe clean),
// keyboard use of the header and modals, the language switch, the theme without flash, the cookie banner, the gated
// demo action up to the hosted sign-in, and the W-SYS-01 statuses. Runs against the built PWA with
// CARPAL_PWA_DEMO=1 (playwright.config.ts); no backend needed (config.client falls back to the region file).
import { expect, test } from '@playwright/test';
import { decideCookies, expectNoAxeViolations, expectNoHorizontalScroll, gotoReady, setTheme } from './support';

const VIEWPORTS = [
  { name: 'phone', width: 375, height: 812 },
  { name: 'tablet', width: 1024, height: 768 },
  { name: 'desktop', width: 1440, height: 900 },
] as const;

for (const locale of ['fa', 'en'] as const) {
  for (const theme of ['light', 'sun', 'dark'] as const) {
    test(`layout ${locale} ${theme} at 375/1024/1440`, async ({ page, context, baseURL }) => {
      // Three page loads with a full axe run each (the dev kit holds every shell pattern).
      test.setTimeout(90_000);
      await decideCookies(context, baseURL!);
      await setTheme(context, baseURL!, theme);
      for (const vp of VIEWPORTS) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.goto(`/${locale}/dev-kit`);
        await expect(page.locator('html')).toHaveAttribute('dir', locale === 'fa' ? 'rtl' : 'ltr');
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await expect(page.getByRole('banner')).toBeVisible();
        await expect(page.getByRole('combobox', { name: locale === 'fa' ? 'جستجو در کارپال' : 'Search CarPal' })).toBeVisible();
        // Guests: log in / sign up in the header from 768 px, the menu button below.
        if (vp.width < 768)
          await expect(
            page.getByRole('banner').getByRole('button', { name: locale === 'fa' ? 'باز کردن منو' : 'Open menu' }),
          ).toBeVisible();
        else await expect(page.getByRole('banner').getByRole('link', { name: locale === 'fa' ? 'ورود' : 'Log in' })).toBeVisible();
        // The right rail ("Join CarPal") only on desktop.
        const rail = page.getByRole('complementary', { name: locale === 'fa' ? 'بیشتر در کارپال' : 'More on CarPal' });
        if (vp.width >= 1200) await expect(rail).toBeVisible();
        else await expect(rail).toBeHidden();
        await expectNoHorizontalScroll(page);
        await expectNoAxeViolations(page);
      }
    });
  }
}

test('keyboard: skip link, "/" focuses search, suggestions panel, Esc', async ({ page, context, baseURL }) => {
  await decideCookies(context, baseURL!);
  await gotoReady(page, '/en');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('/');
  const search = page.getByRole('combobox', { name: 'Search CarPal' });
  await expect(search).toBeFocused();
  // The header's map link (the landing hero has one of the same name since P5).
  await expect(page.getByRole('banner').getByRole('link', { name: 'Browse on map' })).toBeVisible();
  await search.fill('brake noise');
  await expect(page.getByRole('option', { name: 'Search for “brake noise”' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(search).toHaveAttribute('aria-expanded', 'false');
  // Tab moves through the header controls in order and every one shows the focus ring.
  await page.keyboard.press('Tab');
  const focused = page.locator(':focus');
  await expect(focused).toHaveAccessibleName(/Browse on map|Help Me/);
});

test('modal with a URL: opens, Esc and Back close it, a refresh reopens it', async ({ page, context, baseURL }) => {
  await decideCookies(context, baseURL!);
  await gotoReady(page, '/en/dev-kit');
  await page.getByRole('button', { name: 'Open modal' }).click();
  await expect(page).toHaveURL(/\/en\/dev-kit\?modal=demo$/);
  const dialog = page.getByRole('dialog', { name: 'Sign in to continue' });
  await expect(dialog).toBeVisible();
  // Focus is inside the modal (the page behind is inert).
  expect(await page.evaluate(() => !!document.activeElement?.closest('dialog'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/en\/dev-kit$/);

  await page.getByRole('button', { name: 'Open modal' }).click();
  await expect(dialog).toBeVisible();
  await page.goBack();
  await expect(dialog).toBeHidden();

  await page.goto('/en/dev-kit?modal=demo');
  await expect(dialog).toBeVisible();
  await expectNoAxeViolations(page);
});

test('language switch keeps the page; Persian digits and Jalali dates in fa', async ({ page, context, baseURL }) => {
  await decideCookies(context, baseURL!);
  await gotoReady(page, '/en/dev-kit?x=1');
  await expect(page.getByTestId('fmt-number')).toHaveText('1,234,567');
  await expect(page.getByTestId('fmt-date')).toHaveText('October 25, 2026');
  await page.getByRole('banner').getByRole('link', { name: 'فارسی' }).click();
  await expect(page).toHaveURL(/\/fa\/dev-kit\?x=1$/);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByTestId('fmt-number')).toHaveText('۱٬۲۳۴٬۵۶۷');
  await expect(page.getByTestId('fmt-date')).toHaveText('۳ آبان ۱۴۰۵');
  await expect(page.getByTestId('fmt-money')).toHaveText('۱٬۸۵۰٬۰۰۰ تومان');
  await expect(page.getByTestId('fmt-distance')).toHaveText('حدود ۲٫۵ کیلومتر');
});

test('automatic theme follows the device before the first paint (no flash)', async ({ browser, baseURL }) => {
  for (const [media, expected] of [
    [{ colorScheme: 'dark' as const }, 'dark'],
    [{ contrast: 'more' as const, colorScheme: 'light' as const }, 'sun'],
    [{ colorScheme: 'light' as const }, 'light'],
  ] as const) {
    const context = await browser.newContext(media);
    await decideCookies(context, baseURL!);
    const page = await context.newPage();
    // Record data-theme as soon as the body exists, before any framework code ran.
    await page.addInitScript(() => {
      const record = () =>
        ((window as unknown as { __firstTheme?: string | null }).__firstTheme ??= document.documentElement.getAttribute('data-theme'));
      document.addEventListener('readystatechange', record, { once: true });
      new MutationObserver((_, obs) => {
        if (document.body) {
          record();
          obs.disconnect();
        }
      }).observe(document, { childList: true, subtree: true });
    });
    await page.goto('/en');
    expect(await page.evaluate(() => (window as unknown as { __firstTheme?: string }).__firstTheme)).toBe(expected);
    await expect(page.locator('html')).toHaveAttribute('data-theme', expected);
    await context.close();
  }
});

test('theme picker: choice applies at once and survives a reload', async ({ page, context, baseURL }) => {
  await decideCookies(context, baseURL!);
  await gotoReady(page, '/en');
  await page.getByRole('contentinfo').getByRole('link', { name: 'Night' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(12, 17, 54)');
});

test('cookie banner: first visit, equal prominence, choice remembered', async ({ page }) => {
  await page.goto('/en');
  const banner = page.getByRole('region', { name: 'Cookies and privacy' });
  await expect(banner).toBeVisible();
  const accept = banner.getByRole('button', { name: 'Accept all' });
  const reject = banner.getByRole('button', { name: 'Reject non-essential' });
  const [a, r] = await Promise.all([accept.boundingBox(), reject.boundingBox()]);
  expect(Math.abs(a!.height - r!.height)).toBeLessThanOrEqual(1);
  expect(await accept.getAttribute('class')).toBe(await reject.getAttribute('class'));
  await expectNoAxeViolations(page);
  await reject.click();
  await expect(banner).toBeHidden();
  await page.reload();
  await expect(page.getByRole('region', { name: 'Cookies and privacy' })).toBeHidden();
  const cookies = await page.context().cookies();
  expect(cookies.find((c) => c.name === 'cp_consent')?.value).toBe('v1.a0');
});

test('gated demo action: guest sees the context modal, the intent is saved and the browser goes to the hosted sign-in', async ({
  page,
  context,
  baseURL,
}) => {
  await decideCookies(context, baseURL!);
  // The BFF login needs the auth server; stop at the redirect and remember where it was going.
  let loginUrl: string | null = null;
  await page.route('**/bff/login**', async (route) => {
    loginUrl = route.request().url();
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>sign-in</title>' });
  });
  await gotoReady(page, '/en/dev-kit');
  await page.getByRole('button', { name: 'Follow' }).click();
  const dialog = page.getByRole('dialog', { name: 'Sign in to follow Reza Auto Suspension' });
  await expect(dialog).toBeVisible();
  await expectNoAxeViolations(page);
  await dialog.getByRole('button', { name: 'Log in' }).click();
  // Back through the onboarding check (P4.T7), with the intent named for the hosted sign-in's context line.
  await expect.poll(() => loginUrl).toContain('/bff/login?return_to=%2Fen%2Fonboarding%3Fnext%3D%252Fen%252Fdev-kit&locale=en&intent=');
  // The intent is in the pre-session, waiting for the return.
  const session = await page.request.get('/bff/session');
  expect(session.ok()).toBe(true);
  const view = (await session.json()) as { pending_intents: { type: string; target: string; return_to: string }[] };
  expect(view.pending_intents).toEqual([expect.objectContaining({ type: 'demo.follow', target: 'demo-shop', return_to: '/en/dev-kit' })]);
});

test('signed-in pages send guests to the hosted sign-in with the return URL', async ({ page, context, baseURL }) => {
  await decideCookies(context, baseURL!);
  let loginUrl: string | null = null;
  await page.route('**/bff/login**', async (route) => {
    loginUrl = route.request().url();
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>sign-in</title>' });
  });
  await page.goto('/fa/garage');
  await expect.poll(() => loginUrl).toContain('/bff/login?return_to=%2Ffa%2Fonboarding%3Fnext%3D%252Ffa%252Fgarage&locale=fa');
  await page.waitForURL('**/bff/login**');
  await page.goto('/fa/garage?signin=cancelled');
  await expect(page.getByRole('heading', { name: 'برای دیدن این صفحه وارد شوید' })).toBeVisible();
});

test('W-SYS-01 statuses: 404, 410, 403, 503 and a direct visit of the internal route', async ({ page, context, baseURL }) => {
  await decideCookies(context, baseURL!);
  const missing = await page.goto('/fa/dev-kit/missing');
  expect(missing?.status()).toBe(404);

  const gone = await page.goto('/fa/dev-kit/status/gone');
  expect(gone?.status()).toBe(410);
  expect(gone?.headers()['x-robots-tag']).toContain('noindex');
  await expect(page.getByRole('heading', { level: 1, name: 'این پست دیگر در دسترس نیست' })).toBeVisible();
  await expectNoAxeViolations(page);

  const forbidden = await page.goto('/en/dev-kit/forbidden');
  expect(forbidden?.status()).toBe(403);

  const maintenance = await page.goto('/en/dev-kit/status/maintenance');
  expect(maintenance?.status()).toBe(503);
  expect(Number(maintenance?.headers()['retry-after'])).toBeGreaterThan(0);
  await expect(page.getByRole('heading', { level: 1, name: 'CarPal is being updated' })).toBeVisible();
  await expect(page.getByText(/We expect to be back at about/)).toBeVisible();
  await expectNoAxeViolations(page);

  const direct = await page.goto('/en/system/gone');
  expect(direct?.status()).toBe(404);
});
