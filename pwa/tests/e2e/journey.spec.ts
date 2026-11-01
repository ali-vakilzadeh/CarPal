// P13.T1: Sara's story (Docs/10, Chapters 1-11) as one long journey in FA, in the built PWA against the live backend.
//   Ch. 1  sign up on the hosted sign-in (reading the User Agreement in its dialog), verify by the mailed code
//   Ch. 2  onboarding with the first car (VIN, mileage, nickname)
//   Ch. 3  log out, log back in with the password
//   Ch. 4  a second car; a service record on the first; the consents she gave are listed
//   Ch. 5  mileage update; tips no longer by email; the UI in English for a moment and back to Persian
//   Ch. 6-8 Help Me for the clunk, the explained recommendation near her, the request, the shop confirms and completes
//   Ch. 9  the verified service record and a Verified visit review
//   Ch. 10 a question in Q&A; she sells the car: a buyer asks for the transfer by VIN and she accepts (BA-04)
//   Ch. 11 a search without Help Me (Understood as chips) and the map
// axe on the pages of each chapter. The shop is seeded through the API at a fresh point (the browser's position).
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { backendUp, mailedCode, newEmail, now } from './accounts';
import { businessUser, seedProvider, taxonomy, type SeededProvider } from './businesses';
import { digits, hostedSignIn, nearMe, nodes, quietPoint, rareCar, retire, rate, say, shopCompletes, waitIndexed } from './flows';
import { decideCookies, expectNoAxeViolations, gotoReady } from './support';

test.describe.configure({ mode: 'serial' });

const L = 'fa' as const;
const fa = (key: string, vars?: Record<string, string | number>) => say(L, key, vars);
const BACKEND = join(import.meta.dirname, '..', '..', '..', 'backend');
const VIN_CHARS = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';
const MCP_UNAVAILABLE = process.env.CARPAL_E2E_MCP_UNAVAILABLE === '1';
const POINT = quietPoint();
const STYLE_HOST = 'https://cdn.carpal.app';

let up = false;
let shop: SeededProvider;
let car: { brand: string; model: string };
let suspensionFa = '';
let hex = '';
let seedRequest: APIRequestContext | null = null;

test.beforeAll(async ({ playwright, baseURL }) => {
  test.setTimeout(300_000);
  const request = (seedRequest = await playwright.request.newContext());
  up = await backendUp(request);
  if (!up) return;
  execFileSync('pnpm', ['-s', 'dev:flags', 'set', 'community', 'on'], { cwd: BACKEND, stdio: 'pipe', shell: process.platform === 'win32' });
  const n = await taxonomy(request);
  car = await rareCar(request);
  const system = (await nodes(request, 'service_system')).find((x) => x.slug === 'suspension')!;
  suspensionFa = (await nodes(request, 'service_system', { locale: 'fa' })).find((x) => x.slug === 'suspension')!.name.text;
  hex = randomBytes(3).toString('hex');
  shop = await seedProvider(
    request,
    { ...n, ...car, system: system.id },
    { name: `Reza Auto Suspension ${hex}`, point: POINT, rules: false },
  );
  await waitIndexed(request, shop.id, `Reza Auto Suspension ${hex}`);
  // Q&A on in the PWA's cached config (up to a minute).
  await expect
    .poll(async () => (await (await request.get(`${baseURL}/fa/questions`)).text()).includes('data-state="featureOff"'), {
      timeout: 120_000,
      intervals: [2_000],
    })
    .toBe(false);
});

test.afterAll(async () => {
  await retire(shop);
  await seedRequest?.dispose();
});

test.beforeEach(async ({ context, baseURL, page }) => {
  test.skip(!up, 'needs the backend (`pnpm dev` in backend/)');
  await decideCookies(context, baseURL!);
  await context.grantPermissions(['geolocation'], { origin: baseURL! });
  await context.setGeolocation({ latitude: POINT.lat, longitude: POINT.lng });
  await page.route(`${STYLE_HOST}/**`, (r) => r.abort());
});

