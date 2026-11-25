// AC15.T2: the accessibility sweep of the built console (method of PWA P13.T2, Docs/23 principles), against the live
// backend (strict for the acceptance run).
//   - axe on every route in both directions (EN ltr, FA rtl) and all three themes (Daylight, Sunlight, Night): the
//     pages outside the console as a visitor; every section of a platform administrator plus their account security
//     page, a user and an organization opened without a purpose, an unknown page and a section they may not open;
//     the disputes queue as a moderator (administrators do not see it). The theme is the cpa_theme cookie; the
//     administrator pages run as one test per language and theme, each with its own sign-in.
//   - on every page: tables and charts carry an accessible name (screen readers), badges and chips say what they mean
//     in words (colour never alone), and the page never scrolls sideways.
//   - keyboard only: the whole sign-in with a new security key, the skip link, a section from the navigation, the
//     shortcut list (? and Escape), and a table row chosen with J.
//   - reduced motion: no running animation and no smooth scrolling when the device asks for less motion.
// Needs backend `pnpm int:env backend` (strict) and the console's settings (README "End-to-end tests").
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { addSecurityKey, createStaff, lastCode, requireBackend, signInAs, STAFF_PASSWORD } from './staff';
import { expectNoAxeViolations, gotoReady } from './support';

type Locale = 'en' | 'fa';
type Dict = Record<string, unknown>;
const dict = (l: Locale) =>
  (JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'src', 'lib', 'i18n', 'locales', `${l}.json`), 'utf8')) as Dict)
    .admin as Dict;
const DICT = { en: dict('en'), fa: dict('fa') };
const say = (l: Locale, key: string) => key.split('.').reduce<unknown>((o, k) => (o as Dict)[k], DICT[l]) as string;

test.beforeAll(requireBackend);

const THEMES = ['light', 'sun', 'dark'] as const;
type Theme = (typeof THEMES)[number];
const NO_ID = '00000000-0000-4000-8000-000000000000';

/** Every page an administrator can reach (their sections, src/features/shell/sections.ts), plus the edge states. */
const ADMIN_ROUTES = [
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
  // AC14-2: the new tabs and views, and My decisions (no permission for an administrator).
  '/plans?tab=assignments',
  '/plans?tab=requests',
  '/orgs?possible_duplicate=true',
  '/decisions',
  `/users/${NO_ID}`,
  `/orgs/${NO_ID}`,
  '/disputes',
  '/no-such-page',
];

async function setTheme(context: BrowserContext, baseURL: string, theme: Theme) {
  await context.addCookies([{ name: 'cpa_theme', value: theme, url: baseURL }]);
}

/** Tables and charts have an accessible name; badges and chips carry words; nothing scrolls sideways. */
async function expectReadable(page: Page, where: string) {
  const problems = await page.evaluate(() => {
    const named = (e: Element) =>
      !!(
        e.getAttribute('aria-label')?.trim() ||
        (e.getAttribute('aria-labelledby') ?? '')
          .split(' ')
          .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
          .join('')
      );
    const visible = (e: Element) => (e as HTMLElement).offsetParent !== null || e.getClientRects().length > 0;
    const out: string[] = [];
    for (const t of document.querySelectorAll('table'))
      if (visible(t) && !(t.querySelector('caption')?.textContent?.trim() || named(t)))
        out.push(`table without a name: ${t.outerHTML.slice(0, 80)}`);
    for (const f of document.querySelectorAll('figure'))
      if (visible(f) && !(f.querySelector('figcaption')?.textContent?.trim() || named(f)))
        out.push(`chart without a name: ${f.outerHTML.slice(0, 80)}`);
    for (const i of document.querySelectorAll('[role="img"]'))
      if (visible(i) && !named(i) && !i.getAttribute('title')) out.push(`image without a name: ${i.outerHTML.slice(0, 80)}`);
    for (const s of document.querySelectorAll('svg:not([aria-hidden="true"])'))
      if (visible(s) && !s.closest('[role="img"],[aria-hidden="true"]') && !named(s) && s.getAttribute('role') !== 'presentation')
        out.push(`svg exposed without a name: ${s.outerHTML.slice(0, 80)}`);
    for (const b of document.querySelectorAll('.cp-badge, .cp-chip, .adm-chip, .adm-tax-chip, .adm-entity-chip'))
      if (visible(b) && !(b.textContent?.trim() || named(b) || b.getAttribute('title')))
        out.push(`colour alone: ${b.outerHTML.slice(0, 80)}`);
    const root = document.documentElement;
    if (root.scrollWidth > root.clientWidth + 1) out.push(`scrolls sideways: ${root.scrollWidth} > ${root.clientWidth}`);
    return out;
  });
  expect(problems, where).toEqual([]);
}

