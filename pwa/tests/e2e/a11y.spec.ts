// P13.T2: the accessibility sweep of the built PWA (Docs/21 §7, Docs/02 WP19 acceptance).
//   - axe on every route — public pages as a guest, then the signed-in tools — in both directions (EN ltr, FA rtl) and
//     all three themes (Daylight, Sunlight, Night): one test per language × theme;
//   - colour never alone: every badge, chip and status carries a word (or an accessible name), not only a colour;
//   - keyboard only: sign in, search from the header ("/"), open a result, start Help Me — no mouse;
//   - reduced motion: no running animation and no smooth scrolling when the device asks for less motion.
import { expect, test, type Page } from '@playwright/test';
import { backendUp, createUser } from './accounts';
import { seedProvider, taxonomy, type SeededProvider } from './businesses';
import { say, signIn, type Locale } from './flows';
import { decideCookies, expectNoAxeViolations, expectNoHorizontalScroll, gotoReady, setTheme } from './support';

test.describe.configure({ mode: 'parallel' });

const STYLE_HOST = 'https://cdn.carpal.app';
const THEMES = ['light', 'sun', 'dark'] as const;

let up = false;
let shop: SeededProvider;

test.beforeAll(async ({ playwright }) => {
  test.setTimeout(180_000);
  const request = await playwright.request.newContext();
  up = await backendUp(request);
  if (up) shop = await seedProvider(request, await taxonomy(request), { rules: false });
  await request.dispose();
});

test.beforeEach(async ({ context, baseURL, page }) => {
  test.skip(!up, 'needs the backend (`pnpm dev` in backend/)');
  await decideCookies(context, baseURL!);
  await page.route(`${STYLE_HOST}/**`, (r) => r.abort());
});

const PUBLIC = (l: Locale) => [
  `/${l}`,
  `/${l}/how-ranking-works`,
  `/${l}/privacy`,
  `/${l}/terms`,
  `/${l}/questions`,
  `/${l}/search`,
  `/${l}/map`,
  `/${l}/shop/${shop.slug}`,
  `/${l}/tehran/suspension`,
  `/${l}/offline`,
  `/${l}/no-such-page`,
];
const PRIVATE = (l: Locale) => [
  `/${l}/home`,
  `/${l}/garage`,
  `/${l}/garage/add`,
  `/${l}/appointments`,
  `/${l}/notifications`,
  `/${l}/settings`,
  `/${l}/settings/privacy`,
  `/${l}/settings/help`,
  `/${l}/activity`,
  `/${l}/saved`,
  `/${l}/questions/ask`,
  `/${l}/help`,
  `/${l}/review/${shop.slug}`,
];

/** Badges, chips and statuses say what they mean in words (or an accessible name), never by colour alone. */
async function expectNotColourAlone(page: Page) {
  const bare = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.cp-badge, .cp-chip, .cp-urgency, [class*="pwa-status"]')]
      .filter((e) => e.offsetParent !== null)
      .filter((e) => !(e.textContent?.trim() || e.getAttribute('aria-label') || e.getAttribute('title')))
      .map((e) => e.outerHTML.slice(0, 120)),
  );
  expect(bare).toEqual([]);
}

async function sweep(page: Page, path: string) {
  // An unmatched URL is the server-rendered global-not-found document: no React app, nothing to hydrate.
  const unmatched = path.includes('no-such-page');
  const res = unmatched ? await page.goto(path) : await gotoReady(page, path);
  expect(res?.status() ?? 200, path).toBe(unmatched ? 404 : 200);
  // Settle lazy parts (map canvas, client reads) before the check.
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  await expectNoAxeViolations(page);
  await expectNotColourAlone(page);
  await expectNoHorizontalScroll(page);
}

for (const l of ['en', 'fa'] as const) {
  for (const theme of THEMES) {
    test(`axe on the public routes in ${l} (${l === 'fa' ? 'rtl' : 'ltr'}), ${theme} theme`, async ({ page, context, baseURL }) => {
      test.setTimeout(300_000);
      await setTheme(context, baseURL!, theme);
      for (const path of PUBLIC(l)) await test.step(path, () => sweep(page, path));
      await gotoReady(page, `/${l}`);
      await expect(page.locator('html')).toHaveAttribute('dir', l === 'fa' ? 'rtl' : 'ltr');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    });

    test(`axe on the signed-in routes in ${l} (${l === 'fa' ? 'rtl' : 'ltr'}), ${theme} theme`, async ({
      page,
      context,
      baseURL,
      request,
    }) => {
      test.setTimeout(300_000);
      await setTheme(context, baseURL!, theme);
      await signIn(page, l, await createUser(request, { locale: l }));
      for (const path of PRIVATE(l)) await test.step(path, () => sweep(page, path));
    });
  }
}

