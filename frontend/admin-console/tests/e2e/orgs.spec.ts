// AC9.T6 E2E (acceptance "Verification decisions update the organization's verification status and badge
// eligibility", "Location corrections are audited and visible in the audit drawer", "E2E and axe pass in EN and FA").
// The data comes from the real API: a published provider (tests/e2e/app-user.ts) asks for its business identity and
// location checks.
//   1. EN: a moderator approves the business identity check (checklist), opens the location check's organization on the
//      Locations tab, corrects the pin by typing coordinates (the map's keyboard alternative), approves the location
//      check and sees the organization verified. Axe on the queue, the review and the Locations tab.
//   2. FA: a platform admin finds the organization by id, opens it for a pending check, reads the audit drawer of the
//      corrected location (the correction is listed), suspends and reactivates it. Axe in FA.
// Needs backend `pnpm dev` with the console's settings (README "End-to-end tests").
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { publishedShop, submitVerification, type Shop } from './app-user';
import { expectNoAxeViolations } from './support';
import { requireBackend, signInAs } from './staff';

type Dict = Record<string, unknown>;
const dict = (l: 'en' | 'fa') =>
  (JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'src', 'lib', 'i18n', 'locales', `${l}.json`), 'utf8')) as Dict)
    .admin as Dict;
const DICT = { en: dict('en'), fa: dict('fa') };
const say = (l: 'en' | 'fa', key: string, vars: Record<string, string> = {}) =>
  (key.split('.').reduce<unknown>((o, k) => (o as Dict)[k], DICT[l]) as string).replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? '');

const purpose = (id: string) => encodeURIComponent(`verification:${id}`);

test.beforeAll(requireBackend);

async function chooseReason(page: Page, l: 'en' | 'fa', code: string, note?: string) {
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(say(l, 'kit.reason.code')).selectOption(code);
  if (note) await dialog.getByRole('textbox').first().fill(note);
  return dialog;
}

async function tickChecklist(page: Page) {
  const list = page.getByTestId('checklist');
  for (const box of await list.getByRole('checkbox').all()) await box.check();
}

let shop: Shop;
let identityId: string;
let locationId: string;

test('a provider is verified after its pin is corrected (AC9, EN)', async ({ context, page }) => {
  test.setTimeout(300_000);
  shop = await publishedShop('v1');
  identityId = await submitVerification(shop, 'business_identity');
  locationId = await submitVerification(shop, 'location');

  await signInAs(context, page, ['MOD'], { path: `/verification?verification=${identityId}&purpose=${purpose(identityId)}` });
  const item = page.getByTestId('verification-item');
  await expect(item).toHaveAttribute('data-verification', identityId);
  await expect(item.getByText(shop.name).first()).toBeVisible();
  await expectNoAxeViolations(page);

  // Business identity: the checklist first, then Approve with a reason.
  await expect(page.getByRole('button', { name: 'Approve' })).toBeDisabled();
  await tickChecklist(page);
  await page.getByRole('button', { name: 'Approve' }).click();
  let dialog = await chooseReason(page, 'en', 'documents_match');
  await dialog.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('The check is verified.')).toBeVisible();

  // The location check: correct the pin on the organization's Locations tab (typed coordinates).
  await page.goto(`/orgs/${shop.id}?tab=locations&purpose=${purpose(locationId)}`);
  const tab = page.getByTestId('locations-tab');
  await expect(tab).toBeVisible();
  await expectNoAxeViolations(page);
  await tab.getByRole('button', { name: 'Correct pin or address' }).click();
  const form = page.getByRole('form', { name: 'Correct the location' });
  await form.getByLabel('Latitude').fill('35.7219');
  await form.getByLabel('Longitude').fill('51.3347');
  await form.getByRole('button', { name: 'Save the correction' }).click();
  dialog = await chooseReason(page, 'en', 'verification_check', 'Pin moved to the workshop entrance');
  await dialog.getByRole('button', { name: 'Save the correction' }).click();
  await expect(page.getByTestId('correct-result')).toContainText('Pin matches address');
  await expect(tab.getByText('Corrected by CarPal')).toBeVisible();
  await expect(tab.getByTestId('pin-coords')).toContainText('35.7219, 51.3347');

  // Approve the location check: the organization is verified now.
  await page.goto(`/verification?verification=${locationId}&purpose=${purpose(locationId)}`);
  await expect(page.getByTestId('verification-item')).toHaveAttribute('data-verification', locationId);
  await tickChecklist(page);
  await page.getByRole('button', { name: 'Approve' }).click();
  dialog = await chooseReason(page, 'en', 'location_confirmed');
  await dialog.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByTestId('org-verification-now')).toHaveText("The organization's verification status is now: Verified.");
  await expect(page.getByText(/Verified Business badge/)).toBeVisible();
});

test('an admin finds the organization, sees the audited correction and suspends it (AC9, FA)', async ({ context, page }) => {
  test.setTimeout(300_000);
  test.skip(!shop, 'needs the organization of the EN test');
  // A fresh pending check gives the admin a purpose to read the organization for.
  const phoneId = await submitVerification(shop, 'phone');
  await signInAs(context, page, ['ADM'], { path: '/orgs', locale: 'fa' });
  await page.getByLabel(say('fa', 'orgs.search.in')).selectOption('id');
  await page.getByLabel(say('fa', 'orgs.search.text')).fill(shop.id);
  await page.getByRole('button', { name: say('fa', 'orgs.search.go') }).click();
  const table = page.getByRole('table', { name: say('fa', 'orgs.listLabel') });
  await table.getByRole('button', { name: shop.name }).click();
  await page.waitForURL(new RegExp(`/orgs/${shop.id}\\?purpose=`));
  await expect(page).toHaveURL(new RegExp(purpose(phoneId)));
  await expect(page.getByRole('heading', { level: 1, name: shop.name })).toBeVisible();
  await expect(page.getByText(say('fa', 'orgs.verification.verified')).first()).toBeVisible();
  await expectNoAxeViolations(page);

  // The correction is in the location's audit trail (ADM).
  await page.getByRole('tab', { name: say('fa', 'orgs.tab.locations') }).click();
  const location = page.getByTestId('location');
  await location.getByRole('button', { name: say('fa', 'kit.audit.open') }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByText('Pin moved to the workshop entrance')).toBeVisible();
  await expect(drawer.getByText(say('fa', 'reasons.codes.verification_check'))).toBeVisible();
  await page.keyboard.press('Escape');

  // Suspend (reason, second confirmation), then reactivate.
  await page.getByRole('button', { name: say('fa', 'orgs.status.do.suspend') }).click();
  let dialog = await chooseReason(page, 'fa', 'other', 'آزمون خودکار');
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: say('fa', 'orgs.status.do.suspend') }).click();
  await expect(page.getByText(say('fa', 'orgs.status.done.suspend'))).toBeVisible();
  await page.getByRole('button', { name: say('fa', 'orgs.status.do.reactivate') }).click();
  dialog = await chooseReason(page, 'fa', 'mistake');
  await dialog.getByRole('button', { name: say('fa', 'orgs.status.do.reactivate') }).click();
  await expect(page.getByText(say('fa', 'orgs.status.done.reactivate'))).toBeVisible();
  await expectNoAxeViolations(page);
});
