// AC15.T4: performance of the console against the live backend (strict for the acceptance run), method of PWA P13.T3:
// Playwright + Chrome DevTools throttling and the browser's own performance entries, no new dependency.
// Profile: an office desktop like Lighthouse's desktop preset (Desktop Chrome, 1280 × 720, no CPU slowdown, 10 Mbps
// down / 5 Mbps up / 40 ms RTT), cache on (staff come back to the console all day); the session is warm. A slower PC:
// CARPAL_PERF_CPU=4 (recorded for reference; under a CPU slowdown Playwright's own in-page checks slow down too, so
// the timings that matter are taken inside the page with animation frames, not with locator polling).
//   - routes: the time from navigation until every table and widget has its data, LCP and CLS (and what moved), the
//     JavaScript the page runs, the number of API reads and the slowest one (server time, to tell a slow backend from a
//     slow page) — for the dashboard and the busiest queues and records;
//   - a large queue through paging: the staff directory (2,000+ members on the development database, BR-43) read page
//     by page with Next until 1,000+ members passed through the table;
//   - the keyboard on a real page of 100 rows: how fast J moves the focus and shows the selection;
//   - table rendering under stress: one table with 1,000 rows (the real list answer, repeated with new ids, served by
//     page.route; the console never pages more than 100), and J through it (recorded, not judged);
//   - the dashboard refresh: the next minute's background reads (CarPal-Background, D-102), how long the round takes
//     and that nothing on screen shifts.
// Budgets (recorded in the AC15 report): route ready ≤ 3 s and LCP ≤ 2.5 s, CLS ≤ 0.1; a page of 100 rows ≤ 1.5 s;
// on a page of 100 rows J → focus ≤ 250 ms and J → the selection shown ≤ 1 s (medians; the slowest is recorded);
// 1,000 rows on screen ≤ 2 s after the answer; the dashboard refresh round ≤ 2 s with CLS 0.
// Misses are soft failures (every number is still recorded); the measurements are attached as perf-*.json and printed.
// Run alone with `pnpm e2e:perf` (one worker); the full `playwright test` run skips it.
import { expect, test, type BrowserContext, type CDPSession, type Page, type Request } from '@playwright/test';
import { requireBackend, signInAs } from './staff';
import { gotoReady } from './support';

// Not serial: a missed budget (a soft failure) must not skip the other measurements. One worker keeps one browser; after
// a failed test the worker restarts and beforeAll signs in again.
test.describe.configure({ timeout: 600_000 });

const CPU = Number(process.env.CARPAL_PERF_CPU ?? 1);

let ctx: BrowserContext;
let page: Page;
let cdp: CDPSession;

test.beforeAll(async ({ browser }, info) => {
  if (info.config.workers > 1) return;
  test.setTimeout(240_000);
  await requireBackend();
  ctx = await browser.newContext();
  page = await ctx.newPage();
  await signInAs(ctx, page, ['ADM']);
  cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 40,
    downloadThroughput: (10 * 1024 * 1024) / 8,
    uploadThroughput: (5 * 1024 * 1024) / 8,
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
});

test.afterAll(async () => {
  await ctx?.close();
});

test.beforeEach(() => {
  test.skip(test.info().config.workers > 1, 'performance runs alone: `pnpm e2e:perf`');
});

async function record(name: string, data: Record<string, unknown>) {
  data = { cpu_slowdown: CPU, ...data };
  console.log(`perf ${name}: ${JSON.stringify(data)}`);
  await test.info().attach(`perf-${name}.json`, { body: JSON.stringify(data, null, 2), contentType: 'application/json' });
}

/** LCP and CLS since the page loaded (the buffered entries of the browser), the elements that moved, and the JavaScript
 * the page runs (decoded size: the browser cache makes the transferred size 0 on a warm visit). */