/** Tab until the focused element's accessible text matches (no mouse). */
async function tabTo(page: Page, name: string | RegExp, max = 60) {
  const want = typeof name === 'string' ? new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) : name;
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const text = await page.evaluate(() => {
      const e = document.activeElement as HTMLElement | null;
      if (!e) return '';
      const labelled = e.getAttribute('aria-labelledby');
      const byId = labelled
        ? labelled
            .split(' ')
            .map((id) => document.getElementById(id)?.textContent ?? '')
            .join(' ')
        : '';
      const labels = (e as HTMLInputElement).labels ? [...(e as HTMLInputElement).labels!].map((x) => x.textContent ?? '').join(' ') : '';
      return (e.getAttribute('aria-label') || byId || labels || e.textContent || '').replace(/\s+/g, ' ').trim();
    });
    if (want.test(text)) return;
  }
  throw new Error(`Tab never reached ${String(name)}`);
}

test('keyboard only: sign in, search with "/", open a result, start Help Me', async ({ page, request }) => {
  test.setTimeout(180_000);
  const l: Locale = 'en';
  const user = await createUser(request, { locale: l });

  // Sign in from the header's Log in link.
  await gotoReady(page, `/${l}`);
  await tabTo(page, say(l, 'shell.header.logIn'));
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/id\/signin\?interaction_id=/);
  await page.locator('html[data-hydrated="true"]').waitFor({ state: 'attached' });
  await tabTo(page, new RegExp(say(l, 'auth.signin.identifier')));
  await page.keyboard.type(user.email);
  await tabTo(page, say(l, 'auth.signin.methodPassword'));
  await page.keyboard.press('Enter');
  await tabTo(page, new RegExp(`^${say(l, 'auth.signin.password')}`));
  await page.keyboard.type(user.password);
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/en\/onboarding\?next=/);
  await page.locator('html[data-hydrated="true"]').waitFor({ state: 'attached' });
  await tabTo(page, say(l, 'onboarding.finishLater'));
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/en(\/home)?$/);
  await page.locator('html[data-hydrated="true"]').waitFor({ state: 'attached' });

  // "/" focuses the header search; Enter searches; Tab reaches the first result; Enter opens it.
  await page.keyboard.press('/');
  await expect(page.getByRole('combobox', { name: say(l, 'shell.header.searchLabel') })).toBeFocused();
  await page.keyboard.type(shop.name);
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/search\/[0-9a-f-]{36}/, { timeout: 30_000 });
  await expect(page.locator('article.pwa-result a').first()).toBeVisible({ timeout: 30_000 });
  await page.locator('#main').focus();
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press('Tab');
    if (await page.evaluate(() => !!document.activeElement?.closest('article.pwa-result') && document.activeElement?.tagName === 'A'))
      break;
  }
  const target = await page.evaluate(() => (document.activeElement as HTMLAnchorElement).getAttribute('href'));
  expect(target).toMatch(/\/en\/(shop|parts-seller)\//);
  await page.keyboard.press('Enter');
  await page.waitForURL(`**${target}`);

  // Help Me: describe and start with the keyboard.
  await gotoReady(page, `/${l}/help`);
  await tabTo(page, new RegExp(say(l, 'help.describe.label')));
  await page.keyboard.type('Clunking over bumps from the front right since yesterday');
  await tabTo(page, say(l, 'help.describe.start'));
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/help\/[0-9a-f-]{36}\/(questions|safety)$/, { timeout: 60_000 });
  await expectNoAxeViolations(page);
});

test('reduced motion: no running animations and no smooth scrolling', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ baseURL, reducedMotion: 'reduce' });
  await decideCookies(context, baseURL!);
  const page = await context.newPage();
  await page.route(`${STYLE_HOST}/**`, (r) => r.abort());
  for (const path of ['/fa', '/en/questions', `/en/shop/${shop.slug}`, '/fa/map', '/en/privacy']) {
    await gotoReady(page, path);
    await page.waitForLoadState('networkidle').catch(() => undefined);
    const state = await page.evaluate(() => ({
      running: document.getAnimations().filter((a) => a.playState === 'running').length,
      scroll: getComputedStyle(document.documentElement).scrollBehavior,
    }));
    expect(state, path).toEqual({ running: 0, scroll: 'auto' });
  }
  await context.close();
});
