// P11.T7: Flow 6 / Sara Ch. 9 in the built PWA against the live backend (`pnpm dev` in backend/).
//   1. Path 1 by the emailed invitation: Sara's visit to the shop is booked, confirmed, checked in and completed through
//      the API; the shop sends her an email invitation (in place of the automatic in-app one, which it cancels — one
//      open invitation per visit). Sara opens the mailed /l/ri#<token> link as a guest (the token leaves the address
//      bar), logs in, enters the mailed one-time code, writes the review and submits: "Verified visit", published by
//      the automatic checks, listed in My Activity and on the public profile with the Verified visit label.
//   2. Path 2 from the profile: "Write a review" without a further visit → "Send for approval" → "Waiting for approval"
//      in My Activity; nothing new on the public profile.
// axe on every visited page.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { API, AUTH, backendUp, now, readMail } from './accounts';
import { businessUser, seedProvider, taxonomy, type BusinessApi, type SeededProvider } from './businesses';
import { decideCookies, expectNoAxeViolations, gotoReady } from './support';

test.describe.configure({ mode: 'serial' });

const SSR = 'cp-ssr/0.1.0 (web 1.0)';

let up = false;
let shop: SeededProvider;
let sara: BusinessApi;
let appointmentId: string;
let seedRequest: APIRequestContext | null = null;

async function ok(r: Promise<{ status: number; body: Record<string, unknown> }>, what: string) {
  const res = await r;
  expect(res.status, `${what}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  return res.body;
}

async function shopMoves(body: Record<string, unknown>) {
  await ok(shop.api.call('POST', `/v1/orgs/${shop.id}/provider/appointments/${appointmentId}/transitions`, body), `to ${String(body.to)}`);
}

async function publicReviews(request: APIRequestContext): Promise<{ id: string; label: string; body: string }[]> {
  const tok = await request.post(`${AUTH}/oauth/token`, {
    form: { grant_type: 'client_credentials', client_id: 'cp-ssr', scope: 'public.read' },
    headers: { 'carpal-client': SSR },
  });
  const { access_token, token_type } = (await tok.json()) as { access_token: string; token_type: string };
  const res = await request.get(`${API}/v1/public/orgs/${shop.id}/reviews?limit=20`, {
    headers: { authorization: `${token_type} ${access_token}`, 'carpal-client': SSR, 'accept-language': 'en' },
  });
  return ((await res.json()) as { items: { id: string; label: string; body: string }[] }).items;
}

test.beforeAll(async ({ playwright }) => {
  test.setTimeout(240_000);
  const request = (seedRequest = await playwright.request.newContext());
  up = await backendUp(request);
  if (!up) return;
  const n = await taxonomy(request);
  shop = await seedProvider(request, n, { rules: false });
  // Sara: a car, the consent to be invited by email, a request that the shop confirms and completes.
  sara = await businessUser(request, 'p11');
  const car = await ok(sara.call('POST', '/v1/me/vehicles', { brand_node_id: n.brand, model_node_id: n.model, year: 2012 }), 'vehicle');
  await ok(sara.call('POST', '/v1/me/consents', { consent_type: 'review_invitations', policy_version: '2026-10' }), 'consent');
  const from = new Date(Date.now() + 26 * 3_600_000);
  const appt = await ok(
    sara.call('POST', '/v1/me/appointments', {
      provider_organization_id: shop.id,
      provider_location_id: shop.locationId,
      vehicle_id: car.id,
      source: 'direct_search',
      appointment_type: 'repair',
      service_mode: 'in_shop',
      service_system_node_id: n.system,
      description: 'Clunk from the front right over bumps',
      content_locale: 'en',
      urgency_level: 'medium',
      time_windows: [{ start_at: from.toISOString(), end_at: new Date(from.getTime() + 3 * 3_600_000).toISOString(), priority: 1 }],
      submit: true,
    }),
    'appointment',
  );
  appointmentId = appt.id as string;
  const start = new Date(Date.now() + 30 * 60_000);
  start.setSeconds(0, 0);
  await shopMoves({ to: 'confirmed', confirmed_start_at: start.toISOString(), estimated_duration_minutes: 60 });
  await shopMoves({ to: 'checked_in' });
  await shopMoves({ to: 'in_progress' });
  await shopMoves({ to: 'completed' });
});

test.afterAll(async () => {
  await seedRequest?.dispose();
});

test.beforeEach(async ({ context, baseURL }) => {
  test.skip(!up, 'needs the backend (`pnpm dev` in backend/)');
  await decideCookies(context, baseURL!);
});

/** The hosted sign-in from wherever the page sent the browser, then "Finish later" on the onboarding. */
async function logIn(page: Page) {
  await page.waitForURL(/\/id\/signin\?interaction_id=/);
  await page.locator('html[data-hydrated="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Mobile number or email').fill(sara.email);
  await page.getByRole('button', { name: 'Use password' }).click();
  await page.getByLabel('Password', { exact: true }).fill(sara.password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForURL(/\/en\/onboarding\?next=/);
  await page.getByRole('link', { name: 'Finish later' }).click();
}

async function rate(page: Page, group: string, n: number) {
  await page
    .getByRole('group', { name: group })
    .locator('label')
    .filter({ hasText: `${n} of 5 stars` })
    .click();
}

test('Flow 6, Path 1: the emailed invitation, the one-time code and a Verified visit review', async ({ page, request }) => {
  test.setTimeout(180_000);
  // The completion created the automatic in-app invitation (one open invitation per visit): the shop replaces it by
  // an email invitation.
  let inApp: { id: string } | undefined;
  await expect
    .poll(
      async () => {
        const list = await shop.api.call('GET', `/v1/orgs/${shop.id}/review-invitations?limit=20`);
        inApp = (list.body.items as { id: string; visit: { id: string }; status: string }[]).find(
          (i) => i.visit.id === appointmentId && i.status === 'sent',
        );
        return !!inApp;
      },
      { timeout: 30_000, message: 'the automatic invitation after completion' },
    )
    .toBe(true);
  await ok(shop.api.call('POST', `/v1/orgs/${shop.id}/review-invitations/${inApp!.id}/cancel`), 'cancel in-app invitation');
  const sent = now();
  await ok(
    shop.api.call('POST', `/v1/orgs/${shop.id}/review-invitations`, { appointment_id: appointmentId, channel: 'email' }),
    'email invitation',
  );
  const link = (await readMail(sara.email, 'review.invitation', sent)).variables.link!;
  const token = link.split('#')[1]!;
  expect(link).toMatch(/\/l\/ri#cp_ri_/);

  // Sara opens the link as a guest: the shop and the visit, the code is mailed, the token leaves the address bar.
  const opened = now();
  await page.goto(`/l/ri#${token}`);
  await expect(page.getByRole('heading', { level: 1, name: `Review your visit to ${shop.name}` })).toBeVisible();
  await expect(page).toHaveURL(/\/l\/ri$/);
  await expectNoAxeViolations(page);
  await page.getByRole('button', { name: 'Log in to continue' }).click();
  await logIn(page);

  // Back on the link page (the tab kept the token; no second code), she enters the code.
  await page.waitForURL(/\/l\/ri$/);
  const code = (await readMail(sara.email, 'review.invitation_code', opened)).variables.code!;
  await expect(page.getByText('Confirm it is you')).toBeVisible();
  await expectNoAxeViolations(page);
  await page.getByRole('textbox').first().fill(code);
  await page.waitForURL(new RegExp(`/en/review/${shop.slug}\\?invite=1$`));

  // The review form: Verified visit, stars by keyboard and click, the text, submit.
  await expect(page.getByText('Verified visit').first()).toBeVisible();
  await expectNoAxeViolations(page);
  await rate(page, 'Overall rating', 5);
  await page.getByRole('group', { name: 'Overall rating' }).getByRole('radio', { name: '5 of 5 stars' }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('group', { name: 'Overall rating' }).getByRole('radio', { name: '4 of 5 stars' })).toBeChecked();
  await rate(page, 'Work quality', 5);
  await page
    .getByLabel('Your review', { exact: true })
    .fill('The clunk was the front right control arm. Reza showed me the worn bushing and the price matched.');
  await page.getByRole('button', { name: 'Submit review' }).click();
  await expect(page.getByTestId('review-submitted')).toBeVisible();
  await expect(page.getByText('Being checked — usually published within minutes')).toBeVisible();
  await expectNoAxeViolations(page);

  // Published by the automatic checks, with the Verified visit label; My Activity says so.
  await expect
    .poll(async () => (await publicReviews(request)).find((r) => r.body.startsWith('The clunk was the front right'))?.label, {
      timeout: 60_000,
    })
    .toBe('verified_visit');
  await gotoReady(page, '/en/activity?tab=reviews');
  const row = page.getByTestId('my-review').first();
  await expect(row.getByText('Published', { exact: true })).toBeVisible();
  await expect(row.getByText(shop.name)).toBeVisible();
  await expectNoAxeViolations(page);

  // The used link explains itself.
  await page.goto(`/l/ri#${token}`);
  await expect(page.getByText('This link was already used')).toBeVisible();
});

