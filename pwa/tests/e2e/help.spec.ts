// P10.T7: Help Me and appointments in the built PWA against the live backend (`pnpm dev` in backend/ with the env of
// pwa/README.md; the AI is the deterministic stub, CARPAL_MCP_MODE=stub, the dev default).
//   1. Sara's Ch. 6-8 in FA: she describes the clunk, answers the question, sees the urgency, finds Reza Auto
//      Suspension near her (Near me), requests a visit (no published openings: "Request anyway") with her service
//      history shared, previews what the shop receives (the Help Me summary), sends; the shop confirms through the API,
//      she checks in by the mailed link, the shop completes the job and the appointment shows the service record.
//   2. AI off (ai.triage.enabled switched off with the dev-only flag CLI, DI-18; restored afterwards): the BFF passes
//      the triage's 503 AI_UNAVAILABLE with the safety block and the search path through (BA-02), the wizard takes the
//      category path, and the request reaches the shop as "Triage: not provided".
// axe on every visited step. The run with CARPAL_MCP_MODE=unavailable is the same second test against a backend
// started that way (pwa/dev_plan.json P10 report).
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { API, AUTH, backendUp, createUser, now, readMail } from './accounts';
import { seedProvider, taxonomy, tehranPoint, type SeededProvider } from './businesses';
import { decideCookies, expectNoAxeViolations, gotoReady } from './support';

test.describe.configure({ mode: 'serial' });

const BACKEND = join(import.meta.dirname, '..', '..', '..', 'backend');
/** Set when the backend runs with CARPAL_MCP_MODE=unavailable (the pilot's AI state, BA-02): only the AI-off test runs. */
const MCP_UNAVAILABLE = process.env.CARPAL_E2E_MCP_UNAVAILABLE === '1';
const SSR = 'cp-ssr/0.1.0 (web 1.0)';
/** The shop and the browser's position: a fresh point in Tehran per run, so earlier runs' shops are farther away. */
const POINT = tehranPoint();

const DICT = (locale: 'fa' | 'en') =>
  JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'shared', 'i18n', 'locales', `${locale}.json`), 'utf8')) as Record<
    string,
    unknown
  >;
const FA = DICT('fa');
const EN = DICT('en');
function word(dict: Record<string, unknown>, key: string): string {
  const v = key.split('.').reduce<unknown>((node, k) => (node as Record<string, unknown>)[k], dict);
  if (typeof v !== 'string') throw new Error(`no string ${key}`);
  return v;
}
const fa = (key: string) => word(FA, key);
const en = (key: string) => word(EN, key);

let up = false;
let shop: SeededProvider;
let n: Awaited<ReturnType<typeof taxonomy>>;
/** Kept open for the whole file: the shop's API helper (confirm, complete) uses it. */
let seedRequest: APIRequestContext | null = null;

async function ssrToken(request: APIRequestContext): Promise<string> {
  const tok = await request.post(`${AUTH}/oauth/token`, {
    form: { grant_type: 'client_credentials', client_id: 'cp-ssr', scope: 'public.read' },
    headers: { 'carpal-client': SSR },
  });
  const { access_token, token_type } = (await tok.json()) as { access_token: string; token_type: string };
  return `${token_type} ${access_token}`;
}

/**
 * A brand with a model other than the one the P5/P6 shops cover (taxonomy() takes the first): Sara's car, which only
 * this run's shop covers as a specialist, so it ranks first near her among the many E2E shops of earlier runs.
 */
async function otherBrand(request: APIRequestContext): Promise<{ brand: string; model: string }> {
  const auth = await ssrToken(request);
  const list = async (type: string, parent?: string) => {
    const res = await request.get(`${API}/v1/taxonomy/nodes?type=${type}&limit=50${parent ? `&parent_id=${parent}` : ''}`, {
      headers: { authorization: auth, 'carpal-client': SSR, 'accept-language': 'en' },
    });
    return ((await res.json()) as { items: { id: string }[] }).items;
  };
  for (const b of (await list('vehicle_brand')).slice(1).reverse()) {
    const models = await list('vehicle_model', b.id);
    if (models.length) return { brand: b.id, model: models[0]!.id };
  }
  throw new Error('no second brand with a model');
}