async function vitals(p: Page) {
  return p.evaluate(
    () =>
      new Promise<{ lcp: number; cls: number; js_kb: number; shifted: string[] }>((resolve) => {
        let lcp = 0;
        let cls = 0;
        const shifted = new Set<string>();
        const describe = (n: Node | null) => {
          const e = n instanceof Element ? n : n?.parentElement;
          if (!e) return '?';
          const at = e.closest('[data-widget],[data-queue],[data-table],[data-testid]');
          const tag = at
            ? (['data-widget', 'data-queue', 'data-table', 'data-testid']
                .map((a) => (at.getAttribute(a) ? `${a}=${at.getAttribute(a)}` : ''))
                .find(Boolean) ?? '')
            : '';
          return `${e.tagName.toLowerCase()}.${String(e.className).split(' ')[0]}${tag ? ` in ${tag}` : ''}`;
        };
        new PerformanceObserver((l) => {
          for (const e of l.getEntries()) lcp = Math.max(lcp, e.startTime);
        }).observe({ type: 'largest-contentful-paint', buffered: true });
        new PerformanceObserver((l) => {
          for (const e of l.getEntries() as (PerformanceEntry & {
            value: number;
            hadRecentInput: boolean;
            sources?: { node: Node | null }[];
          })[])
            if (!e.hadRecentInput) {
              cls += e.value;
              if (e.value > 0.01) for (const src of e.sources ?? []) shifted.add(`${describe(src.node)} (${e.value.toFixed(3)})`);
            }
        }).observe({ type: 'layout-shift', buffered: true });
        const js = performance
          .getEntriesByType('resource')
          .filter((r) => (r as PerformanceResourceTiming).initiatorType === 'script')
          .reduce((s, r) => s + (r as PerformanceResourceTiming).decodedBodySize, 0);
        setTimeout(
          () =>
            resolve({
              lcp: Math.round(lcp),
              cls: Math.round(cls * 1000) / 1000,
              js_kb: Math.round(js / 1024),
              shifted: [...shifted].slice(0, 8),
            }),
          300,
        );
      }),
  );
}

/** The admin reads a page makes and how long each took (request start to the end of the answer: the BFF and the
 * backend, without the browser's rendering), to tell a slow server from a slow page. */
function readTimes(p: Page) {
  const reads: { url: string; ms: number }[] = [];
  const on = (r: Request) => {
    const u = new URL(r.url());
    if (!u.pathname.startsWith('/api/v1/admin/')) return;
    const t = r.timing();
    reads.push({ url: u.pathname, ms: Math.round(t.responseEnd) });
  };
  p.on('requestfinished', on);
  return {
    reads,
    stop: () => p.off('requestfinished', on),
    slowest: () => [...reads].sort((a, b) => b.ms - a.ms)[0] ?? null,
  };
}

const ready = (p: Page) => expect(p.locator('[data-state="loading"]')).toHaveCount(0, { timeout: 60_000 });

const ROUTES = ['/', '/approvals', '/content', '/support', '/users', '/orgs', '/audit', '/analytics', '/staff', '/flags', '/verification'];

test('routes: ready time, LCP, CLS, JavaScript and API reads @perf', async () => {
  const rows: Record<string, unknown>[] = [];
  for (const path of ROUTES) {
    await gotoReady(page, path); // warm: the route's code in the browser cache, as on any later visit
    await ready(page);
    const reads = readTimes(page);
    const start = Date.now();
    await page.goto(path);
    await page.locator('html[data-hydrated="true"]').waitFor({ state: 'attached' });
    await ready(page);
    const readyMs = Date.now() - start;
    const v = await vitals(page);
    reads.stop();
    rows.push({ path, ready_ms: readyMs, ...v, api_reads: reads.reads.length, slowest_read: reads.slowest() });
    // BR-36: admin.verifications_queue is slow on a database full of test data (backend N+1); recorded, not judged.
    if (path !== '/verification') expect.soft(readyMs, `${path} ready`).toBeLessThanOrEqual(3_000);
    expect.soft(v.lcp, `${path} LCP`).toBeLessThanOrEqual(2_500);
    expect.soft(v.cls, `${path} CLS`).toBeLessThanOrEqual(0.1);
  }
  await record('routes', { rows });
});

