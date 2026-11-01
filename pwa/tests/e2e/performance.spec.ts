// P13.T3: performance of the public pages on a mid-range phone over 4G (Docs/01 §15, Docs/02 WP19: LCP ≤ 2.5 s).
// Method (user decision 2026-10-31, Q6 a): Playwright + Chrome DevTools throttling and the browser's own performance
// entries, no new dependency. Profile: Galaxy A55 (412 × 915, DPR 2.625, touch), CPU 4× slower, 1.6 Mbps down,
// 750 kbps up, 150 ms RTT; cache disabled for the measured load; the server's public-read cache warmed by one visit
// first (as any visitor after the first sees it). Per page: LCP, CLS, INP (the slowest event of a tap on the cookie
// settings button), the JavaScript transferred and decoded, the map library loaded or not, and the font preloaded for
// the page language. Budgets: LCP ≤ 2.5 s, CLS ≤ 0.1, INP ≤ 500 ms under the 4× CPU slowdown (the "good" 200 ms
// applies to the real phone, which the slowdown overstates). The measurements are attached as perf-<page>.json and
// printed, for the P13 report. Run alone with `pnpm e2e:perf` (one worker); `pnpm e2e` skips it.
import { devices, expect, test, type CDPSession, type Page } from '@playwright/test';
import { API, AUTH, backendUp } from './accounts';
import { businessUser, seedProvider, taxonomy, type SeededProvider } from './businesses';
import { SSR } from './flows';
import { decideCookies } from './support';

test.describe.configure({ mode: 'serial' });
test.use({ ...devices['Galaxy A55'] });

const STYLE_HOST = 'https://cdn.carpal.app';
const FONT = { fa: '/ds/fonts/Vazirmatn-Arabic-Variable.woff2', en: '/ds/fonts/AtkinsonHyperlegibleNext-Latin-Variable.woff2' };

let up = false;
let shop: SeededProvider;
let questionPath: string | null = null;

test.beforeAll(async ({ playwright }) => {
  test.setTimeout(180_000);
  const request = await playwright.request.newContext();
  up = await backendUp(request);
  if (!up) return;
  shop = await seedProvider(request, await taxonomy(request));
  // A public question: an earlier run's, else a new one (Q&A on: community.spec turns the flags on).
  const tok = await request.post(`${AUTH}/oauth/token`, {
    form: { grant_type: 'client_credentials', client_id: 'cp-ssr', scope: 'public.read' },
    headers: { 'carpal-client': SSR },
  });
  const { access_token, token_type } = (await tok.json()) as { access_token: string; token_type: string };
  const auth = { authorization: `${token_type} ${access_token}`, 'carpal-client': SSR, 'accept-language': 'en' };
  const found = await request.post(`${API}/v1/questions/search`, { data: { limit: 1 }, headers: auth });
  let q = found.ok() ? ((await found.json()) as { items: { id: string; title: string }[] }).items[0] : undefined;
  if (!q && found.ok()) {
    const asker = await businessUser(request, 'p13perf');
    const made = await asker.call('POST', '/v1/questions', {
      title: 'Why does my car pull to the left after new tyres?',
      body: 'Since the new tyres the car pulls to the left on straight roads.',
      content_locale: 'en',
    });
    if (made.status < 300) q = made.body as { id: string; title: string };
  }
  if (q) questionPath = `/en/questions/${q.id}`;
  await request.dispose();
});

test.beforeEach(async ({ context, baseURL, page }) => {
  // Measured alone: parallel workers share the CPU and inflate every timing (pnpm e2e:perf runs one worker).
  test.skip(test.info().config.workers > 1, 'performance runs alone: `pnpm e2e:perf`');
  test.skip(!up, 'needs the backend (`pnpm dev` in backend/)');
  await decideCookies(context, baseURL!);
  await page.route(`${STYLE_HOST}/**`, (r) => r.abort());
});

async function throttle(page: Page): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 150,
    downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  return cdp;
}

interface Vitals {
  lcp: number;
  cls: number;
  inp: number;
  jsTransferKb: number;
  jsDecodedKb: number;
  map: boolean;
  fontPreload: boolean;
}

