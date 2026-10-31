// P12.T5: PWA capabilities in the built app (Chromium) against the live backend.
//   1. installable: the manifest and the worker satisfy Chromium (no installability errors in a persistent profile);
//      offline, an unsaved page answers with the W-SYS-01 offline page;
//   2. offline garage: a signed-in user's garage is saved by the worker; offline, a reload shows the car (and the
//      offline bar), the offline page lists the saved pages; after logout no private cache remains and the garage is
//      no longer available offline (acceptance of P12);
//   3. the update flow: a new worker waits until "Reload" is chosen, then controls the page;
//   4. web push with a mocked push service: the Push API is stubbed in the page (no real push service here), the
//      browser's subscription is registered as a web push token, a push delivered to the worker (CDP) shows a
//      notification, and logout revokes the token.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { backendUp, createUser } from './accounts';
import { taxonomy } from './businesses';
import { decideCookies, expectNoAxeViolations, gotoReady } from './support';

test.describe.configure({ mode: 'serial' });

async function waitForWorker(page: Page) {
  await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, null, { timeout: 30_000 });
}

/** Cache names and how many entries each holds. */
async function cacheSummary(page: Page): Promise<Record<string, number>> {
  return page.evaluate(async () => {
    const out: Record<string, number> = {};
    for (const n of await caches.keys()) out[n] = (await (await caches.open(n)).keys()).length;
    return out;
  });
}

/** The pages the worker saved for the signed-in user (the offline page's list). */
async function savedPages(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    for (const n of await caches.keys()) {
      if (!n.startsWith('cp-user-')) continue;
      const res = await (await caches.open(n)).match('/__carpal/saved-pages.json');
      if (res) return ((await res.json()) as { url: string }[]).map((p) => p.url);
    }
    return [];
  });
}

async function signIn(page: Page, user: { email: string; password: string }) {
  await page.goto('/en/login');
  await page.waitForURL(/\/id\/signin\?interaction_id=/);
  await page.locator('html[data-hydrated="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Mobile number or email').fill(user.email);
  await page.getByRole('button', { name: 'Use password' }).click();
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForURL(/\/en\/onboarding\?next=/);
  await page.getByRole('link', { name: 'Finish later' }).click();
  await page.waitForURL(/\/en(\/home)?$/);
}