async function sweep(page: Page, path: string, theme: Theme) {
  await gotoReady(page, path);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  // Settle the page's first reads (tables, widgets, charts) before the check.
  await expect(page.locator('[data-state="loading"]')).toHaveCount(0, { timeout: 45_000 });
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  await expectNoAxeViolations(page);
  await expectReadable(page, path);
}

const contextFor = (l: Locale) => (l === 'fa' ? { locale: 'fa-IR' } : {});

for (const l of ['en', 'fa'] as const) {
  const dir = l === 'fa' ? 'rtl' : 'ltr';

  test(`axe on the pages outside the console in ${l} (${dir}), three themes`, async ({ browser, baseURL }) => {
    test.setTimeout(180_000);
    const ctx = await browser.newContext(contextFor(l));
    const page = await ctx.newPage();
    for (const theme of THEMES) {
      await setTheme(ctx, baseURL!, theme);
      await test.step(`${theme}: sign-in`, async () => {
        // A console page without a session starts a sign-in (the page with its interaction).
        await page.goto('/approvals');
        await page.waitForURL(/\/id\/signin\?/);
        await page.locator('html[data-hydrated="true"]').waitFor({ state: 'attached' });
        await expect(page.locator('html')).toHaveAttribute('dir', dir);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await expectNoAxeViolations(page);
        await expectReadable(page, 'sign-in');
      });
      for (const path of [
        '/id/signin',
        '/id/signed-out',
        '/id/signed-out?reason=idle&return_to=%2Fusers',
        '/id/signed-out?reason=not_staff',
      ])
        await test.step(`${theme}: ${path}`, async () => {
          await gotoReady(page, path);
          await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
          await expectNoAxeViolations(page);
          await expectReadable(page, path);
        });
    }
    await ctx.close();
  });

  // One test per theme: three shorter tests spread over the workers instead of one 11-minute test that holds a worker
  // while the sign-in-heavy suites wait (a timing failure in recovery.spec.ts during the first full AC15 run).
  for (const theme of THEMES)
    test(`axe on every administrator page in ${l} (${dir}), ${theme} theme`, async ({ browser, baseURL }) => {
      test.setTimeout(600_000);
      const ctx = await browser.newContext(contextFor(l));
      await setTheme(ctx, baseURL!, theme);
      const page = await ctx.newPage();
      await signInAs(ctx, page, ['ADM'], { locale: l });
      await expect(page.locator('html')).toHaveAttribute('dir', dir);
      for (const path of ADMIN_ROUTES) await test.step(path, () => sweep(page, path, theme));
      await ctx.close();
    });

  test(`axe on the disputes queue as a moderator in ${l} (${dir}), three themes`, async ({ browser, baseURL }) => {
    test.setTimeout(300_000);
    const ctx = await browser.newContext(contextFor(l));
    const page = await ctx.newPage();
    await signInAs(ctx, page, ['MOD'], { locale: l });
    for (const theme of THEMES) {
      await setTheme(ctx, baseURL!, theme);
      await test.step(`${theme}: /disputes`, () => sweep(page, '/disputes', theme));
    }
    await ctx.close();
  });
}

/** The focused element's accessible text. */
function focusedName(page: Page) {
  return page.evaluate(() => {
    const e = document.activeElement as HTMLElement | null;
    if (!e) return '';
    const byId = (e.getAttribute('aria-labelledby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    const labels = (e as HTMLInputElement).labels ? [...(e as HTMLInputElement).labels!].map((x) => x.textContent ?? '').join(' ') : '';
    return (e.getAttribute('aria-label') || byId.trim() || labels || e.textContent || '').replace(/\s+/g, ' ').trim();
  });
}

/** Tab until the focused element's accessible text matches (no mouse). */
async function tabTo(page: Page, name: string | RegExp, max = 60) {
  const want = typeof name === 'string' ? new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) : name;
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    if (want.test(await focusedName(page))) return;
  }
  throw new Error(`Tab never reached ${String(name)}`);
}

