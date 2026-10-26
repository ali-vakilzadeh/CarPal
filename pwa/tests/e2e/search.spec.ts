// P6.T8: search, map, directions and directory pages in the built PWA against the live backend. A provider with the
// suspension category is seeded through the API (tests/e2e/businesses.ts) under a unique name, and the lite index is
// polled until it finds it (BA-33). Checks: Flow 5 in FA (Persian text → "Understood as" chips → ranked result with a
// reason → profile → Request appointment), the same with Persian typed in Latin letters, the safety banner with the
// results visible, no search text or coordinates in any page or request URL (every BFF call is a browser request;
// the BFF writes no access log), the map with the built-in style and with a real style URL (intercepted), the map
// keyboard (+ zooms, Tab reaches the pins, L hides the list), the directory page's index rule, JSON-LD and sitemap,
// and axe on the new pages.
import { randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { API, AUTH, backendUp } from './accounts';
import { seedProvider, taxonomy, type SeededOrg } from './businesses';
import { decideCookies, expectNoAxeViolations, expectNoHorizontalScroll, gotoReady } from './support';

test.describe.configure({ mode: 'serial' });

const STYLE_HOST = 'https://cdn.carpal.app';
const SSR = 'cp-ssr/0.1.0 (web 1.0)';

let up = false;
let provider: SeededOrg;
let hex = '';
let suspensionFa = '';

async function ssrToken(request: APIRequestContext): Promise<string> {
  const tok = await request.post(`${AUTH}/oauth/token`, {
    form: { grant_type: 'client_credentials', client_id: 'cp-ssr', scope: 'public.read' },
    headers: { 'carpal-client': SSR },
  });
  const { access_token, token_type } = (await tok.json()) as { access_token: string; token_type: string };
  return `${token_type} ${access_token}`;
}

async function systemNode(request: APIRequestContext, slug: string, locale: 'en' | 'fa') {
  const res = await request.get(`${API}/v1/taxonomy/nodes?type=service_system&limit=50`, {
    headers: { authorization: await ssrToken(request), 'carpal-client': SSR, 'accept-language': locale },
  });
  const items = ((await res.json()) as { items: { id: string; slug: string; name: { text: string } }[] }).items;
  return items.find((n) => n.slug === slug)!;
}

/** Polls search.run until the seeded provider is found for the text (the lite index sweeps every minute). */
async function waitIndexed(request: APIRequestContext, orgId: string, text: string) {
  const auth = await ssrToken(request);
  await expect
    .poll(
      async () => {
        const res = await request.post(`${API}/v1/search`, {
          data: { query_text: text, search_mode: 'all', entry_point: 'search_box', location: { mode: 'chosen_city', city_key: 'tehran' } },
          headers: { authorization: auth, 'carpal-client': SSR, 'accept-language': 'fa' },
        });
        const body = (await res.json()) as { results?: { organization: { id: string } }[] };
        return (body.results ?? []).some((r) => r.organization.id === orgId);
      },
      { timeout: 120_000, intervals: [2_000, 5_000] },
    )
    .toBe(true);
}

test.beforeAll(async ({ playwright }) => {
  test.setTimeout(240_000);
  const request = await playwright.request.newContext();
  up = await backendUp(request);
  if (!up) return;
  const n = await taxonomy(request);
  const suspension = await systemNode(request, 'suspension', 'en');
  suspensionFa = (await systemNode(request, 'suspension', 'fa')).name.text;
  hex = randomBytes(3).toString('hex');
  provider = await seedProvider(request, { ...n, system: suspension.id }, { name: `P6 Shop ${hex}` });
  await waitIndexed(request, provider.id, `جلوبندی ${hex}`);
  await request.dispose();
});

test.beforeEach(async ({ context, baseURL }) => {
  test.skip(!up, 'needs the backend (`pnpm dev` in backend/)');
  await decideCookies(context, baseURL!);
});

/** Every URL the page requests or navigates to (BFF calls included). */
function recordUrls(page: Page): string[] {
  const urls: string[] = [];
  page.on('request', (r) => urls.push(r.url()));
  page.on('framenavigated', (f) => urls.push(f.url()));
  return urls;
}

function expectClean(urls: readonly string[], text: string) {
  const encoded = [text, encodeURIComponent(text), encodeURIComponent(text).replace(/%20/g, '+')];
  for (const u of urls) {
    for (const e of encoded) expect(u, u).not.toContain(e);
    expect(u, u).not.toMatch(/[?&](lat|lng|q|text|query)=/);
  }
}

async function headerSearch(page: Page, text: string) {
  await page.getByRole('combobox', { name: /Search CarPal|جستجو در کارپال/ }).fill(text);
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/search\/[0-9a-f-]{36}/, { timeout: 30_000 });
}