test('a large queue through paging: 1,000+ staff members, 100 a page @perf', async () => {
  await gotoReady(page, '/staff');
  await ready(page);
  const table = page.locator('[data-table="staff"] tbody tr');
  const times: number[] = [];
  const server: number[] = [];
  let seen = await table.count();
  // Next is the last button of the table's paging bar (CSS, not a role query: see the profile note above).
  const next = page.locator('[data-table="staff"] .adm-table-paging button').last();
  while (seen < 1_000) {
    test.skip(!(await next.isEnabled()), `only ${seen} staff members on this database`);
    const reads = readTimes(page);
    // In the page: from the click until the first frame that shows the next page with no table loading.
    const ms = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const firstRow = () => document.querySelector('[data-table="staff"] tbody tr')?.getAttribute('data-row');
          const before = firstRow();
          const t0 = performance.now();
          document.querySelector<HTMLButtonElement>('[data-table="staff"] .adm-table-paging button:last-of-type')!.click();
          const check = () => {
            if (firstRow() && firstRow() !== before && !document.querySelector('[data-state="loading"]'))
              requestAnimationFrame(() => resolve(Math.round(performance.now() - t0)));
            else requestAnimationFrame(check);
          };
          requestAnimationFrame(check);
        }),
    );
    await ready(page);
    times.push(ms);
    reads.stop();
    server.push(reads.reads.filter((r) => r.url === '/api/v1/admin/staff').reduce((m, r) => Math.max(m, r.ms), 0));
    seen += await table.count();
  }
  const sorted = [...times].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
  await record('paging', {
    pages: times.length + 1,
    members_seen: seen,
    page_ms: times,
    staff_list_ms: server,
    median_ms: sorted[sorted.length >> 1],
    p95_ms: p95,
  });
  expect(seen).toBeGreaterThanOrEqual(1_000);
  expect.soft(p95, 'a page of 100 rows (p95)').toBeLessThanOrEqual(1_500);
});

/** J ten times on the staff table: the time until the focus moved, and until the page shows the selection (the URL
 * changes, the rows render again, the member opens). */
async function jThrough(p: Page) {
  await p.locator('#main').focus();
  const focus: number[] = [];
  const shown: number[] = [];
  const rowButton = (i: number) => p.locator('[data-table="staff"] button[data-row-button]').nth(i);
  for (let i = 0; i < 10; i++) {
    const t0 = Date.now();
    await p.keyboard.press('j');
    await expect(rowButton(i)).toBeFocused();
    focus.push(Date.now() - t0);
    await expect(rowButton(i)).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });
    shown.push(Date.now() - t0);
  }
  // Ten presses without waiting (a person holding J): each moves on one row, even before the page catches up.
  for (let i = 0; i < 10; i++) await p.keyboard.press('j');
  await expect(rowButton(19)).toBeFocused();
  await expect(rowButton(19)).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });
  // The first press also opens the member panel; the budget is for moving on (presses 2-10): their median, with the
  // slowest recorded (one press can meet the panel's own first render).
  const median = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 1]!;
  const on = { focus: focus.slice(1), shown: shown.slice(1) };
  return {
    focus,
    shown,
    focusMedian: median(on.focus),
    focusMax: Math.max(...on.focus),
    shownMedian: median(on.shown),
    shownMax: Math.max(...on.shown),
  };
}

test('the keyboard on a real page of 100 rows @perf', async () => {
  await gotoReady(page, '/staff');
  await ready(page);
  await expect(page.locator('[data-table="staff"] tbody tr')).toHaveCount(100);
  const j = await jThrough(page);
  await record('keyboard-100', {
    rows: 100,
    j_focus_ms: j.focus,
    j_focus_median_ms: j.focusMedian,
    j_focus_max_ms: j.focusMax,
    j_selection_shown_ms: j.shown,
    j_selection_shown_median_ms: j.shownMedian,
    j_selection_shown_max_ms: j.shownMax,
  });
  expect.soft(j.focusMedian, 'J → focus (median)').toBeLessThanOrEqual(250);
  expect.soft(j.shownMedian, 'J → the selection shown (median)').toBeLessThanOrEqual(1_000);
});