/** Polls search.run until the shop is found by its name (the lite index sweeps every minute). */
async function waitIndexed(request: APIRequestContext, orgId: string, text: string) {
  const auth = await ssrToken(request);
  await expect
    .poll(
      async () => {
        const res = await request.post(`${API}/v1/search`, {
          data: { query_text: text, search_mode: 'all', entry_point: 'search_box', location: { mode: 'chosen_city', city_key: 'tehran' } },
          headers: { authorization: auth, 'carpal-client': SSR, 'accept-language': 'en' },
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
  const request = (seedRequest = await playwright.request.newContext());
  up = await backendUp(request);
  if (!up) return;
  n = { ...(await taxonomy(request)), ...(await otherBrand(request)) };
  const res = await request.get(`${API}/v1/taxonomy/nodes?type=service_system&limit=50`, {
    headers: { authorization: await ssrToken(request), 'carpal-client': SSR, 'accept-language': 'en' },
  });
  const suspension = ((await res.json()) as { items: { id: string; slug: string }[] }).items.find((x) => x.slug === 'suspension')!;
  const name = `Reza Auto Suspension ${randomBytes(3).toString('hex')}`;
  shop = await seedProvider(request, { ...n, system: suspension.id }, { name, point: POINT, rules: false });
  await waitIndexed(request, shop.id, name);
});

test.afterAll(async () => {
  await seedRequest?.dispose();
});

test.beforeEach(async ({ context, baseURL }) => {
  test.skip(!up, 'needs the backend (`pnpm dev` in backend/)');
  await decideCookies(context, baseURL!);
  await context.grantPermissions(['geolocation'], { origin: baseURL! });
  await context.setGeolocation({ latitude: POINT.lat, longitude: POINT.lng });
});

/** Signs a fresh account in through the hosted sign-in and skips the onboarding. */
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

/** A BFF call from the page (CSRF token, idempotency key), like the typed client makes it. */
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

async function addCar(page: Page): Promise<string> {
  const r = await bff(page, 'POST', '/v1/me/vehicles', { brand_node_id: n.brand, model_node_id: n.model, year: 2012, nickname: 'Silver' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}

/** "Near me" on the location chip: the location consent, then the browser's (mocked) position. */
async function nearMe(page: Page, t: (key: string) => string) {
  await page.getByRole('button', { name: new RegExp(t('search.location.change').split('{{')[0]!.trim()) }).click();
  await page.getByRole('button', { name: t('search.location.nearMe') }).click();
  const allow = page.getByRole('button', { name: t('search.location.allow') });
  if (await allow.isVisible().catch(() => false)) await allow.click();
}

/** The shop's card among the recommendations (the top three, else "more matches"). */
async function requestFromRecommendations(page: Page, t: (key: string) => string) {
  const card = page.locator('article.pwa-result').filter({ hasText: shop.name }).first();
  await expect(async () => {
    if (!(await card.isVisible())) {
      const more = page.locator('details.pwa-disclosure:not([open]) > summary');
      if (await more.count()) await more.first().click();
    }
    await expect(card).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 45_000 });
  await card.getByRole('button', { name: t('help.recommendations.request') }).click();
  await page.waitForURL(/\/help\/[0-9a-f-]{36}\/request$/);
}

async function shopMoves(appointmentId: string, body: Record<string, unknown>) {
  const r = await shop.api.call('POST', `/v1/orgs/${shop.id}/provider/appointments/${appointmentId}/transitions`, body);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

test('Sara Ch. 6-8 in FA: describe the clunk, see Reza Auto Suspension, request, the shop confirms, check in by link, completed', async ({
  page,
  request,
}) => {
  test.skip(MCP_UNAVAILABLE, 'needs the AI stub (CARPAL_MCP_MODE=stub)');
  test.setTimeout(300_000);
  const user = await createUser(request, { locale: 'fa', fullName: 'Sara Example' });
  await signIn(page, user);
  await addCar(page);

  // Ch. 6: describe it (the stub recognises "Clunking over bumps" and asks when it happens).
  await gotoReady(page, '/fa/help');
  await expectNoAxeViolations(page);
  await page.getByLabel(fa('help.describe.label')).fill('از دیروز صدای تق‌تق در دست‌انداز از جلوی راست می‌آید');
  await page.getByRole('button', { name: fa('help.describe.start') }).click();
  await page.waitForURL(/\/fa\/help\/[0-9a-f-]{36}\/questions$/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expectNoAxeViolations(page);
  await page.getByLabel(fa('help.questions.answer')).fill('فقط هنگام حرکت روی دست‌انداز');
  await page.getByRole('button', { name: fa('help.questions.next') }).click();
  await page.waitForURL(/\/safety$/);
  await expect(page.getByText(fa('help.safety.level.medium'))).toBeVisible();
  await expectNoAxeViolations(page);
  await page.getByRole('button', { name: fa('help.safety.seeRecommendations') }).click();
  await page.waitForURL(/\/recommendations$/);

  // Ch. 7: the recommendations with their explanation; Reza is near her.
  await expect(page.getByText(fa('help.recommendations.aiSummary'))).toBeVisible();
  await expect(page.getByRole('heading', { name: fa('help.case.title') })).toBeVisible();
  await expect(page.locator('article.pwa-result').first()).toBeVisible();
  await expectNoAxeViolations(page);
  await nearMe(page, fa);
  await requestFromRecommendations(page, fa);
  await expect(page.getByText(shop.name).first()).toBeVisible();
  await expect(page.getByText(fa('appointments.times.noSlots'))).toBeVisible();
  await page.getByRole('button', { name: fa('appointments.times.add') }).click();
  await page.getByLabel(fa('help.request.shareHistory')).check();
  await expectNoAxeViolations(page);

  // What the shop receives: the Help Me summary (approved by sending) and the shared history.
  await page.getByRole('button', { name: fa('help.request.preview') }).click();
  const drawer = page.getByRole('dialog', { name: fa('appointments.preVisit.title') });
  await expect(drawer.getByText(fa('appointments.preVisit.aiSummary'))).toBeVisible();
  await expect(drawer.getByText(new RegExp(fa('appointments.preVisit.previewOf').split('{{')[0]!.trim()))).toBeVisible();
  await expectNoAxeViolations(page);
  await drawer.getByRole('button', { name: fa('common.actions.close') }).click();
  await page.getByRole('button', { name: fa('help.request.send') }).click();
  await page.waitForURL(/\/done$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(shop.name);
  await expectNoAxeViolations(page);
  await page.getByRole('link', { name: fa('help.done.track') }).click();
  await page.waitForURL(/\/fa\/appointments\/[0-9a-f-]{36}/);
  const appointmentId = /appointments\/([0-9a-f-]{36})/.exec(page.url())![1]!;
  await expect(page.getByRole('heading', { level: 1, name: fa('appointments.status.requested') })).toBeVisible();
  await expectNoAxeViolations(page);

  // Ch. 8: the shop confirms (in 30 minutes, inside the check-in window); the ci link is mailed.
  const since = now();
  const start = new Date(Date.now() + 30 * 60_000);
  start.setSeconds(0, 0);
  await shopMoves(appointmentId, { to: 'confirmed', confirmed_start_at: start.toISOString(), estimated_duration_minutes: 60 });
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: fa('appointments.status.confirmed') })).toBeVisible();
  await expect(page.getByRole('button', { name: fa('appointments.action.arrived') })).toBeEnabled();
  await expect(page.getByText(shop.name).first()).toBeVisible();
  await expectNoAxeViolations(page);

  const mail = await readMail(user.email, 'appointment.check_in_link', since);
  const token = mail.variables.link!.split('#')[1]!;
  await page.goto(`/l/ci#${token}`);
  await page
    .getByRole('button', { name: new RegExp(`${fa('appointments.checkIn.arrived')}|${en('appointments.checkIn.arrived')}`) })
    .click();
  await expect(page.getByText(new RegExp(`${fa('appointments.checkIn.done')}|${en('appointments.checkIn.done')}`)).first()).toBeVisible();
  await expect(page).toHaveURL(/\/l\/ci$/);
  await expectNoAxeViolations(page);

  // The job is done: the service record is in the garage.
  await shopMoves(appointmentId, { to: 'in_progress' });
  await shopMoves(appointmentId, { to: 'completed' });
  await gotoReady(page, `/fa/appointments/${appointmentId}`);
  await expect(page.getByRole('heading', { level: 1, name: fa('appointments.status.completed') })).toBeVisible();
  await expect(page.getByRole('link', { name: fa('appointments.action.record') })).toBeVisible();
  await expectNoAxeViolations(page);
});

test('AI off: the triage answers 503 with the safety block, the category path still sends a request without triage', async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  const flags = (state: 'on' | 'off') =>
    execFileSync('pnpm', ['-s', 'dev:flags', 'set', 'ai.triage.enabled', state], {
      cwd: BACKEND,
      stdio: 'pipe',
      shell: process.platform === 'win32',
    });
  // Two ways AI is off: the flag (the PWA's config says so and the wizard skips triage) or the MCP gateway (the flag
  // is on, the server answers triage.start with 503 itself and the wizard turns to the category path).
  if (!MCP_UNAVAILABLE) flags('off');
  try {
    const user = await createUser(request, { locale: 'en' });
    await signIn(page, user);
    const vehicleId = await addCar(page);

    // The server's answer (BA-02), passed through the BFF unchanged: 503 with the safety block and the search path.
    await expect
      .poll(
        async () =>
          (await bff(page, 'POST', '/v1/me/triage-sessions', { vehicle_id: vehicleId, text: 'The brakes feel soft', locale: 'en' })).status,
        {
          timeout: 90_000,
          intervals: [5_000],
        },
      )
      .toBe(503);
    const off = await bff(page, 'POST', '/v1/me/triage-sessions', { vehicle_id: vehicleId, text: 'The brakes feel soft', locale: 'en' });
    expect(off.body).toMatchObject({ code: 'AI_UNAVAILABLE', fallback_path: '/v1/search', safety: { flag: true } });

    if (MCP_UNAVAILABLE) await gotoReady(page, '/en/help');
    // With the flag off the PWA's config follows within its cache time: the landing says guided help is unavailable.
    else
      await expect(async () => {
        await gotoReady(page, '/en/help');
        await expect(page.getByText(en('help.aiOff.title')).first()).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 120_000, intervals: [5_000] });
    await page.getByLabel(en('help.describe.label')).fill('A knock from the front over speed bumps');
    await page.getByRole('button', { name: en('help.describe.start') }).click();
    await page.waitForURL(/\/safety$/);
    await expect(page.getByText(en('help.aiOff.title')).first()).toBeVisible();
    await expectNoAxeViolations(page);
    await page.getByRole('button', { name: en('help.safety.seeRecommendations') }).click();
    await page.waitForURL(/\/recommendations$/);
    await expect(page.getByText(en('help.categories.chooseText'))).toBeVisible();
    await page
      .getByRole('group', { name: en('help.categories.pick') })
      .getByRole('button', { name: 'Suspension', exact: true })
      .click();
    await nearMe(page, en);
    await requestFromRecommendations(page, en);
    await page.getByRole('button', { name: en('appointments.times.add') }).click();
    await page.getByRole('button', { name: en('help.request.preview') }).click();
    const drawer = page.getByRole('dialog', { name: en('appointments.preVisit.title') });
    await expect(drawer.getByText(en('appointments.preVisit.noTriage'))).toBeVisible();
    await expectNoAxeViolations(page);
    await drawer.getByRole('button', { name: en('common.actions.close') }).click();
    await page.getByRole('button', { name: en('help.request.send') }).click();
    await page.waitForURL(/\/done$/);
    await page.getByRole('link', { name: en('help.done.track') }).click();
    await expect(page.getByText(en('appointments.detail.noTriage'))).toBeVisible();
    await expectNoAxeViolations(page);
  } finally {
    if (!MCP_UNAVAILABLE) flags('on');
  }
});
