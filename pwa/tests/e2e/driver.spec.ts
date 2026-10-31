// P12.T5: fleet driver web views (DRV-WEB) against the live backend, with the fleet created through the API
// (businesses.ts seedFleet: owner, fleet organization, a fleet vehicle, the driver's invitation). The driver signs in
// to the consumer PWA, accepts the mailed /l/mi invitation, gets the vehicle assigned, sees only it, runs the optional
// guided check, reports an issue marked unsafe with the odometer (the fleet sees a pending driver report), and a
// report written offline is kept on the device and sent when the browser is back online. FA pages; axe on each step.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { backendUp, createUser } from './accounts';
import { seedFleet } from './businesses';
import { decideCookies, expectNoAxeViolations, gotoReady } from './support';

const FA = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'shared', 'i18n', 'locales', 'fa.json'), 'utf8')) as Record<
  string,
  unknown
>;
function fa(key: string, vars: Record<string, string | number> = {}): string {
  const v = key.split('.').reduce<unknown>((node, k) => (node as Record<string, unknown>)[k], FA);
  if (typeof v !== 'string') throw new Error(`no fa string ${key}`);
  return v.replace(/\{\{(\w+)(?:, number)?\}\}/g, (_, name: string) => String(vars[name] ?? ''));
}

test.beforeEach(async ({ request, context, baseURL }) => {
  test.skip(!(await backendUp(request)), 'needs the backend (`pnpm dev` in backend/)');
  await decideCookies(context, baseURL!);
});

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

test('a fleet driver joins, sees the assigned vehicle only, reports issues online and offline', async ({ page, context, request }) => {
  test.setTimeout(240_000);
  const driver = await createUser(request, { fullName: 'Ali Driver', locale: 'fa' });
  const fleet = await seedFleet(request, driver.email);
  await signIn(page, driver);

  // The mailed invitation (/l/mi#token): accept as the signed-in driver.
  await page.goto(`/l/mi#${fleet.inviteToken}`);
  await page.locator('html[data-hydrated="true"]').waitFor({ state: 'attached' });
  await page.getByRole('button', { name: /Accept invitation|پذیرفتن دعوت/ }).click();
  await expect(page.getByRole('heading', { name: new RegExp(fleet.name) })).toBeVisible();
  await expectNoAxeViolations(page);

  // Before the assignment the fleet shows no vehicle.
  await gotoReady(page, '/fa/drive');
  await expect(page.getByRole('heading', { level: 2, name: fleet.name })).toBeVisible();
  await expect(page.getByText(fa('driver.noVehicleTitle'))).toBeVisible();

  await fleet.assignTo(driver.email);
  await page.reload();
  const card = page.locator('.pwa-drive-card').filter({ hasText: 'Van' });
  await expect(card).toHaveCount(1);
  await expectNoAxeViolations(page);
  // The account menu offers the driver views.
  await page.getByRole('button', { name: fa('shell.header.accountMenu') }).click();
  await expect(page.getByRole('link', { name: fa('shell.menu.drive') })).toBeVisible();
  await page.keyboard.press('Escape');

  // F-ISSUE-01 online: shortcut, description, unsafe, odometer, the optional guided check, submit.
  await card.getByRole('link', { name: fa('driver.report') }).click();
  await page.waitForURL(new RegExp(`/fa/drive/${fleet.orgId}/${fleet.vehicleId}/report$`));
  await page.getByRole('button', { name: fa('driver.shortcut.brakes') }).click();
  await page.getByLabel(fa('driver.form.description')).fill('ترمز صدای ساییدگی می‌دهد و پدال نرم شده است');
  await page.getByLabel(fa('driver.form.unsafe')).check();
  await expect(page.getByText(fa('driver.safety.title'))).toBeVisible();
  await page.getByRole('button', { name: fa('driver.form.check') }).click();
  await expect(page.getByTestId('driver-suggestion').or(page.getByText(fa('driver.form.checkOff')))).toBeVisible({ timeout: 20_000 });
  await page.getByLabel(fa('driver.form.mileage')).fill('۸۱۵۰۰');
  await expectNoAxeViolations(page);
  await page.getByRole('button', { name: fa('driver.form.submit') }).click();
  await expect(page.getByRole('heading', { name: fa('driver.done.title') })).toBeVisible();

  // The fleet sees a pending driver report, safety-critical, and the new odometer reading.
  const issues = await fleet.owner.call('GET', `/v1/orgs/${fleet.orgId}/fleet/vehicles/${fleet.vehicleId}/issues`);
  const reported = (issues.body.items as { source: string; fleet_approval_status: string; urgency_level: string; title: string }[])[0]!;
  expect(reported).toMatchObject({
    source: 'fleet_driver',
    fleet_approval_status: 'pending',
    urgency_level: 'safety_critical',
    title: fa('driver.shortcut.brakes'),
  });
  const vehicle = await fleet.owner.call('GET', `/v1/orgs/${fleet.orgId}/fleet/vehicles/${fleet.vehicleId}`);
  expect(vehicle.body.mileage_km).toBe(81500);

  // The vehicle page: the report with the approval state; appointments read-only.
  await page.getByRole('link', { name: fa('driver.done.back') }).click();
  await expect(page.getByTestId('driver-issue').first()).toContainText(fa('driver.approval.pending'));
  await expect(page.getByText(fa('driver.vehicle.appointmentsHint'))).toBeVisible();
  await expectNoAxeViolations(page);

  // Offline: the report is kept on the device, then sent when the network is back.
  await page
    .getByRole('link', { name: fa('driver.report') })
    .first()
    .click();
  await page.waitForURL(/\/report$/);
  await page.locator('html[data-hydrated="true"]').waitFor({ state: 'attached' });
  await context.setOffline(true);
  await expect(page.getByText(fa('driver.form.offline'))).toBeVisible();
  await page.getByLabel(fa('driver.form.description')).fill('چراغ هشدار موتور روشن شده است');
  await page.getByRole('button', { name: fa('driver.form.submitLater') }).click();
  await expect(page.getByRole('heading', { name: fa('driver.done.queuedTitle') })).toBeVisible();
  await context.setOffline(false);
  await page.getByRole('link', { name: fa('driver.done.back') }).click();
  await expect(page.getByText(fa('driver.queue.sent_one', { count: '۱' }))).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(
      async () =>
        ((await fleet.owner.call('GET', `/v1/orgs/${fleet.orgId}/fleet/vehicles/${fleet.vehicleId}/issues`)).body.items as unknown[])
          .length,
    )
    .toBe(2);
});

test('a driver cannot open a vehicle that is not assigned to them', async ({ page, request }) => {
  const driver = await createUser(request);
  const fleet = await seedFleet(request, driver.email);
  await signIn(page, driver);
  await page.goto(`/l/mi#${fleet.inviteToken}`);
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(page.getByRole('heading', { name: new RegExp(fleet.name) })).toBeVisible();
  // Not assigned: the fleet route answers 404 (SEC-AZ-2/7), the page shows "not found".
  await gotoReady(page, `/en/drive/${fleet.orgId}/${fleet.vehicleId}`);
  await expect(page.locator('[data-state="notFound"]')).toBeVisible();
});
