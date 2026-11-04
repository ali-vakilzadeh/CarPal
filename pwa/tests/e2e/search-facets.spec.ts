// P14.T6: contract 1.1.0 in the built PWA against the live backend, in EN and FA, with axe on the changed views.
// Three providers are seeded through the API in one grid cell of an otherwise empty north-east Tehran area:
//   A — warranty, open around the clock, a slot every hour (the soonest);
//   B — warranty, open around the clock, slots on one day three days ahead;
//   C — no warranty, closed all week, no slots.
// The browser runs one area search through its own BFF session (search.run with a map_center location and
// facets: true, as W-SRCH-01's "Search this area" does) and opens /<locale>/search/<session>, so every page read
// below goes through search.session_get. Checks:
//   (a) facets: the Warranty offered option shows 2 of the 3 (Verified needs a staff decision with a device-bound
//       passkey on admin-api, which an E2E run cannot make — the same server path, P14 deviation), the header shows
//       result_count, and a filter that empties the list is named first with its count_without;
//   (b) Soonest available orders A, B, C and the cards show their slots (FA: Jalali, Persian digits);
//   (c) a reload keeps the session id and sends only GET /v1/search/<id> (request log); an unknown session id runs
//       the stored request and replaces the URL;
//   (d) the map: a pin outside the area search's cards still has View and opens its profile; Open now hides C's pin
//       on the server (only_matching) and its cluster count drops; Advanced search shows MapResponse.counts.
// No search text or coordinates appear in any URL (the P6 checks).
import { randomBytes, randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page, type Request } from '@playwright/test';
import { API, backendUp } from './accounts';
import { ALWAYS_OPEN, seedProvider, taxonomy, type SeededProvider } from './businesses';
import { SSR, bff, digits, recordUrls, retire, say, ssrToken } from './flows';
import { decideCookies, expectNoAxeViolations, gotoReady } from './support';

test.describe.configure({ mode: 'serial' });

const STYLE_HOST = 'https://cdn.carpal.app';
/** The backend's cluster cell at a zoom (clustering.ts cellDegrees); at 11 the three shops share one cell. */
const cellDegrees = (zoom: number) => (360 / 2 ** zoom) * (60 / 256);
const CELL_11 = cellDegrees(11);
const SPAN = 0.004;

let up = false;
let point = { lat: 0, lng: 0 };
let shops: { a: SeededProvider; b: SeededProvider; c: SeededProvider } | undefined;

/**
 * A random point in north-east Tehran, away from every other suite's shops (tehranPoint, quietPoint), in the inner part
 * of a zoom-11 cell so the three shops (0.0016° apart) share it. Random inside the cell too: an unpublished shop of the
 * previous run stays in the lite index until its next sweep (BA-33), and it must not land in this run's small area.
 */
function cellCentre(): { lat: number; lng: number } {
  const inner = (v: number) => (Math.floor(v / CELL_11) + 0.5 + (Math.random() - 0.5) * 0.6) * CELL_11;
  const round = (v: number) => Math.round(v * 1e6) / 1e6;
  return { lat: round(inner(35.76 + Math.random() * 0.06)), lng: round(inner(51.44 + Math.random() * 0.18)) };
}
const near = (dLat: number) => ({ lat: Math.round((point.lat + dLat) * 1e6) / 1e6, lng: point.lng });

function areaViewport() {
  return {
    center: point,
    zoom: 15,
    bbox: { south: point.lat - SPAN, west: point.lng - SPAN, north: point.lat + SPAN, east: point.lng + SPAN },
  };
}
const areaRequest = () => ({
  search_mode: 'all',
  entry_point: 'search_box',
  location: { mode: 'map_center', viewport: areaViewport() },
  sort: 'best_match',
  limit: 20,
  facets: true,
});

/** Today's weekday in Tehran (0 = Sunday), as availability rules count days. */
function tehranWeekday(offsetDays = 0): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tehran', weekday: 'short' }).format(Date.now() + offsetDays * 86_400_000);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
}