async function measure(page: Page, path: string, locale: 'en' | 'fa'): Promise<Vitals> {
  await page.goto(path); // warm the server's read cache
  const cdp = await throttle(page);
  await page.addInitScript(() => {
    const w = window as unknown as { __cls: number; __inp: number };
    w.__cls = 0;
    w.__inp = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[])
        if (!e.hadRecentInput) w.__cls += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__inp = Math.max(w.__inp, e.duration);
    }).observe({ type: 'event', buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
  });
  const res = await page.goto(path, { waitUntil: 'load' });
  // React's preload() reaches the browser as an HTTP Link header (and, on some pages, a <link> tag).
  const html = `${(await res?.text()) ?? ''}
${res?.headers().link ?? ''}`;
  const lcp = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let last = 0;
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) last = e.startTime;
        }).observe({ type: 'largest-contentful-paint', buffered: true });
        setTimeout(() => resolve(last), 1_500);
      }),
  );
  await page.locator('html[data-hydrated="true"]').waitFor({ state: 'attached' });
  // One interaction for INP: the footer's Cookie settings (opens a modal).
  const cookies = page.getByRole('contentinfo').getByRole('button').first();
  if (await cookies.isVisible().catch(() => false)) {
    await cookies.tap();
    await page.waitForTimeout(800);
  }
  const rest = await page.evaluate(() => {
    const w = window as unknown as { __cls: number; __inp: number };
    const scripts = (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).filter(
      (r) => r.initiatorType === 'script' || r.name.endsWith('.js'),
    );
    return {
      cls: w.__cls,
      inp: w.__inp,
      jsTransferKb: Math.round(scripts.reduce((s, r) => s + r.transferSize, 0) / 1024),
      jsDecodedKb: Math.round(scripts.reduce((s, r) => s + r.decodedBodySize, 0) / 1024),
      map: !!document.querySelector('.maplibregl-canvas') || 'maplibregl' in window,
    };
  });
  await cdp.detach();
  const fontPreload = new RegExp(
    `<link[^>]+rel="preload"[^>]+href="${FONT[locale]}"|<link[^>]+href="${FONT[locale]}"[^>]+rel="preload"|<${FONT[locale]}>; rel=preload; as="font"`,
  ).test(html);
  return {
    ...rest,
    lcp: Math.round(lcp),
    cls: Math.round(rest.cls * 1000) / 1000,
    inp: Math.round(rest.inp),
    fontPreload,
  };
}

const PAGES: { name: string; path: () => string | null; locale: 'en' | 'fa'; map: boolean }[] = [
  { name: 'landing-fa', path: () => '/fa', locale: 'fa', map: false },
  { name: 'landing-en', path: () => '/en', locale: 'en', map: false },
  { name: 'provider-profile', path: () => `/en/shop/${shop.slug}`, locale: 'en', map: false },
  { name: 'directory-fa', path: () => '/fa/tehran/suspension', locale: 'fa', map: true },
  { name: 'question', path: () => questionPath, locale: 'en', map: false },
];

for (const p of PAGES) {
  test(`${p.name}: LCP ≤ 2.5 s, CLS ≤ 0.1 on a mid-range phone over 4G; font preloaded; map only where shown`, async ({ page }, info) => {
    test.setTimeout(150_000);
    const path = p.path();
    test.skip(!path, 'no public question (Q&A off)');
    const v = await measure(page, path!, p.locale);
    console.log(`perf ${p.name} ${path}: ${JSON.stringify(v)}`);
    await info.attach(`perf-${p.name}.json`, { body: JSON.stringify({ path, ...v }, null, 2), contentType: 'application/json' });
    expect(v.lcp).toBeGreaterThan(0);
    expect(v.lcp).toBeLessThanOrEqual(2_500);
    expect(v.cls).toBeLessThanOrEqual(0.1);
    expect(v.inp).toBeLessThanOrEqual(500);
    expect(v.fontPreload).toBe(true);
    // The map library is a lazy chunk: pages without a map never load it (the directory's rail map is ≥ 1200 px only).
    if (!p.map) expect(v.map).toBe(false);
  });
}