test('keyboard only: sign in with a new key, skip link, a section, the shortcut list, a list row with J', async ({ browser }) => {
  test.setTimeout(300_000);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const email = createStaff(['ADM']);
  await addSecurityKey(ctx, page);

  // The sign-in, Tab and Enter only (the browser's key prompt answers by itself: Chrome's virtual authenticator).
  await page.goto('/');
  await page.waitForURL(/\/id\/signin\?/);
  await page.locator('html[data-hydrated="true"]').waitFor({ state: 'attached' });
  await tabTo(page, /Work email/);
  await page.keyboard.type(email);
  await tabTo(page, /^Password/);
  await page.keyboard.type(STAFF_PASSWORD);
  await page.keyboard.press('Enter');
  await page.getByLabel('Code from the email').waitFor({ timeout: 60_000 });
  await tabTo(page, /Code from the email/);
  await page.keyboard.type(await lastCode(email));
  await tabTo(page, 'Create security key');
  await page.keyboard.press('Enter');
  await page.getByTestId('recovery-codes').waitFor({ timeout: 60_000 });
  await tabTo(page, 'I have stored them');
  await page.keyboard.press('Space');
  await tabTo(page, 'Continue');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Use security key' }).waitFor({ timeout: 60_000 });
  await tabTo(page, 'Use security key');
  await page.keyboard.press('Enter');
  await page.waitForURL((u) => u.pathname === '/', { timeout: 60_000 });
  await page.locator('html[data-hydrated="true"]').waitFor({ state: 'attached' });
  await expect(page.getByRole('heading', { level: 1, name: 'My work' })).toBeVisible();

  // The first Tab reaches the skip link; it moves the focus to the main area.
  await page.locator('body').focus();
  await page.keyboard.press('Tab');
  expect(await focusedName(page)).toBe('Skip to content');
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();

  // A section from the navigation.
  await page.locator('body').focus();
  await tabTo(page, 'Feature flags', 80);
  await page.keyboard.press('Enter');
  await page.waitForURL((u) => u.pathname === '/flags');
  await expect(page.locator('[data-state="loading"]')).toHaveCount(0, { timeout: 45_000 });

  // The shortcut list opens with ? and closes with Escape.
  await page.locator('#main').focus();
  await page.keyboard.press('Shift+Slash');
  const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(help).toBeVisible();
  await expectNoAxeViolations(page);
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();

  // J chooses the first row of the list (a case layout: the list and the open item) and moves the focus to it.
  await page.locator('#main').focus();
  await page.keyboard.press('j');
  const first = page.locator('button[data-row-button]').first();
  await expect(first).toBeFocused();
  await expect(first).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('j');
  await expect(page.locator('button[data-row-button]').nth(1)).toBeFocused();
  await ctx.close();
});

test('reduced motion: no running animations and no smooth scrolling', async ({ browser }) => {
  test.setTimeout(240_000);
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await signInAs(ctx, page, ['ADM']);
  for (const path of ['/', '/approvals', '/analytics', '/audit', '/flags', '/staff']) {
    await gotoReady(page, path);
    await expect(page.locator('[data-state="loading"]')).toHaveCount(0, { timeout: 45_000 });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
    const state = await page.evaluate(() => ({
      running: document
        .getAnimations()
        .filter((a) => a.playState === 'running')
        .map((a) => (a.effect as KeyframeEffect | null)?.target?.toString() ?? 'animation'),
      scroll: getComputedStyle(document.documentElement).scrollBehavior,
    }));
    expect(state.running, path).toEqual([]);
    expect(state.scroll, path).not.toBe('smooth');
  }
  // The shortcut list opens without a transition too.
  await page.keyboard.press('Shift+Slash');
  await expect(page.getByRole('dialog', { name: say('en', 'shell.shortcuts.title') })).toBeVisible();
  expect(await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length)).toBe(0);
  await ctx.close();
});