test('Flow 5 in FA: Persian text → understood-as chips → ranked result with a reason → profile → Request appointment', async ({ page }) => {
  test.setTimeout(90_000); // WebGL and axe under parallel workers (P3 precedent)
  const urls = recordUrls(page);
  const text = `جلوبندی ${hex}`;
  await gotoReady(page, '/fa');
  await headerSearch(page, text);
  const chips = page.getByRole('group', { name: 'برداشت ما از جستجو' });
  await expect(chips).toContainText(suspensionFa);
  const card = page.getByRole('link', { name: provider.name });
  await expect(card).toBeVisible();
  const article = page.locator('article.pwa-result', { has: card });
  await expect(article.locator('.pwa-result-reason')).not.toBeEmpty();
  await expectNoAxeViolations(page);
  await card.click();
  await page.waitForURL(`**/fa/shop/${provider.slug}`);
  await expect(page.getByRole('button', { name: 'درخواست نوبت' }).first()).toBeVisible();
  expectClean(urls, text);
});

test('Persian typed in Latin letters is understood the same way', async ({ page }) => {
  const urls = recordUrls(page);
  const text = `jolobandi ${hex}`;
  await gotoReady(page, '/fa');
  await headerSearch(page, text);
  await expect(page.getByRole('group', { name: 'برداشت ما از جستجو' })).toContainText(suspensionFa);
  await expect(page.getByRole('link', { name: provider.name })).toBeVisible();
  expectClean(urls, text);
});

test('safety words show the red banner while the results stay visible', async ({ page }) => {
  await gotoReady(page, '/en');
  await headerSearch(page, 'tormoz nemigire');
  const banner = page.getByRole('alert').filter({ hasText: 'Safety words in your search' });
  await expect(banner).toBeVisible();
  await expect(page.getByRole('link', { name: 'Find urgent help' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /result|No results/ }).first()).toBeVisible();
});

test('filters refine at once, live in the URL as enumerated values, and Back returns to the earlier results', async ({ page }) => {
  await gotoReady(page, '/en');
  await headerSearch(page, `jolobandi ${hex}`);
  const first = page.url();
  await page
    .getByRole('checkbox', { name: /^Open now/ })
    .first()
    .click(); // controlled by the URL: checked once refined
  await page.waitForURL((u) => u.href !== first && u.searchParams.get('open') === '1');
  expect(new URL(page.url()).searchParams.toString()).toMatch(/^city=tehran&open=1$/);
  await page.goBack();
  await page.waitForURL(first);
  await expect(page.getByRole('link', { name: provider.name })).toBeVisible();
});