/** Polls an area search until all three shops are indexed with their slots (the lite index sweeps every minute). */
async function waitArea(request: APIRequestContext) {
  const auth = await ssrToken(request);
  await expect
    .poll(
      async () => {
        const res = await request.post(`${API}/v1/search`, {
          data: { ...areaRequest(), facets: false, sort: 'soonest' },
          headers: { authorization: auth, 'carpal-client': SSR, 'accept-language': 'en' },
        });
        const body = (await res.json()) as { results?: { organization: { id: string }; next_available_slot: string | null }[] };
        const slot = (id: string) => (body.results ?? []).find((r) => r.organization.id === id);
        return !!slot(shops!.c.id) && !!slot(shops!.a.id)?.next_available_slot && !!slot(shops!.b.id)?.next_available_slot;
      },
      { timeout: 180_000, intervals: [2_000, 5_000] },
    )
    .toBe(true);
}

test.beforeAll(async ({ playwright }) => {
  test.setTimeout(300_000);
  const request = await playwright.request.newContext();
  up = await backendUp(request);
  if (!up) return;
  const n = await taxonomy(request);
  const hex = randomBytes(3).toString('hex');
  point = cellCentre();
  const inThreeDays = tehranWeekday(3);
  shops = {
    a: await seedProvider(request, n, { name: `P14 Soonest A ${hex}`, point: near(-0.0008), hours: ALWAYS_OPEN }),
    b: await seedProvider(request, n, {
      name: `P14 Later B ${hex}`,
      point: near(0),
      hours: ALWAYS_OPEN,
      ruleDays: [{ day_of_week: inThreeDays, open: '08:00', close: '12:00' }],
    }),
    c: await seedProvider(request, n, { name: `P14 Closed C ${hex}`, point: near(0.0008), hours: [], rules: false, warranty: false }),
  };
  await waitArea(request);
  await request.dispose();
});

test.afterAll(async () => {
  if (!shops) return;
  await Promise.all(Object.values(shops).map((s) => retire(s)));
});

test.beforeEach(async ({ context, baseURL }) => {
  test.skip(!up, 'needs the backend (`pnpm dev` in backend/)');
  await decideCookies(context, baseURL!);
});

/** Runs the area search as this browser (its BFF session), stores its request like the page does, returns the id. */
async function areaSession(page: Page, locale: 'en' | 'fa'): Promise<string> {
  await gotoReady(page, `/${locale}`);
  const run = await bff(page, 'POST', '/v1/search', areaRequest());
  expect(run.status, JSON.stringify(run.body)).toBe(200);
  const id = run.body.session_id as string;
  await storeRequest(page, id);
  return id;
}

async function storeRequest(page: Page, id: string) {
  await page.evaluate(({ id, request }) => sessionStorage.setItem(`cp:search:${id}`, JSON.stringify({ request, at: Date.now() })), {
    id,
    request: areaRequest(),
  });
}

/** The names of the seeded shops in the order the result list shows them. */
async function seededOrder(page: Page): Promise<string[]> {
  const names = await page.locator('.pwa-search-main article.pwa-result .pwa-card-link').allInnerTexts();
  const ours = new Set(Object.values(shops!).map((s) => s.name));
  return names.map((x) => x.trim()).filter((x) => ours.has(x));
}

function expectClean(urls: readonly string[]) {
  for (const u of urls) expect(u, u).not.toMatch(/[?&](lat|lng|q|text|query|bbox)=/);
}

const isSearchRun = (r: Request) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/v1/search';

