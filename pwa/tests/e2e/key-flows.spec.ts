// P13.T1: the consumer key flows of Docs/01 §10 in EN and FA, in the built PWA against the live backend (`pnpm dev` in
// backend/ with the env of pwa/README.md). One provider is seeded per run at a fresh point in Tehran, for a car brand
// only it covers, and the lite index is polled until it finds it (BA-33).
//   Flow 1 — Help Me: describe the problem, the clarifying question, the safety step, explained recommendations near
//            the browser, request with history shared, the pre-visit summary, the shop confirms and completes (API),
//            Leave a review → Verified visit, published by the automatic checks.
//            With CARPAL_E2E_MCP_UNAVAILABLE=1 (backend started with CARPAL_MCP_MODE=unavailable, BA-02) the same test
//            takes the category path and the shop gets "Triage: not provided".
//   Flow 5 — without Help Me: text search → Understood as chips → the shop's card with a reason → profile → Directions
//            (the app list) → Request appointment → the request has no triage. No search text in any URL.
//   Flow 6 — the emailed review invitation: /l/ri link as a guest, sign in, the mailed one-time code, the review form
//            with Verified visit, published; the used link explains itself.
// axe on the main page of every step.
import { randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { API, AUTH, backendUp, createUser, now, readMail } from './accounts';
import { businessUser, inviteByEmail, seedProvider, taxonomy, type SeededProvider } from './businesses';
import {
  bff,
  hostedSignIn,
  nearMe,
  nodes,
  rareCar,
  retire,
  quietPoint,
  rate,
  recordUrls,
  say,
  shopCompletes,
  signIn,
  SSR,
  waitIndexed,
  type Locale,
} from './flows';
import { decideCookies, expectNoAxeViolations, gotoReady } from './support';

test.describe.configure({ mode: 'serial' });

const MCP_UNAVAILABLE = process.env.CARPAL_E2E_MCP_UNAVAILABLE === '1';
const LOCALES: Locale[] = ['en', 'fa'];

/** The shop and the browser: a fresh point per run, so the shops of earlier runs are farther away. */
const POINT = quietPoint();

let up = false;
let shop: SeededProvider;
let hex = '';
let car: { brand: string; model: string };
let suspension: Record<Locale, string> = { en: '', fa: '' };
let seedRequest: APIRequestContext | null = null;

test.beforeAll(async ({ playwright }) => {
  test.setTimeout(300_000);
  const request = (seedRequest = await playwright.request.newContext());
  up = await backendUp(request);
  if (!up) return;
  const n = await taxonomy(request);
  car = await rareCar(request);
  const system = (await nodes(request, 'service_system')).find((x) => x.slug === 'suspension')!;
  suspension = {
    en: system.name.text,
    fa: (await nodes(request, 'service_system', { locale: 'fa' })).find((x) => x.slug === 'suspension')!.name.text,
  };
  hex = randomBytes(3).toString('hex');
  shop = await seedProvider(
    request,
    { ...n, ...car, system: system.id },
    { name: `Key Flow Suspension ${hex}`, point: POINT, rules: false },
  );
  await waitIndexed(request, shop.id, `Key Flow Suspension ${hex}`);
});

test.afterAll(async () => {
  await retire(shop);
  await seedRequest?.dispose();
});

test.beforeEach(async ({ context, baseURL }) => {
  test.skip(!up, 'needs the backend (`pnpm dev` in backend/)');
  await decideCookies(context, baseURL!);
  await context.grantPermissions(['geolocation'], { origin: baseURL! });
  await context.setGeolocation({ latitude: POINT.lat, longitude: POINT.lng });
});

async function addCar(page: Page, nickname: string): Promise<string> {
  const r = await bff(page, 'POST', '/v1/me/vehicles', { brand_node_id: car.brand, model_node_id: car.model, year: 2012, nickname });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}

async function publicReviewLabel(request: APIRequestContext, startsWith: string): Promise<string | undefined> {
  const tok = await request.post(`${AUTH}/oauth/token`, {
    form: { grant_type: 'client_credentials', client_id: 'cp-ssr', scope: 'public.read' },
    headers: { 'carpal-client': SSR },
  });
  const { access_token, token_type } = (await tok.json()) as { access_token: string; token_type: string };
  const res = await request.get(`${API}/v1/public/orgs/${shop.id}/reviews?limit=50`, {
    headers: { authorization: `${token_type} ${access_token}`, 'carpal-client': SSR, 'accept-language': 'en' },
  });
  const items = ((await res.json()) as { items: { label: string; body: string }[] }).items;
  return items.find((r) => r.body.startsWith(startsWith))?.label;
}

/** The shop's card among the recommendations (the top three, else "more matches"). */
async function requestFromRecommendations(page: Page, locale: Locale) {
  const card = page.locator('article.pwa-result').filter({ hasText: shop.name }).first();
  await expect(async () => {
    if (!(await card.isVisible())) {
      const more = page.locator('details.pwa-disclosure:not([open]) > summary');
      if (await more.count()) await more.first().click();
    }
    await expect(card).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  await card.getByRole('button', { name: say(locale, 'help.recommendations.request') }).click();
  await page.waitForURL(/\/help\/[0-9a-f-]{36}\/request$/);
}

/** The review form of a completed visit: stars, text, submit; published by the automatic checks (Path 1). */
async function writeVerifiedReview(page: Page, request: APIRequestContext, locale: Locale, text: string) {
  await expect(page.getByText(say(locale, 'reviews.context.verifiedVisit')).first()).toBeVisible({ timeout: 30_000 });
  await expectNoAxeViolations(page);
  await rate(page, locale, say(locale, 'reviews.form.overall'), 5);
  await page.getByLabel(say(locale, 'reviews.form.body'), { exact: true }).fill(text);
  await page.getByRole('button', { name: say(locale, 'reviews.form.submit') }).click();
  await expect(page.getByTestId('review-submitted')).toBeVisible();
  await expectNoAxeViolations(page);
  await expect.poll(() => publicReviewLabel(request, text.slice(0, 30)), { timeout: 90_000 }).toBe('verified_visit');
}

for (const L of LOCALES) {
  test(`Flow 1 in ${L}: Help Me → explained recommendations → request → visit → verified review`, async ({ page, request }) => {
    test.setTimeout(420_000);
    const user = await createUser(request, { locale: L });
    await signIn(page, L, user);
    await addCar(page, L === 'fa' ? 'نقره‌ای' : 'Silver');

    // Describe (Flow 1 steps 2-4).
    await gotoReady(page, `/${L}/help`);
    await expectNoAxeViolations(page);
    await page
      .getByLabel(say(L, 'help.describe.label'))
      .fill(
        L === 'fa' ? 'از دیروز صدای تق‌تق در دست‌انداز از جلوی راست می‌آید' : 'Clunking over bumps from the front right since yesterday',
      );
    await page.getByRole('button', { name: say(L, 'help.describe.start') }).click();
    await page.waitForURL(/\/help\/[0-9a-f-]{36}\/(questions|safety)$/);

    // Clarifying question (step 5), when the AI asks one.
    if (page.url().endsWith('/questions')) {
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expectNoAxeViolations(page);
      await page.getByLabel(say(L, 'help.questions.answer')).fill(L === 'fa' ? 'فقط روی دست‌انداز' : 'Only over bumps');
      await page.getByRole('button', { name: say(L, 'help.questions.next') }).click();
      await page.waitForURL(/\/safety$/);
    }
    if (MCP_UNAVAILABLE) await expect(page.getByText(say(L, 'help.aiOff.title')).first()).toBeVisible();
    await expectNoAxeViolations(page);
    await page.getByRole('button', { name: say(L, 'help.safety.seeRecommendations') }).click();
    await page.waitForURL(/\/recommendations$/);

    // Likely category and providers with explanations (steps 6-8); AI off: the category picker.
    if (MCP_UNAVAILABLE) {
      await page
        .getByRole('group', { name: say(L, 'help.categories.pick') })
        .getByRole('button', { name: suspension[L], exact: true })
        .click();
    } else await expect(page.getByText(say(L, 'help.recommendations.aiSummary'))).toBeVisible();
    await nearMe(page, L);
    await expect(page.locator('article.pwa-result').first()).toBeVisible({ timeout: 30_000 });
    await expectNoAxeViolations(page);
    await requestFromRecommendations(page, L);

    // Request (step 10) with the pre-visit summary the shop will receive (step 12).
    await expect(page.getByText(shop.name).first()).toBeVisible();
    await page.getByRole('button', { name: say(L, 'appointments.times.add') }).click();
    await page.getByLabel(say(L, 'help.request.shareHistory')).check();
    await page.getByRole('button', { name: say(L, 'help.request.preview') }).click();
    const drawer = page.getByRole('dialog', { name: say(L, 'appointments.preVisit.title') });
    await expect(
      drawer.getByText(MCP_UNAVAILABLE ? say(L, 'appointments.preVisit.noTriage') : say(L, 'appointments.preVisit.aiSummary')),
    ).toBeVisible();
    await expectNoAxeViolations(page);
    await drawer.getByRole('button', { name: say(L, 'common.actions.close') }).click();
    await page.getByRole('button', { name: say(L, 'help.request.send') }).click();
    await page.waitForURL(/\/done$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(shop.name);
    await page.getByRole('link', { name: say(L, 'help.done.track') }).click();
    await page.waitForURL(new RegExp(`/${L}/appointments/[0-9a-f-]{36}`));
    const appointmentId = /appointments\/([0-9a-f-]{36})/.exec(page.url())![1]!;
    await expect(page.getByRole('heading', { level: 1, name: say(L, 'appointments.status.requested') })).toBeVisible();

    // The shop confirms, the repair is done (steps 11, 13).
    await shopCompletes(shop, appointmentId);
    await gotoReady(page, `/${L}/appointments/${appointmentId}`);
    await expect(page.getByRole('heading', { level: 1, name: say(L, 'appointments.status.completed') })).toBeVisible();
    await expectNoAxeViolations(page);

    // A verified review (step 14).
    await expect(async () => {
      await page.reload();
      await expect(page.getByTestId('leave-review')).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 60_000 });
    await page.getByTestId('leave-review').click();
    await page.waitForURL(new RegExp(`/${L}/review/${shop.slug}`));
    await writeVerifiedReview(page, request, L, `Flow 1 ${L} ${hex}: the clunk was the control arm, fixed the same day.`);
  });

  test(`Flow 5 in ${L}: search without Help Me → chips → card → profile → directions → request without triage`, async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000);
    const user = await createUser(request, { locale: L });
    await signIn(page, L, user);
    await addCar(page, L === 'fa' ? 'سفید' : 'White');
    const urls = recordUrls(page);
    const text = `${suspension[L]} ${hex}`;

    await gotoReady(page, `/${L}`);
    await page.getByRole('combobox', { name: say(L, 'shell.header.searchLabel') }).fill(text);
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/search\/[0-9a-f-]{36}/, { timeout: 30_000 });
    await expect(page.getByRole('group', { name: say(L, 'search.chips.label') })).toContainText(suspension[L]);
    const card = page.getByRole('link', { name: shop.name });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('article.pwa-result', { has: card }).locator('.pwa-result-reason')).not.toBeEmpty();
    await expectNoAxeViolations(page);
    await card.click();
    await page.waitForURL(`**/${L}/shop/${shop.slug}`);
    await page.locator('html[data-hydrated="true"]').waitFor({ state: 'attached' });

    // Directions in an external app (Docs/90 S-SHARED-10): the menu lists the region's apps.
    await page
      .getByRole('button', { name: say(L, 'profiles.location.directions') })
      .first()
      .click();
    await expect(page.locator('.pwa-popover a[href^="https://"]:visible').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expectNoAxeViolations(page);

    // Request appointment: a direct request (no triage), in the user's own words.
    // The shop publishes no openings (rules: false), so the profile offers "Request anyway".
    await page
      .getByRole('button', { name: say(L, 'profiles.request.requestAnyway') })
      .first()
      .click();
    await page.waitForURL(/\/help\/[0-9a-f-]{36}\/request$/, { timeout: 30_000 });
    await page
      .getByLabel(say(L, 'help.request.needLabel'))
      .fill(L === 'fa' ? 'صدای جلوبندی در دست‌انداز' : 'A knock from the front suspension over bumps');
    await page.getByRole('button', { name: say(L, 'appointments.times.add') }).click();
    await page.getByRole('button', { name: say(L, 'help.request.preview') }).click();
    const drawer = page.getByRole('dialog', { name: say(L, 'appointments.preVisit.title') });
    await expect(drawer.getByText(say(L, 'appointments.preVisit.noTriage'))).toBeVisible();
    await expectNoAxeViolations(page);
    await drawer.getByRole('button', { name: say(L, 'common.actions.close') }).click();
    await page.getByRole('button', { name: say(L, 'help.request.send') }).click();
    await page.waitForURL(/\/done$/);
    await page.getByRole('link', { name: say(L, 'help.done.track') }).click();
    await expect(page.getByText(say(L, 'appointments.detail.noTriage'))).toBeVisible();
    await expectNoAxeViolations(page);

    // No search text or coordinates in any URL (Docs/40 TR-7).
    for (const u of urls) {
      expect(u, u).not.toContain(encodeURIComponent(text));
      expect(u, u).not.toMatch(/[?&](lat|lng|q|text|query)=/);
    }
  });

  test(`Flow 6 in ${L}: the emailed invitation, the one-time code and a Verified visit review`, async ({ page, request }) => {
    test.setTimeout(240_000);
    const sara = await businessUser(request, `p13-${L}`);
    const vehicle = await sara.call('POST', '/v1/me/vehicles', { brand_node_id: car.brand, model_node_id: car.model, year: 2012 });
    expect(vehicle.status, JSON.stringify(vehicle.body)).toBe(201);
    const consent = await sara.call('POST', '/v1/me/consents', { consent_type: 'review_invitations', policy_version: '1.0' });
    expect(consent.status, JSON.stringify(consent.body)).toBeLessThan(300);
    await inviteByEmail(sara);
    const from = new Date(Date.now() + 26 * 3_600_000);
    const appt = await sara.call('POST', '/v1/me/appointments', {
      provider_organization_id: shop.id,
      provider_location_id: shop.locationId,
      vehicle_id: vehicle.body.id,
      source: 'direct_search',
      appointment_type: 'repair',
      service_mode: 'in_shop',
      description: 'Clunk from the front right over bumps',
      content_locale: L,
      urgency_level: 'medium',
      time_windows: [{ start_at: from.toISOString(), end_at: new Date(from.getTime() + 3 * 3_600_000).toISOString(), priority: 1 }],
      submit: true,
    });
    expect(appt.status, JSON.stringify(appt.body)).toBe(201);
    const appointmentId = appt.body.id as string;
    await shopCompletes(shop, appointmentId);

    // The completion created the automatic in-app invitation; the shop replaces it by an email invitation.
    let inApp: { id: string } | undefined;
    await expect
      .poll(
        async () => {
          const list = await shop.api.call('GET', `/v1/orgs/${shop.id}/review-invitations?limit=50`);
          inApp = (list.body.items as { id: string; visit: { id: string }; status: string }[]).find(
            (i) => i.visit.id === appointmentId && i.status === 'sent',
          );
          return !!inApp;
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    expect((await shop.api.call('POST', `/v1/orgs/${shop.id}/review-invitations/${inApp!.id}/cancel`)).status).toBeLessThan(300);
    const sent = now();
    const invited = await shop.api.call('POST', `/v1/orgs/${shop.id}/review-invitations`, {
      appointment_id: appointmentId,
      channel: 'email',
    });
    expect(invited.status, JSON.stringify(invited.body)).toBeLessThan(300);
    const token = (await readMail(sara.email, 'review.invitation', sent)).variables.link!.split('#')[1]!;

    // The link page in the visitor's language (the cp_locale cookie of the first visit).
    await gotoReady(page, `/${L}`);
    const opened = now();
    await page.goto(`/l/ri#${token}`);
    await expect(page.getByRole('heading', { level: 1, name: say(L, 'reviews.invite.heading', { name: shop.name }) })).toBeVisible();
    await expect(page).toHaveURL(/\/l\/ri$/);
    await expectNoAxeViolations(page);
    await page.getByRole('button', { name: say(L, 'reviews.invite.signIn') }).click();
    await hostedSignIn(page, L, sara);
    await page.waitForURL(/\/l\/ri$/);
    await expect(page.getByText(say(L, 'reviews.invite.confirmTitle'))).toBeVisible();
    await expectNoAxeViolations(page);
    const code = (await readMail(sara.email, 'review.invitation_code', opened)).variables.code!;
    await page.getByRole('textbox').first().fill(code);
    await page.waitForURL(new RegExp(`/${L}/review/${shop.slug}\\?invite=1$`));
    await writeVerifiedReview(page, request, L, `Flow 6 ${L} ${hex}: clear explanation and the price matched the estimate.`);

    await page.goto(`/l/ri#${token}`);
    await expect(page.getByText(say(L, 'reviews.invite.used'))).toBeVisible();
  });
}