test('search page on a phone in FA: filters in a drawer, no map pane, no horizontal scroll, axe', async ({ page }) => {
  test.setTimeout(90_000); // WebGL and axe under parallel workers (P3 precedent)
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoReady(page, '/fa');
  await headerSearch(page, `جلوبندی ${hex}`);
  await expect(page.getByRole('link', { name: provider.name })).toBeVisible();
  await expect(page.locator('.pwa-search-map')).toHaveCount(0);
  await page.getByRole('button', { name: /فیلترها/ }).click();
  await expect(page.getByRole('dialog', { name: 'فیلترها' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expectNoHorizontalScroll(page);
  await expectNoAxeViolations(page);
});

test('map with the built-in style: pins and clusters, Search this area after +, Tab reaches a pin, L hides the list', async ({ page }) => {
  test.setTimeout(90_000); // WebGL and axe under parallel workers (P3 precedent)
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && !(m.location().url ?? '').startsWith(STYLE_HOST) && errors.push(m.text()));
  await page.route(`${STYLE_HOST}/**`, (r) => r.abort());
  await gotoReady(page, '/en/map');
  const map = page.locator('.pwa-map');
  await expect(map).toHaveAttribute('data-map-status', 'ready', { timeout: 20_000 });
  await expect(map).toHaveAttribute('data-basemap', 'fallback');
  await expect(page.locator('.pwa-pin:not(.is-static)').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('© OpenStreetMap contributors').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: /places? in view/ })).toBeVisible();

  await page.locator('.maplibregl-canvas').focus();
  await page.keyboard.press('+');
  await expect(page.getByRole('button', { name: 'Search this area' })).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press('Tab');
  await expect(page.locator('.pwa-pin:focus')).toHaveCount(1);
  await page.locator('.maplibregl-canvas').focus();
  await page.keyboard.press('l');
  await expect(page.locator('.pwa-map-list')).toBeHidden();
  await page.keyboard.press('l');
  await expect(page.locator('.pwa-map-list')).toBeVisible();
  await expectNoAxeViolations(page);
  expect(errors.filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
});

test('map with a real style URL (the region’s style, served by the test)', async ({ page }) => {
  test.setTimeout(90_000); // WebGL and axe under parallel workers (P3 precedent)
  await page.route(`${STYLE_HOST}/**`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({
        version: 8,
        name: 'e2e',
        sources: {},
        layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#dfe7ef' } }],
      }),
    }),
  );
  await gotoReady(page, '/fa/map');
  const map = page.locator('.pwa-map');
  await expect(map).toHaveAttribute('data-map-status', 'ready', { timeout: 20_000 });
  await expect(map).toHaveAttribute('data-basemap', 'remote');
  await expect(page.locator('.pwa-pin:not(.is-static)').first()).toBeVisible({ timeout: 20_000 });
  await expectNoHorizontalScroll(page);
});

test('the map opens centred on a business from its profile and selects its pin', async ({ page }) => {
  test.setTimeout(90_000); // WebGL and axe under parallel workers (P3 precedent)
  await page.route(`${STYLE_HOST}/**`, (r) => r.abort());
  await gotoReady(page, `/en/shop/${provider.slug}`);
  await page.getByRole('link', { name: 'Open the map' }).first().click();
  await page.waitForURL(/\/en\/map\?org=/);
  expect(page.url()).not.toMatch(/lat|lng/);
  await expect(page.locator('.pwa-map-selected')).toContainText(provider.name, { timeout: 20_000 });
  await page.locator('.pwa-map-selected').getByRole('button', { name: 'Get directions' }).click();
  await expect(page.locator('.pwa-map-selected .pwa-popover').getByRole('link', { name: 'Neshan' })).toHaveAttribute(
    'href',
    /^https:\/\/neshan\.org\/maps\/@/,
  );
});

test('directory page: H1, ranked list, JSON-LD, canonical and the ≥ 3 index rule; unknown slugs 404; sitemap', async ({
  request,
  page,
}) => {
  test.setTimeout(90_000); // WebGL and axe under parallel workers (P3 precedent)
  const res = await request.get('/en/tehran/suspension');
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toContain('Suspension specialists in Tehran');
  expect(html).toContain(provider.name);
  const ld = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([^<]*)<\/script>/g)].map(
    (m) => JSON.parse(m[1]!) as { '@type': string },
  );
  expect(ld.map((x) => x['@type'])).toEqual(expect.arrayContaining(['BreadcrumbList', 'ItemList']));
  expect(html).toMatch(/<link rel="canonical" href="[^"]*\/en\/tehran\/suspension"/);
  const cards = (html.match(/class="pwa-result"/g) ?? []).length;
  if (cards >= 3) expect(html).toMatch(/<meta name="robots" content="index, follow"/);
  else {
    expect(html).toMatch(/<meta name="robots" content="noindex, follow"/);
    expect(html).toContain('Widen your search');
  }
  expect((await request.get('/en/tehran/not-a-category')).status()).toBe(404);
  expect((await request.get('/en/atlantis/suspension')).status()).toBe(404);
  const sitemap = await request.get('/sitemaps/directories.xml');
  expect(sitemap.status()).toBe(200);
  expect(await sitemap.text()).toContain('<urlset');
  expect(await (await request.get('/sitemap.xml')).text()).toContain('/sitemaps/directories.xml');

  await page.route(`${STYLE_HOST}/**`, (r) => r.abort());
  await gotoReady(page, '/fa/tehran/suspension/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('تهران');
  await expectNoAxeViolations(page);
});