test('(a) facets: server counts in the filter panel, result_count in the header, the narrowest filter named first', async ({ page }) => {
  test.setTimeout(120_000);
  const urls = recordUrls(page);
  const id = await areaSession(page, 'en');
  await gotoReady(page, `/en/search/${id}`);
  const panel = page.locator('.pwa-search-filters');
  await expect(page.getByRole('heading', { name: /^3 results/ })).toBeVisible({ timeout: 20_000 });
  await expect(panel.locator('label', { has: page.getByRole('checkbox', { name: /^Warranty offered/ }) })).toContainText('(2)');
  // An option the response leaves out shows no number: the distance radios are no facet.
  await expect(panel.locator('label', { has: page.getByRole('radio', { name: /^Within 10 km/ }) })).not.toContainText('(');

  // Warranty narrows to two, then "Comes to me" empties the list: the empty state names it first with its count.
  await panel.getByRole('checkbox', { name: /^Warranty offered/ }).click();
  await page.waitForURL((u) => u.searchParams.get('warranty') === '1');
  await expect(page.getByRole('heading', { name: /^2 results/ })).toBeVisible();
  await panel.getByRole('checkbox', { name: /^Comes to me/ }).click();
  await page.waitForURL((u) => u.searchParams.get('mobile') === '1');
  const empty = page.locator('.pwa-search-empty');
  await expect(empty).toBeVisible();
  const removes = empty.getByRole('button', { name: /^Remove / });
  await expect(removes.first()).toHaveText('Remove Comes to me (mobile mechanic): 2 results');
  await expect(removes.nth(1)).toHaveText('Remove Warranty offered: 0 results');
  await expectNoAxeViolations(page);
  await removes.first().click();
  await page.waitForURL((u) => u.searchParams.get('mobile') === null);
  await expect(page.getByRole('heading', { name: /^2 results/ })).toBeVisible();
  expectClean(urls);
});

