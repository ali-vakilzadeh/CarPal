// AC15.T3: right-to-left visual regression screenshots of the key screens in Persian (Daylight theme, 1280 × 720):
// the shell with the dashboard, the case layout (a list with its open item), a table, a form, charts, and the sign-in.
// The pictures must not change with the data of a shared development database or with the day: every admin read the
// screens make (GET /api/v1/admin/...) is served from a recorded set (tests/e2e/visual.fixtures.json) and the browser's
// clock is fixed, so relative times and date ranges stay the same. The staff member's name is fixed too.
//   Record (first run, or after a screen changes on purpose):
//     CARPAL_VISUAL_RECORD=1 pnpm exec playwright test tests/e2e/visual.spec.ts --update-snapshots
//   Check (every other run): the reads come from the recorded set; a read it lacks fails the test.
// Baselines are per platform (…-chromium-win32.png on the development PC); a Linux CI records its own.
// Needs backend `pnpm int:env backend` (strict) for the sign-in and the console's settings (README "End-to-end tests").
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { requireBackend, signInWithCodes } from './staff';
import { gotoReady } from './support';

test.describe.configure({ mode: 'serial', timeout: 300_000 });

const FIXTURES = join(import.meta.dirname, 'visual.fixtures.json');
const RECORD = process.env.CARPAL_VISUAL_RECORD === '1' || !existsSync(FIXTURES);
const NOW = new Date('2026-11-25T08:30:00Z');

interface Recorded {
  status: number;
  body: unknown;
}
const fixtures: Record<string, Recorded> = RECORD ? {} : (JSON.parse(readFileSync(FIXTURES, 'utf8')) as Record<string, Recorded>);
const missing: string[] = [];

/** One key per read: the path and its query, sorted. */
function keyOf(url: string): string {
  const u = new URL(url);
  const q = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  return `${u.pathname}${q.length ? `?${new URLSearchParams(q).toString()}` : ''}`;
}

let ctx: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  await requireBackend();
  ctx = await browser.newContext({ locale: 'fa-IR', viewport: { width: 1280, height: 720 }, reducedMotion: 'reduce' });
  await ctx.addCookies([{ name: 'cpa_theme', value: 'light', url: 'http://localhost:3300' }]);
  page = await ctx.newPage();
  await page.clock.setFixedTime(NOW);
  await page.route('**/api/v1/admin/**', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const key = keyOf(route.request().url());
    if (RECORD) {
      const res = await route.fetch();
      const body = res.headers()['content-type']?.includes('json') ? await res.json() : await res.text();
      fixtures[key] = { status: res.status(), body };
      return route.fulfill({ response: res });
    }
    const hit = fixtures[key];
    if (!hit) {
      missing.push(key);
      return route.fulfill({ status: 503, json: { code: 'NOT_RECORDED', key } });
    }
    return route.fulfill({ status: hit.status, json: hit.body });
  });
  await signInWithCodes(ctx, page, ['ADM'], { locale: 'fa', name: 'کارشناس نمونه' });
});

test.afterAll(async () => {
  if (RECORD && Object.keys(fixtures).length) writeFileSync(FIXTURES, `${JSON.stringify(fixtures, null, 1)}\n`);
  await ctx?.close();
});

/** Everything loaded, fonts in, no focus ring left from the last click. */
async function settle(p: Page) {
  await expect(p.locator('[data-state="loading"]')).toHaveCount(0, { timeout: 60_000 });
  await p.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  await p.evaluate(async () => {
    await document.fonts.ready;
    (document.activeElement as HTMLElement | null)?.blur();
  });
}

async function shot(path: string, name: string, before?: (p: Page) => Promise<void>) {
  await gotoReady(page, path);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await settle(page);
  if (before) {
    await before(page);
    await settle(page);
  }
  expect(missing, 'reads missing from visual.fixtures.json: record again').toEqual([]);
  await expect(page).toHaveScreenshot(name, { maxDiffPixelRatio: 0.002 });
}

test('form: the staff sign-in (rtl)', async ({ browser }) => {
  // Its own browser without a session: the page with its interaction, no admin reads.
  const signin = await browser.newContext({ locale: 'fa-IR', viewport: { width: 1280, height: 720 }, reducedMotion: 'reduce' });
  await signin.addCookies([{ name: 'cpa_theme', value: 'light', url: 'http://localhost:3300' }]);
  const p = await signin.newPage();
  await p.clock.setFixedTime(NOW);
  await p.goto('/');
  await p.waitForURL(/\/id\/signin\?/);
  await p.locator('html[data-hydrated="true"]').waitFor({ state: 'attached' });
  await expect(p.locator('html')).toHaveAttribute('dir', 'rtl');
  await settle(p);
  await expect(p).toHaveScreenshot('signin-fa.png', { maxDiffPixelRatio: 0.002 });
  await signin.close();
});

test('shell and dashboard (rtl)', async () => {
  await shot('/', 'shell-dashboard-fa.png');
});

test('case layout: a list with its open item (rtl)', async () => {
  await shot('/flags', 'case-layout-flags-fa.png', async (p) => {
    await p.locator('button[data-row-button]').first().click();
  });
});

test('table: the staff directory, a server-paged table (rtl)', async () => {
  await shot('/staff', 'table-staff-fa.png');
});

test('form: the audit log search (rtl)', async () => {
  // The audit log reads nothing until a search (every search is itself audited): the page is its search form.
  await shot('/audit', 'form-audit-search-fa.png');
});

test('form: the exchange rate (rtl)', async () => {
  await shot('/rates', 'form-rates-fa.png');
});

test('charts: analytics (rtl)', async () => {
  await shot('/analytics', 'charts-analytics-fa.png');
});
