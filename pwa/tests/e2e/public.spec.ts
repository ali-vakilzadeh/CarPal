// P5.T8: the public SEO pages in the built PWA against the live backend. A provider and a vendor with one part are
// seeded through the API as business users (tests/e2e/businesses.ts). Checks: view-source content, JSON-LD validity,
// canonical and hreflang, no phone and no trade price in the HTML, status codes (404, permanent redirects), robots and
// sitemaps, the guest Follow round trip through the hosted sign-in, the landing page's city list (the lite search
// index catches up within ~90 s, BA-33), axe in EN and FA, and a throttled LCP budget on the provider page.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { backendUp, createUser } from './accounts';
import { seedProvider, seedVendor, taxonomy, type SeededOrg } from './businesses';
import { decideCookies, expectNoAxeViolations, expectNoHorizontalScroll, gotoReady } from './support';

test.describe.configure({ mode: 'serial' });

let provider: SeededOrg;
let vendor: SeededOrg & { itemId: string; itemName: string };
let up = false;

test.beforeAll(async ({ playwright }) => {
  test.setTimeout(180_000);
  const request = await playwright.request.newContext();
  up = await backendUp(request);
  if (!up) return;
  const n = await taxonomy(request);
  provider = await seedProvider(request, n);
  vendor = await seedVendor(request, n);
  await request.dispose();
});

test.beforeEach(async ({ context, baseURL }) => {
  test.skip(!up, 'needs the backend (`pnpm dev` in backend/)');
  await decideCookies(context, baseURL!);
});

/** The page's JSON-LD blocks, parsed (fails on invalid JSON). */
function jsonLd(html: string): Record<string, unknown>[] {
  return [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([^<]*)<\/script>/g)].map(
    (m) => JSON.parse(m[1]!) as Record<string, unknown>,
  );
}

async function source(request: APIRequestContext, path: string): Promise<{ status: number; html: string }> {
  const res = await request.get(path, { maxRedirects: 0 });
  return { status: res.status(), html: await res.text() };
}

const link = (html: string, rel: string, lang?: string) =>
  new RegExp(`<link rel="${rel}"${lang ? ` hrefLang="${lang}"` : ''} href="([^"]+)"`).exec(html)?.[1] ?? null;

test('provider profile: server-rendered content, JSON-LD, canonical and hreflang; no phone, no private data', async ({
  request,
  baseURL,
}) => {
  const path = `/en/shop/${provider.slug}`;
  const { status, html } = await source(request, path);
  expect(status).toBe(200);
  expect(html).toContain(provider.name);
  expect(html).toContain('Suspension and steering for European cars.');
  expect(html).not.toContain('66001122');
  expect(html).not.toContain('shop@example.com');
  const ld = jsonLd(html);
  expect(ld).toEqual(expect.arrayContaining([expect.objectContaining({ '@type': 'AutoRepair', name: provider.name })]));
  expect(link(html, 'canonical')).toBe(`${baseURL}${path}`);
  expect(link(html, 'alternate', 'fa')).toBe(`${baseURL}/fa/shop/${provider.slug}`);
  expect(link(html, 'alternate', 'en')).toBe(`${baseURL}${path}`);
  expect(link(html, 'alternate', 'x-default')).toBe(`${baseURL}/fa/shop/${provider.slug}`);
  expect(html).toMatch(/<meta name="robots" content="index, follow"/);
  expect(html).toMatch(/<meta property="og:title"/);
});