test('Path 2 from the profile: Send for approval, then Waiting for approval in My Activity', async ({ page, request }) => {
  test.setTimeout(120_000);
  await gotoReady(page, `/en/shop/${shop.slug}`);
  await page.getByRole('button', { name: 'Write a review' }).click();
  // A guest: the sign-in context modal, then the hosted sign-in; the intent continues to the review page.
  await page.getByRole('dialog').getByRole('button', { name: 'Log in' }).click();
  await logIn(page);
  await page.waitForURL(new RegExp(`/en/review/${shop.slug}$`), { timeout: 30_000 });
  await expect(page.getByText(/No appointment — the shop and CarPal will check this review/)).toBeVisible();
  await expectNoAxeViolations(page);
  await rate(page, 'Overall rating', 4);
  await page.getByLabel('Your review', { exact: true }).fill('Friendly team and a quick look at the brakes before my trip.');
  await page.getByRole('button', { name: 'Send for approval' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Sent for approval' })).toBeVisible();
  await expectNoAxeViolations(page);

  await gotoReady(page, '/en/activity?tab=reviews');
  const waiting = page.getByTestId('my-review').filter({ hasText: 'Friendly team' });
  await expect(waiting.getByText('Waiting for approval', { exact: true })).toBeVisible();
  await expect(waiting.getByRole('link', { name: 'Edit' })).toBeVisible();
  await expectNoAxeViolations(page);
  expect((await publicReviews(request)).some((r) => r.body.startsWith('Friendly team'))).toBe(false);
});