test('(b) Soonest available in FA: A, B, then the shop without slots, each card with its slot', async ({ page }) => {
  test.setTimeout(120_000);
  const id = await areaSession(page, 'fa');
  await gotoReady(page, `/fa/search/${id}`);
  await expect(page.getByRole('link', { name: shops!.c.name })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('combobox', { name: say('fa', 'search.sort.label') }).selectOption('soonest');
  await page.waitForURL((u) => u.searchParams.get('sort') === 'soonest');
  await expect(page.getByText(say('fa', 'search.sort.soonestNote'))).toBeVisible();
  await expect.poll(() => seededOrder(page)).toEqual([shops!.a.name, shops!.b.name, shops!.c.name]);
  const card = (s: SeededProvider) => page.locator('article.pwa-result', { has: page.getByRole('link', { name: s.name }) });
  const slotLead = say('fa', 'search.result.nextSlot', { when: '' }).trim();
  await expect(card(shops!.a)).toContainText(slotLead);
  await expect(card(shops!.b)).toContainText(slotLead);
  await expect(card(shops!.c)).not.toContainText(slotLead);
  // B's slot is three days ahead at 08:00 on the shop's clock: a date, never "today" or "tomorrow", Persian digits.
  const bSlot = await card(shops!.b).getByText(slotLead).innerText();
  expect(bSlot).toContain(digits('fa', '8:00'));
  expect(bSlot).not.toMatch(/امروز|فردا|[0-9]/);
  await expectNoAxeViolations(page);
});

test('(c) a reload keeps the session and sends only GET /v1/search/<id>; an unknown session runs the stored request', async ({ page }) => {
  test.setTimeout(120_000);
  const id = await areaSession(page, 'en');
  const log: Request[] = [];
  page.on('request', (r) => log.push(r));
  await gotoReady(page, `/en/search/${id}`);
  await expect(page.getByRole('link', { name: shops!.a.name })).toBeVisible({ timeout: 20_000 });
  await page.reload();
  await page.locator('html[data-hydrated="true"]').waitFor({ state: 'attached' });
  await expect(page.getByRole('link', { name: shops!.a.name })).toBeVisible({ timeout: 20_000 });
  expect(new URL(page.url()).pathname).toBe(`/en/search/${id}`);
  expect(log.filter(isSearchRun)).toHaveLength(0);
  expect(log.filter((r) => r.method() === 'GET' && new URL(r.url()).pathname === `/api/v1/search/${id}`).length).toBeGreaterThanOrEqual(2);

  // A session this caller cannot read (expired or another caller's): 404 → the stored request runs, the URL changes.
  const unknown = randomUUID();
  await storeRequest(page, unknown);
  log.length = 0;
  await gotoReady(page, `/en/search/${unknown}`);
  await page.waitForURL((u) => /\/en\/search\/[0-9a-f-]{36}/.test(u.pathname) && !u.pathname.endsWith(unknown), { timeout: 20_000 });
  await expect(page.getByRole('link', { name: shops!.a.name })).toBeVisible();
  expect(log.filter((r) => r.method() === 'GET' && new URL(r.url()).pathname === `/api/v1/search/${unknown}`)).toHaveLength(1);
  expect(log.filter(isSearchRun)).toHaveLength(1);
});

/** The map.pins answers of this page, newest last. */
function pinAnswers(page: Page) {
  const out: { body: Record<string, unknown>; json: Promise<Record<string, unknown>> }[] = [];
  page.on('response', (r) => {
    if (r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/v1/map/pins')
      out.push({
        body: r.request().postDataJSON() as Record<string, unknown>,
        json: r.json().catch(() => ({})) as Promise<Record<string, unknown>>,
      });
    // (catch: a body still unread when the page navigates away is gone; only the newest answers are read)
  });
  return out;
}

test('(d) map: a pin without a card opens its profile; Open now hides the closed shop on the server; counts', async ({ page }) => {
  test.setTimeout(150_000); // WebGL and axe under parallel workers (P3 precedent)
  const { a, b, c } = shops!;
  const urls = recordUrls(page);
  await page.route(`${STYLE_HOST}/**`, (r) => r.abort());
  // The area search answers without cards (a real session): every place in the list is a bare pin.
  await page.route('**/api/v1/search', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    // The browser's own headers (Origin, CSRF token) plus Sec-Fetch-Site, which Chromium adds below the page and
    // Playwright's replay leaves out: the BFF refuses a request without them (csrf.ts).
    const res = await route.fetch({ headers: { ...(await route.request().allHeaders()), 'sec-fetch-site': 'same-origin' } });
    const json = (await res.json()) as Record<string, unknown>;
    await route.fulfill({ response: res, json: { ...json, results: [], next_cursor: null } });
  });
  const answers = pinAnswers(page);
  await gotoReady(page, `/en/map?org=${encodeURIComponent(a.slug)}&place=${a.locationId}`);
  await expect(page.locator('.pwa-map')).toHaveAttribute('data-map-status', 'ready', { timeout: 20_000 });
  for (const s of [a, b, c]) await expect(page.locator(`.pwa-pin[data-place-id="${s.locationId}"]`)).toBeVisible({ timeout: 20_000 });

  // Every place opens its profile from the pin alone (contract 1.1.0 slug + roles).
  for (const s of [a, b, c])
    await expect(page.locator(`[data-place-card="${s.locationId}"]`).getByRole('link', { name: 'View' })).toHaveAttribute(
      'href',
      `/en/shop/${s.slug}`,
    );
  const request = page.locator(`[data-place-card="${c.locationId}"]`).getByRole('button', { name: 'Request appointment' });
  await expect(request).toBeVisible();

  // Advanced search highlights: Warranty offered → "N match · M others" from MapResponse.counts (on an empty area
  // "2 match · 1 others"; the shared dev data may add places to the view, so the line is checked against the answer).
  await page.getByRole('button', { name: 'Advanced search' }).click();
  const drawer = page.getByRole('dialog', { name: 'Advanced search' });
  await drawer.getByRole('checkbox', { name: /^Warranty offered/ }).click();
  await expect
    .poll(async () => ((answers.at(-1)?.body.filters as Record<string, unknown> | undefined)?.warranty_offered ?? false) === true)
    .toBe(true);
  const { counts } = (await answers.at(-1)!.json) as { counts: { matching: number; others: number } };
  expect(counts.matching).toBeGreaterThanOrEqual(2);
  expect(counts.others).toBeGreaterThanOrEqual(1);
  await drawer.getByRole('button', { name: `Highlight ${counts.matching} places` }).click();
  await expect(page.locator('[data-map-counts]')).toHaveText(`${counts.matching} match · ${counts.others} others`);
  await expect(page.locator(`.pwa-pin[data-place-id="${c.locationId}"]`)).toHaveClass(/is-dimmed/);
  await expect(page.locator(`.pwa-pin[data-place-id="${a.locationId}"]`)).not.toHaveClass(/is-dimmed/);
  await expect(page.locator(`[data-place-card="${c.locationId}"]`)).toContainText('Does not match your advanced search');
  await expectNoAxeViolations(page);
  await page.getByRole('button', { name: 'Advanced search' }).click();
  await drawer.getByRole('checkbox', { name: /^Warranty offered/ }).click();
  await drawer.getByRole('button', { name: /^Highlight/ }).click();

  // Open now is a server filter: C's pin leaves the map (only_matching), the list follows.
  await page.getByRole('button', { name: 'Open now', exact: true }).click();
  await expect(page.locator(`.pwa-pin[data-place-id="${c.locationId}"]`)).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator(`.pwa-pin[data-place-id="${a.locationId}"]`)).toBeVisible();
  await expect(page.locator(`[data-place-card="${c.locationId}"]`)).toHaveCount(0);
  const last = answers.at(-1)!;
  expect(last.body).toMatchObject({ only_matching: true, filters: { open_now: true } });

  // Zoomed out (≤ 11) the three share one cluster: with Open now it leaves the closed shop out (the shared dev data may
  // hold other places in that cell, so the check is "at least one fewer"; on an empty cell it is 2 against 3).
  const zoomBy = async (key: '-' | '+') => {
    await page.locator('.maplibregl-canvas').focus();
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press(key);
      await page.waitForTimeout(400); // let each eased zoom finish before the next step
    }
    await page.getByRole('button', { name: 'Search this area' }).click();
  };
  await zoomBy('-');
  const ourCluster = async () => {
    const answer = answers.at(-1);
    const zoom = (answer?.body.viewport as { zoom: number } | undefined)?.zoom ?? 99;
    if (zoom > 11) return null;
    const size = cellDegrees(zoom);
    const cell = (p: { lat: number; lng: number }) => `${Math.floor(p.lat / size)}:${Math.floor(p.lng / size)}`;
    const json = (await answer!.json) as { clusters: { point: { lat: number; lng: number }; count: number }[] };
    return json.clusters.find((x) => cell(x.point) === cell(point))?.count ?? null;
  };
  await expect.poll(ourCluster, { timeout: 20_000 }).not.toBeNull();
  const open = (await ourCluster())!;
  expect(answers.at(-1)!.body).toMatchObject({ only_matching: true, filters: { open_now: true } });
  await page.getByRole('button', { name: 'Open now', exact: true }).click();
  await expect.poll(async () => answers.at(-1)?.body.only_matching ?? false, { timeout: 20_000 }).toBe(false);
  const all = (await ourCluster())!;
  expect(open).toBeGreaterThanOrEqual(2);
  expect(all).toBeGreaterThanOrEqual(open + 1);
  await expect(page.getByRole('button', { name: `${all} places, zoom in` }).first()).toBeVisible();

  // View on a bare pin opens the profile.
  await zoomBy('+');
  await page.locator(`[data-place-card="${b.locationId}"]`).getByRole('link', { name: 'View' }).click();
  await page.waitForURL(`**/en/shop/${b.slug}`);
  expectClean(urls);
});