test('provider profile in the browser: sections, opening hours, Call reveal; axe in EN (desktop) and FA (phone)', async ({ page }) => {
  // The production build enforces the CSP and Trusted Types: no violation and no error while the page works.
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`));
  });
  await gotoReady(page, `/en/shop/${provider.slug}`);
  await expect(page.getByRole('heading', { level: 1, name: provider.name })).toBeVisible();
  for (const name of ['Overview', 'Services & capabilities', 'Portfolio', 'Reviews', 'Location & hours'])
    await expect(page.getByRole('navigation', { name: 'On this page' }).getByRole('link', { name })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Opening hours' }).getByRole('row').first()).toContainText('Saturday');
  const rail = page.getByRole('complementary');
  await expect(rail.getByRole('button', { name: 'Request appointment' })).toBeVisible();
  await rail.getByRole('button', { name: 'Call' }).click();
  await expect(rail.getByRole('link', { name: /\+982166001122/ })).toHaveAttribute('href', 'tel:+982166001122');
  await expectNoAxeViolations(page);

  await page.setViewportSize({ width: 375, height: 800 });
  await gotoReady(page, `/fa/shop/${provider.slug}`);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('button', { name: 'درخواست نوبت' })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await expectNoAxeViolations(page);
  expect(errors).toEqual([]);
});

test('vendor profile and part page: AutoPartsStore and Product JSON-LD with the public price only', async ({ request, page }) => {
  const seller = await source(request, `/en/parts-seller/${vendor.slug}`);
  expect(seller.status).toBe(200);
  expect(jsonLd(seller.html)).toEqual(expect.arrayContaining([expect.objectContaining({ '@type': 'AutoPartsStore', name: vendor.name })]));
  expect(seller.html).toContain(vendor.itemName);
  expect(seller.html).toContain('Trade prices for verified businesses');

  // The part URL without its slug moves permanently to the canonical one.
  const bare = await request.get(`/en/parts/${vendor.slug}/${vendor.itemId}`, { maxRedirects: 0 });
  expect(bare.status()).toBe(308);
  const canonical = new URL(bare.headers().location!, 'http://x').pathname;
  expect(canonical).toMatch(new RegExp(`^/en/parts/${vendor.slug}/${vendor.itemId}-front-control-arm-`));
  const partPage = await source(request, canonical);
  expect(partPage.status).toBe(200);
  const productLd = jsonLd(partPage.html).find((x) => x['@type'] === 'Product')!;
  expect(productLd.offers).toMatchObject({ price: '45.00', priceCurrency: 'USD', availability: 'https://schema.org/InStock' });
  // The trade price (30.00) never reaches the HTML or the RSC payload; "$30" is checked in the markup only, because the
  // flight payload uses "$<hex>" references ("$30" is reference 0x30, P8).
  expect(partPage.html).not.toMatch(/30\.00/);
  expect(partPage.html.replace(/<script[\s\S]*?<\/script>/g, '')).not.toMatch(/\$30/);
  const fa = link(partPage.html, 'alternate', 'fa');
  expect(fa).toMatch(new RegExp(`/fa/parts/${vendor.slug}/${vendor.itemId}-`));

  await gotoReady(page, canonical);
  await expect(page.getByRole('heading', { level: 1, name: vendor.itemName })).toBeVisible();
  await expect(page.getByText('$45')).toBeVisible();
  await page.getByRole('button', { name: 'Ask about stock' }).click();
  await expect(page.getByRole('dialog', { name: `Sign in to ask ${vendor.name} about this part` })).toBeVisible();
  await page.keyboard.press('Escape');
  await expectNoAxeViolations(page);
  await gotoReady(page, `/fa/parts-seller/${vendor.slug}`);
  await expectNoAxeViolations(page);
});

test('status codes: unknown pages 404 with noindex, wrong page kinds move permanently, robots and sitemaps', async ({ request }) => {
  const missing = await source(request, '/en/shop/no-such-shop-123');
  expect(missing.status).toBe(404);
  expect(missing.html).toMatch(/<meta name="robots" content="noindex"/);
  expect((await source(request, '/en/post/01a17000-0000-7000-8000-000000000000-x')).status).toBe(404);
  expect((await source(request, '/fa/parts/x/not-an-id')).status).toBe(404);
  const asSeller = await request.get(`/en/parts-seller/${provider.slug}`, { maxRedirects: 0 });
  expect(asSeller.status()).toBe(308);
  expect(asSeller.headers().location).toContain(`/en/shop/${provider.slug}`);

  const robots = await (await request.get('/robots.txt')).text();
  expect(robots).toContain('Disallow: /fa/garage');
  expect(robots).toMatch(/Sitemap: http:\/\/localhost:\d+\/sitemap\.xml/);
  expect(await (await request.get('/sitemap.xml')).text()).toContain('/sitemaps/shops.xml');
  const pages = await (await request.get('/sitemaps/pages.xml')).text();
  expect(pages).toContain('hreflang="x-default"');
  expect((await request.get('/sitemaps/nope.xml')).status()).toBe(404);
});

test('Follow as a guest goes through the hosted sign-in and completes on return (GD-06)', async ({ page, request }) => {
  test.setTimeout(90_000);
  const user = await createUser(request);
  await gotoReady(page, `/en/shop/${provider.slug}`);
  await page.getByRole('main').getByRole('button', { name: 'Follow' }).click();
  await page
    .getByRole('dialog', { name: `Sign in to follow ${provider.name}` })
    .getByRole('button', { name: 'Log in' })
    .click();
  await page.waitForURL(/\/id\/signin\?interaction_id=/);
  await page.locator('html[data-hydrated="true"]').waitFor({ state: 'attached' });
  await expect(page.getByText(`Sign in to follow ${provider.name}`)).toBeVisible();
  await page.getByLabel('Mobile number or email').fill(user.email);
  await page.getByRole('button', { name: 'Use password' }).click();
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForURL(/\/en\/onboarding\?next=/);
  await page.getByRole('link', { name: 'Finish later' }).click();
  await page.waitForURL(new RegExp(`/en/shop/${provider.slug}$`));
  await expect(page.getByText(`You are following ${provider.name}`)).toBeVisible();
  await expect(page.getByRole('main').getByRole('button', { name: 'Following' })).toBeVisible();
});

test('landing page: hero, city choice and popular specialists in Tehran', async ({ page, request }) => {
  test.setTimeout(150_000);
  const html = (await source(request, '/en')).html;
  expect(jsonLd(html)).toEqual(expect.arrayContaining([expect.objectContaining({ '@type': 'Organization', name: 'CarPal' })]));
  await gotoReady(page, '/en');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Find the right trusted expert');
  await expect(page.getByText('Pick a city to see trusted specialists there.')).toBeVisible();
  await page.getByRole('combobox', { name: 'Choose your city' }).selectOption('tehran');
  await page.getByRole('button', { name: 'Show' }).click();
  await page.waitForURL(/\/en\?city=tehran$/);
  // Up to six providers of the city in ranked order; earlier runs' providers share the city, so this run's provider
  // is not necessarily among them. The lite search index picks new providers up within ~90 s (BA-33).
  const cards = page.getByRole('region', { name: 'Popular specialists near you' }).locator('a[href*="/en/shop/"]');
  await expect
    .poll(
      async () => {
        await page.reload();
        return cards.count();
      },
      { timeout: 120_000, intervals: [5_000] },
    )
    .toBeGreaterThan(0);
  expect(await cards.count()).toBeLessThanOrEqual(6);
  await expectNoAxeViolations(page);
  // The choice is remembered for the next visit.
  await gotoReady(page, '/en');
  await expect(page.getByRole('combobox', { name: 'Near' })).toHaveValue('tehran');
});

async function lcp(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let last = 0;
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) last = e.startTime;
        }).observe({ type: 'largest-contentful-paint', buffered: true });
        setTimeout(() => resolve(last), 1_500);
      }),
  );
}

test('provider page LCP stays within 2.5 s on a throttled connection (slow 4G, 4× CPU)', async ({ page, context }) => {
  test.setTimeout(90_000);
  const path = `/en/shop/${provider.slug}`;
  await page.goto(path); // warm the server's read cache, as a visitor after the first one would see it
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 150,
    downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await page.goto(path, { waitUntil: 'load' });
  const value = await lcp(page);
  console.log(`provider page LCP (throttled): ${Math.round(value)} ms`);
  expect(value).toBeGreaterThan(0);
  expect(value).toBeLessThan(2_500);
});