async function bff(page: Page, method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const csrf = ((await (await fetch('/bff/csrf')).json()) as { csrf_token: string }).csrf_token;
      const res = await fetch(`/api${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, 'idempotency-key': crypto.randomUUID() },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
    },
    { method, path, body },
  );
}

async function logOutFromPublicPage(page: Page) {
  // A logout on a private page sends the browser to the hosted sign-in at once (session gate, P9 note).
  await gotoReady(page, '/en/how-ranking-works');
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByRole('link', { name: 'Log in' }).first()).toBeVisible();
}

test.beforeEach(async ({ request, context, baseURL }) => {
  test.skip(!(await backendUp(request)), 'needs the backend (`pnpm dev` in backend/)');
  await decideCookies(context, baseURL!);
});

test('the app is installable and an unsaved page offline shows the offline page', async ({ baseURL }) => {
  // Installability needs a normal (not incognito) profile: a persistent context of the same Chromium.
  const dir = mkdtempSync(join(tmpdir(), 'cp-pwa-'));
  const context = await chromium.launchPersistentContext(dir, {
    ...(process.env.CARPAL_E2E_CHROMIUM ? { executablePath: process.env.CARPAL_E2E_CHROMIUM } : {}),
    baseURL,
  });
  try {
    await decideCookies(context, baseURL!);
    const page = context.pages()[0] ?? (await context.newPage());
    await gotoReady(page, '/en');
    await waitForWorker(page);
    const cdp = await context.newCDPSession(page);
    const manifest = await cdp.send('Page.getAppManifest');
    expect(manifest.errors).toEqual([]);
    expect(manifest.url).toContain('/manifests/en.webmanifest');
    await expect.poll(async () => (await cdp.send('Page.getInstallabilityErrors')).installabilityErrors.map((e) => e.errorId)).toEqual([]);
    // The shell holds both offline pages (fetched without cookies).
    const caches = await cacheSummary(page);
    expect(Object.keys(caches).some((n) => n.startsWith('cp-shell-'))).toBe(true);

    await context.setOffline(true);
    await page.goto('/fa/questions');
    await expect(page.getByRole('heading', { level: 1, name: 'اینترنت قطع است' })).toBeVisible();
    await page.goto('/en/settings');
    await expect(page.getByRole('heading', { level: 1, name: "You're offline" })).toBeVisible();
    await page.locator('html[data-hydrated="true"]').waitFor({ state: 'attached' });
    await expectNoAxeViolations(page);
    await context.setOffline(false);
  } finally {
    await context.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('offline garage for the signed-in user only; nothing private remains after logout', async ({ page, context, request }) => {
  test.setTimeout(180_000);
  const n = await taxonomy(request);
  const user = await createUser(request);
  await signIn(page, user);
  const nickname = `Offline ${Date.now().toString(36)}`;
  const car = await bff(page, 'POST', '/v1/me/vehicles', { brand_node_id: n.brand, model_node_id: n.model, year: 2014, nickname });
  expect(car.status, JSON.stringify(car.body)).toBe(201);

  await gotoReady(page, '/en/garage');
  await waitForWorker(page);
  // The first load may predate the worker's control: load again so the page and its reads go through it.
  await page.reload();
  await expect(page.getByText(nickname).first()).toBeVisible();
  // Wide screens open the first car (client-side move to /en/garage/<id>/overview): the worker keeps that page's
  // document too. Wait until it wrote the copy and its saved-pages entry (it stores after answering).
  await expect.poll(() => savedPages(page)).toContain('/en/garage');
  await expect(page).toHaveURL(/\/en\/garage\/[0-9a-f-]+\/overview/);
  const detail = new URL(page.url()).pathname;
  await expect.poll(() => savedPages(page)).toContain(detail);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByText(nickname).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('offline-bar')).toBeVisible();
  // A page that was not saved: the offline page, listing what was.
  await page.goto('/en/settings/profile');
  await expect(page.getByRole('heading', { level: 1, name: "You're offline" })).toBeVisible();
  await expect(page.getByTestId('saved-pages').getByRole('link').first()).toHaveAttribute('href', /\/en\/garage/);
  await expectNoAxeViolations(page);
  await context.setOffline(false);

  await logOutFromPublicPage(page);
  await expect
    .poll(async () => Object.keys(await cacheSummary(page)).filter((name) => name.startsWith('cp-user-') || name === 'cp-pages'))
    .toEqual([]);
  // Offline again: the garage is gone; the offline page has nothing saved.
  await context.setOffline(true);
  await page.goto('/en/garage');
  await expect(page.getByRole('heading', { level: 1, name: "You're offline" })).toBeVisible();
  await expect(page.getByText(nickname)).toHaveCount(0);
  await expect(page.getByText('Nothing is saved on this device yet.', { exact: false })).toBeVisible();
  await context.setOffline(false);
});

test('a new worker waits for "Reload", then takes over', async ({ page, context, baseURL }) => {
  await gotoReady(page, '/en');
  await waitForWorker(page);
  const version = () =>
    page.evaluate(
      () =>
        new Promise<string>((resolve) => {
          navigator.serviceWorker.addEventListener('message', (e) => resolve((e.data as { version: string }).version), { once: true });
          navigator.serviceWorker.controller!.postMessage({ type: 'cp:version' });
        }),
    );
  const before = await version();
  // Demo builds salt the worker's version with this cookie: a "new release" without a rebuild.
  await context.addCookies([{ name: 'cp_sw_salt', value: `e2e${Date.now().toString(36)}`, url: baseURL! }]);
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.update());
  const bar = page.getByTestId('update-bar');
  await expect(bar).toBeVisible({ timeout: 30_000 });
  // Still the old worker until the user agrees.
  expect(await version()).toBe(before);
  await Promise.all([page.waitForEvent('load'), bar.getByRole('button', { name: 'Reload' }).click()]);
  await waitForWorker(page);
  await expect.poll(version).not.toBe(before);
  expect(await version()).toMatch(/-e2e/);
  await context.clearCookies({ name: 'cp_sw_salt' });
});

/** A Push API without a push service: subscribe() returns a fixed subscription (the endpoint is never called). */
async function mockPushService(context: BrowserContext, baseURL: string) {
  await context.grantPermissions(['notifications'], { origin: new URL(baseURL).origin });
  await context.addInitScript(() => {
    const key = `mock-${Math.random().toString(36).slice(2)}`;
    let current: PushSubscription | null = null;
    const make = () =>
      ({
        endpoint: `https://push.mock.carpal.test/${key}`,
        expirationTime: null,
        options: { userVisibleOnly: true, applicationServerKey: null },
        getKey: () => null,
        toJSON: () => ({
          endpoint: `https://push.mock.carpal.test/${key}`,
          expirationTime: null,
          keys: { p256dh: 'BMock', auth: 'mockauth' },
        }),
        unsubscribe: async () => {
          current = null;
          return true;
        },
      }) as unknown as PushSubscription;
    PushManager.prototype.subscribe = async function () {
      current = make();
      return current;
    };
    PushManager.prototype.getSubscription = async function () {
      return current;
    };
  });
}