async function fillCar(page: Page, o: { brand: string; model: string }) {
  const brand = page.getByRole('combobox', { name: fa('vehicle.picker.brand'), exact: true });
  await expect(brand.locator(`option[value="${o.brand}"]`)).toHaveCount(1);
  await brand.selectOption(o.brand);
  const model = page.getByRole('combobox', { name: fa('vehicle.picker.model'), exact: true });
  await expect(model.locator(`option[value="${o.model}"]`)).toHaveCount(1);
  await model.selectOption(o.model);
}

test('Sara, Chapters 1-11 in FA', async ({ page, request }) => {
  test.setTimeout(900_000);
  const email = newEmail('sara-journey');
  const password = 'silver e90 from 2012';
  // One owner per VIN (BA-04); position 10 "C" = model year 2012, the year she enters.
  const vin = `WBAPH5C55C${Array.from({ length: 7 }, () => VIN_CHARS[Math.floor(Math.random() * VIN_CHARS.length)]).join('')}`;

  // ---------------------------------------------------------------- Ch. 1: signing up
  await test.step('Ch. 1 sign up', async () => {
    await gotoReady(page, '/fa');
    await page
      .getByRole('banner')
      .getByRole('link', { name: fa('shell.header.signUp') })
      .click();
    await page.waitForURL(/\/id\/signin\?interaction_id=/);
    await page.locator('html[data-hydrated="true"]').waitFor({ state: 'attached' });
    await expect(page.getByRole('heading', { name: fa('auth.signup.title') })).toBeVisible();
    // The User Agreement in its dialog (P13.T7): the full text, English, with its version.
    await page
      .getByRole('button', { name: fa('auth.signup.read') })
      .first()
      .click();
    const legal = page.getByRole('dialog', { name: fa('auth.signup.termsTitle') });
    await expect(legal.getByText('1. About this agreement')).toBeVisible({ timeout: 20_000 });
    await expect(legal.getByText(fa('auth.signup.legalVersion', { version: '1.0' }))).toBeVisible();
    await expectNoAxeViolations(page);
    await page.keyboard.press('Escape');
    await page.getByLabel(fa('auth.signup.fullName')).fill('سارا محمدی');
    await page.getByLabel(fa('auth.signup.email')).fill(email);
    await page.getByLabel(fa('auth.signup.password')).fill(password);
    await page.getByLabel(fa('auth.signup.terms')).check();
    await page.getByLabel(fa('auth.signup.privacy')).check();
    const since = now();
    await page.getByRole('button', { name: fa('auth.signup.create') }).click();
    await expect(page.getByRole('heading', { name: fa('auth.code.titleVerify') })).toBeVisible();
    await page.getByRole('textbox', { name: /رقم ۱ از ۶/ }).fill(await mailedCode(email, since));
  });

  // ---------------------------------------------------------------- Ch. 2: her first vehicle
  await test.step('Ch. 2 onboarding with the first car', async () => {
    await page.waitForURL(/\/fa\/onboarding\?next=/);
    await expect(page.getByRole('heading', { name: fa('onboarding.titles.role') })).toBeVisible();
    await page.getByRole('button', { name: fa('onboarding.next') }).click();
    await expect(page.getByRole('heading', { name: fa('onboarding.titles.vehicle') })).toBeVisible();
    await fillCar(page, car);
    await page.getByLabel(fa('onboarding.vehicle.year')).selectOption('2012');
    await page.getByLabel(fa('onboarding.vehicle.vin')).fill(vin);
    await page.getByLabel(fa('onboarding.vehicle.mileage')).fill('151200');
    await page.getByLabel(fa('onboarding.vehicle.nickname')).fill('نقره‌ای');
    await expectNoAxeViolations(page);
    await page.getByRole('button', { name: fa('onboarding.vehicle.save') }).click();
    await expect(page.getByText(/نقره‌ای/).first()).toBeVisible();
    await page.getByRole('button', { name: fa('onboarding.next') }).click();
    await expect(page.getByRole('heading', { name: fa('onboarding.titles.problem') })).toBeVisible();
    await page.getByRole('button', { name: fa('onboarding.problem.notNow') }).click();
    await expect(page.getByRole('heading', { name: fa('onboarding.titles.permissions') })).toBeVisible();
    await page.getByRole('button', { name: fa('onboarding.permissions.finish') }).click();
    await page.waitForURL(/\/fa\/home$/);
    await expect(page.getByRole('region', { name: fa('shell.garageBox.title') })).toContainText('نقره‌ای');
    await expectNoAxeViolations(page);
  });

  // ---------------------------------------------------------------- Ch. 3: coming back
  await test.step('Ch. 3 log out and back in', async () => {
    await page.getByRole('button', { name: fa('shell.header.accountMenu') }).click();
    await page.getByRole('button', { name: fa('shell.menu.logOut') }).click();
    await hostedSignIn(page, L, { email, password }, { onboarding: false });
    await page.waitForURL(/\/fa\/home$/);
    await expect(page.getByRole('button', { name: fa('shell.header.accountMenu') })).toBeVisible();
  });

  let silverUrl = '';
  // ---------------------------------------------------------------- Ch. 4: building out her profile
  await test.step('Ch. 4 second car, a service record, the consents', async () => {
    await gotoReady(page, '/fa/garage/add');
    const brand = page.getByRole('combobox', { name: fa('vehicle.picker.brand'), exact: true });
    await expect(brand.locator('option')).not.toHaveCount(1);
    await brand.selectOption({ index: 1 });
    const model = page.getByRole('combobox', { name: fa('vehicle.picker.model'), exact: true });
    await expect(model.locator('option')).not.toHaveCount(1);
    await model.selectOption({ index: 1 });
    await page.getByRole('combobox', { name: fa('common.date.year'), exact: true }).selectOption('2016');
    await page.getByLabel(fa('garage.form.nickname'), { exact: true }).fill('کرولا');
    await page.getByRole('button', { name: fa('common.actions.save') }).click();
    await page.waitForURL(/\/fa\/garage\/[0-9a-f-]{36}\/overview$/);
    await expectNoAxeViolations(page);

    await gotoReady(page, '/fa/garage');
    await page
      .getByRole('link', { name: /نقره‌ای/ })
      .first()
      .click();
    await page.waitForURL(/\/fa\/garage\/[0-9a-f-]{36}\/overview$/);
    silverUrl = page.url().replace(/\/overview$/, '');
    await page.getByRole('link', { name: fa('garage.quick.addRecord') }).click();
    await page.waitForURL(/\/records\/new$/);
    await page.locator('html[data-hydrated="true"]').waitFor({ state: 'attached' });
    await page.getByLabel(fa('garage.form.whatWasDone')).fill('تعویض لنت و دیسک جلو');
    const category = page.getByRole('combobox', { name: fa('garage.history.category'), exact: true });
    await expect(category.locator('option')).not.toHaveCount(1);
    await category.selectOption({ index: 1 });
    await page.getByRole('combobox', { name: 'تاریخ سال' }).selectOption('1404');
    await page.getByRole('combobox', { name: 'تاریخ ماه' }).selectOption('2');
    await page.getByRole('combobox', { name: 'تاریخ روز' }).selectOption('15');
    await page.getByLabel(fa('garage.form.cost'), { exact: true }).fill('4500000');
    await page.getByRole('button', { name: fa('common.actions.save') }).click();
    await page.waitForURL(/\/history$/);
    await expect(page.getByTestId('history-table').getByText(fa('garage.record.addedByYou'))).toBeVisible();
    await expectNoAxeViolations(page);

    await gotoReady(page, '/fa/settings/privacy');
    await expect(page.locator('#settings-section-title')).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expectNoAxeViolations(page);
  });

  // ---------------------------------------------------------------- Ch. 5: keeping it accurate
  await test.step('Ch. 5 mileage, notification preferences, language', async () => {
    await gotoReady(page, `${silverUrl}/overview`);
    await page.getByRole('button', { name: fa('garage.mileage.update') }).click();
    const mileage = page.getByLabel(fa('garage.mileage.new'));
    await mileage.fill('151900');
    await mileage.press('Enter');
    await expect(page.getByText(fa('garage.mileage.saved'))).toBeVisible();
    await expect(page.getByText(`${digits(L, '151')}٬${digits(L, '900')}`).first()).toBeVisible();

    await gotoReady(page, '/fa/settings/notifications');
    const tipsByEmail = page.getByRole('checkbox', {
      name: fa('settings.notifications.cell', {
        category: fa('settings.notifications.cat.ai_suggestions'),
        channel: fa('settings.notifications.ch.email'),
      }),
    });
    if (!(await tipsByEmail.isChecked())) await tipsByEmail.check();
    const saved = page.waitForResponse((r) => r.url().endsWith('/api/v1/me/notification-preferences') && r.request().method() === 'PUT');
    await tipsByEmail.uncheck();
    expect((await saved).status()).toBe(200);
    await expect(tipsByEmail).not.toBeChecked();
    await expectNoAxeViolations(page);

    // English for a moment: platform labels switch, her own data stays as typed.
    await page.getByRole('contentinfo').getByRole('link', { name: 'English' }).click();
    await page.waitForURL(/\/en\/settings\/notifications$/);
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await gotoReady(page, '/en/garage');
    await expect(page.getByText('نقره‌ای').first()).toBeVisible();
    await page.getByRole('contentinfo').getByRole('link', { name: 'فارسی' }).click();
    await page.waitForURL(/\/fa\/garage$/);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  });

  let appointmentId = '';
  // ---------------------------------------------------------------- Ch. 6-8: the clunk, the specialist, the visit
  await test.step('Ch. 6-8 Help Me, request, visit', async () => {
    await gotoReady(page, '/fa/help');
    await page
      .getByRole('group', { name: fa('help.describe.whichCar') })
      .getByRole('button', { name: /نقره‌ای/ })
      .click();
    await page.getByLabel(fa('help.describe.label')).fill('از دیروز صدای تق‌تق در دست‌انداز از جلوی راست می‌آید');
    await page.getByRole('button', { name: fa('help.describe.start') }).click();
    await page.waitForURL(/\/fa\/help\/[0-9a-f-]{36}\/(questions|safety)$/);
    if (page.url().endsWith('/questions')) {
      await page.getByLabel(fa('help.questions.answer')).fill('فقط روی دست‌انداز');
      await page.getByRole('button', { name: fa('help.questions.next') }).click();
      await page.waitForURL(/\/safety$/);
    }
    await expectNoAxeViolations(page);
    await page.getByRole('button', { name: fa('help.safety.seeRecommendations') }).click();
    await page.waitForURL(/\/recommendations$/);
    if (MCP_UNAVAILABLE)
      await page
        .getByRole('group', { name: fa('help.categories.pick') })
        .getByRole('button', { name: suspensionFa, exact: true })
        .click();
    await nearMe(page, L);
    const card = page.locator('article.pwa-result').filter({ hasText: shop.name }).first();
    await expect(async () => {
      if (!(await card.isVisible())) {
        const more = page.locator('details.pwa-disclosure:not([open]) > summary');
        if (await more.count()) await more.first().click();
      }
      await expect(card).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 60_000 });
    await expectNoAxeViolations(page);
    await card.getByRole('button', { name: fa('help.recommendations.request') }).click();
    await page.waitForURL(/\/request$/);
    await page.getByRole('button', { name: fa('appointments.times.add') }).click();
    await page.getByLabel(fa('help.request.shareHistory')).check();
    await page.getByRole('button', { name: fa('help.request.send') }).click();
    await page.waitForURL(/\/done$/);
    await page.getByRole('link', { name: fa('help.done.track') }).click();
    await page.waitForURL(/\/fa\/appointments\/[0-9a-f-]{36}/);
    appointmentId = /appointments\/([0-9a-f-]{36})/.exec(page.url())![1]!;
    await shopCompletes(shop, appointmentId);
    await gotoReady(page, `/fa/appointments/${appointmentId}`);
    await expect(page.getByRole('heading', { level: 1, name: fa('appointments.status.completed') })).toBeVisible();
    await expectNoAxeViolations(page);
  });

  // ---------------------------------------------------------------- Ch. 9: recording the experience
  await test.step('Ch. 9 the verified record and the review', async () => {
    await gotoReady(page, `${silverUrl}/history`);
    await expect(page.getByTestId('history-table').locator('tbody tr')).toHaveCount(2, { timeout: 30_000 });
    await expectNoAxeViolations(page);
    await gotoReady(page, `/fa/appointments/${appointmentId}`);
    await expect(async () => {
      await page.reload();
      await expect(page.getByTestId('leave-review')).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 60_000 });
    await page.getByTestId('leave-review').click();
    await expect(page.getByText(fa('reviews.context.verifiedVisit')).first()).toBeVisible({ timeout: 30_000 });
    await rate(page, L, fa('reviews.form.overall'), 5);
    await page
      .getByLabel(fa('reviews.form.body'), { exact: true })
      .fill('رضا قطعه کهنه را نشانم داد، مرتب خبر داد و هزینه همان بود که گفته بود.');
    await page.getByRole('button', { name: fa('reviews.form.submit') }).click();
    await expect(page.getByTestId('review-submitted')).toBeVisible();
    await expectNoAxeViolations(page);
  });

  // ---------------------------------------------------------------- Ch. 10: afterwards
  await test.step('Ch. 10 a question; she sells the car and accepts the transfer', async () => {
    await gotoReady(page, '/fa/questions/ask');
    await page.getByLabel(fa('community.ask.title')).fill(`لاستیک زمستانی مناسب برای رینگ ۱۷ چیست؟ ${hex}`);
    await page.getByLabel(fa('community.ask.details'), { exact: true }).fill('بیشتر رانندگی شهری در تهران، گاهی سفر شمال در زمستان.');
    await page.getByRole('button', { name: fa('community.ask.post') }).click();
    await page.waitForURL(/\/fa\/questions\/[0-9a-f-]{36}-/, { timeout: 60_000, waitUntil: 'domcontentloaded' });
    await expectNoAxeViolations(page);

    const buyer = await businessUser(request, 'buyer');
    const asked = await buyer.call('POST', '/v1/me/vehicle-transfers', { vin, message: 'سلام، ماشین را از شما خریدم.' });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    await gotoReady(page, '/fa/garage');
    const block = page.getByRole('region', { name: fa('garage.transfer.blockTitle') });
    await expect(block).toBeVisible({ timeout: 30_000 });
    await expectNoAxeViolations(page);
    await block.getByRole('button', { name: fa('garage.transfer.accept') }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: fa('garage.transfer.confirmAccept') })
      .click();
    await expect(block).toBeHidden({ timeout: 30_000 });
    const theirs = await buyer.call('GET', '/v1/me/vehicles?limit=10');
    // The buyer owns it now (the API shows the last four VIN characters only).
    expect((theirs.body.items as { vin_last4: string | null }[]).map((v) => v.vin_last4)).toContain(vin.slice(-4));
    await gotoReady(page, '/fa/garage');
    await expect(page.getByRole('link', { name: /نقره‌ای/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /کرولا/ }).first()).toBeVisible();
  });

  // ---------------------------------------------------------------- Ch. 11: looking around
  await test.step('Ch. 11 search without Help Me, the map', async () => {
    await gotoReady(page, '/fa');
    await page.getByRole('combobox', { name: fa('shell.header.searchLabel') }).fill(`${suspensionFa} ${hex}`);
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/search\/[0-9a-f-]{36}/, { timeout: 30_000 });
    await expect(page.getByRole('group', { name: fa('search.chips.label') })).toContainText(suspensionFa);
    await expect(page.getByRole('link', { name: shop.name })).toBeVisible({ timeout: 30_000 });
    await expectNoAxeViolations(page);
    await gotoReady(page, '/fa/map');
    await expect(page.locator('.pwa-map')).toHaveAttribute('data-map-status', 'ready', { timeout: 30_000 });
    await expect(page.locator('.pwa-pin:not(.is-static)').first()).toBeVisible({ timeout: 30_000 });
  });
});