test('table rendering: 1,000 rows on one page and the keyboard through them @perf', async () => {
  // The real answer's shape: the first page of the directory, its members repeated under new ids.
  await gotoReady(page, '/staff');
  await ready(page);
  const real = (await page.evaluate(async () => (await fetch('/api/v1/admin/staff?limit=100')).json())) as {
    items: Record<string, unknown>[];
  };
  expect(real.items.length).toBeGreaterThan(0);
  const items = Array.from({ length: 1_000 }, (_, i) => ({
    ...real.items[i % real.items.length],
    user_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  }));
  let served = 0;
  await page.route('**/api/v1/admin/staff?*', async (route) => {
    served = Date.now();
    await route.fulfill({ json: { items, next_cursor: null } });
  });
  const start = Date.now();
  await page.goto('/staff');
  const rows = page.locator('[data-table="staff"] tbody tr');
  await expect(rows).toHaveCount(1_000, { timeout: 60_000 });
  const shown = Date.now();
  await ready(page);

  // J through 1,000 rows: every selection renders all of them again (recorded, not judged: no page holds 1,000).
  const j = await jThrough(page);
  await page.unroute('**/api/v1/admin/staff?*');
  await record('table-1000', {
    rows: 1_000,
    render_ms: shown - served,
    from_navigation_ms: shown - start,
    j_focus_ms: j.focus,
    j_focus_median_ms: j.focusMedian,
    j_focus_max_ms: j.focusMax,
    j_selection_shown_ms: j.shown,
    j_selection_shown_median_ms: j.shownMedian,
    j_selection_shown_max_ms: j.shownMax,
  });
  expect.soft(shown - served, '1,000 rows on screen after the answer').toBeLessThanOrEqual(2_000);
});

test('dashboard refresh: the next minute’s background reads @perf', async () => {
  test.setTimeout(240_000);
  await gotoReady(page, '/');
  await ready(page);
  const before = await vitals(page);
  // Watch the next round of background reads (WORK_REFRESH_MS = 60 s, src/lib/work/summary.ts).
  await page.evaluate(() => {
    const w = window as unknown as { __cls: number };
    w.__cls = 0;
    new PerformanceObserver((l) => {
      for (const e of l.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[])
        if (!e.hadRecentInput) w.__cls += e.value;
    }).observe({ type: 'layout-shift' });
  });
  const round: { url: string; start: number; end: number; background: boolean }[] = [];
  page.on('requestfinished', async (r) => {
    const url = new URL(r.url());
    if (!url.pathname.startsWith('/api/v1/admin/')) return;
    const t = r.timing();
    round.push({
      url: url.pathname,
      start: t.startTime,
      end: t.startTime + t.responseEnd,
      background: !!(await r.allHeaders())['carpal-background'],
    });
  });
  await expect.poll(() => round.length, { timeout: 90_000, intervals: [1_000] }).toBeGreaterThan(0);
  await page.waitForTimeout(5_000); // the rest of the round
  await ready(page);
  const first = Math.min(...round.map((r) => r.start));
  const last = Math.max(...round.map((r) => r.end));
  const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
  await record('dashboard-refresh', {
    load: before,
    reads: round.length,
    background: round.filter((r) => r.background).length,
    round_ms: Math.round(last - first),
    slowest: round
      .sort((a, b) => b.end - b.start - (a.end - a.start))
      .slice(0, 3)
      .map((r) => ({ url: r.url, ms: Math.round(r.end - r.start) })),
    cls_during_refresh: Math.round(cls * 1000) / 1000,
  });
  expect(
    round.every((r) => r.background),
    'every refresh read is a background read (D-102)',
  ).toBe(true);
  expect.soft(last - first, 'refresh round').toBeLessThanOrEqual(2_000);
  expect.soft(cls, 'no layout shift during the refresh').toBe(0);
});