test('web push: subscribe with a mocked push service, show a pushed notification, revoke at logout', async ({
  page,
  context,
  request,
  baseURL,
}) => {
  test.setTimeout(180_000);
  await mockPushService(context, baseURL!);
  const user = await createUser(request);
  await signIn(page, user);
  await gotoReady(page, '/en/settings/notifications');
  await waitForWorker(page);
  const card = page.getByTestId('web-push-card');
  const register = page.waitForResponse((r) => r.url().endsWith('/api/v1/me/push-tokens') && r.request().method() === 'POST');
  await card.getByRole('switch', { name: 'Notifications in this browser' }).click();
  const res = await register;
  expect(res.status()).toBe(201);
  const body = JSON.parse(res.request().postData()!) as { platform: string; token: string };
  expect(body.platform).toBe('web');
  expect(JSON.parse(body.token)).toMatchObject({ endpoint: expect.stringContaining('push.mock.carpal.test') });
  const tokenId = ((await res.json()) as { push_token_id: string }).push_token_id;
  await expect(card.getByRole('switch', { name: 'Notifications in this browser' })).toBeChecked();
  await expectNoAxeViolations(page);

  // A push message delivered to the worker as the push service would (Chromium DevTools protocol).
  const cdp = await context.newCDPSession(page);
  const registrations = new Map<string, boolean>();
  cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => {
    for (const r of e.registrations) registrations.set(r.registrationId, !r.isDeleted);
  });
  await cdp.send('ServiceWorker.enable');
  await expect.poll(() => [...registrations.values()].some(Boolean)).toBe(true);
  const origin = new URL(page.url()).origin;
  await cdp.send('ServiceWorker.deliverPushMessage', {
    origin,
    registrationId: [...registrations].find(([, live]) => live)![0],
    data: JSON.stringify({
      title: 'Reza Auto confirmed your appointment',
      body: 'Tuesday 10:00',
      data: { notification_id: 'n-e2e', template_key: 'appointment.confirmed' },
    }),
  });
  await expect
    .poll(() => page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => n.title)))
    .toContain('Reza Auto confirmed your appointment');
  // The worker opens it on the notifications page by its id (DI-66).
  expect(
    await page.evaluate(async () =>
      (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => (n.data as { target: string }).target),
    ),
  ).toContain('/en/notifications?open=n-e2e');

  const revoke = page.waitForRequest((r) => r.url().endsWith(`/api/v1/me/push-tokens/${tokenId}`) && r.method() === 'DELETE');
  await logOutFromPublicPage(page);
  await revoke;
  expect(await page.evaluate(() => localStorage.getItem('cp:pwa:push'))).toBeNull();
});
