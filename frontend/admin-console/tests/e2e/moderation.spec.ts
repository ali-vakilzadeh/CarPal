// AC8.T6 E2E (acceptance "Every case type can be opened, actioned with a reason and closed", "Suspend, trust penalty
// and merge require a fresh passkey step-up", "E2E and axe pass in EN and FA"). The data comes from the real API: a
// published shop posts a tip (community flags on in dev) and a fresh customer reports it (tests/e2e/app-user.ts).
//   1. EN: a moderator triages the report into a case, opens the case, takes it, hides the post (the public list no
//      longer shows it), restores it (shown again) and closes the case with a resolution. Axe on the report and the case.
//   2. FA: a moderator suspends the post's author. The backend asks for the security key only when the sign-in is
//      older than 10 minutes (STEP_UP_MAX_AGE_S), which a fresh E2E session never is, so the first suspend call is
//      answered with the backend's own STEP_UP_REQUIRED (page.route); the console asks for the key, the virtual key
//      confirms on the sign-in page, and the saved action runs once against the real backend: the author's next API
//      call is refused. Axe on the account panel in FA.
// Needs backend `pnpm dev` with the console's settings (README "End-to-end tests").
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { appUser, communityOn, publicPostStatus, publishedShop, reportAs, shopPost } from './app-user';
import { expectNoAxeViolations } from './support';
import { requireBackend, signInAs } from './staff';

type Dict = Record<string, unknown>;
const dict = (l: 'en' | 'fa') =>
  (JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'src', 'lib', 'i18n', 'locales', `${l}.json`), 'utf8')) as Dict)
    .admin as Dict;
const DICT = { en: dict('en'), fa: dict('fa') };
/** A console string by its key under `admin.`, with {{placeholders}} filled. */
const say = (l: 'en' | 'fa', key: string, vars: Record<string, string> = {}) =>
  (key.split('.').reduce<unknown>((o, k) => (o as Dict)[k], DICT[l]) as string).replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? '');

test.beforeAll(async () => {
  await requireBackend();
  communityOn();
});

async function chooseReason(page: Page, l: 'en' | 'fa', code: string, note?: string) {
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(say(l, 'kit.reason.code')).selectOption(code);
  if (note) await dialog.getByRole('textbox').first().fill(note);
  return dialog;
}

test('a reported post is triaged, hidden, restored and closed (AC8, EN)', async ({ context, page }) => {
  test.setTimeout(300_000);
  const shop = await publishedShop('m1');
  const post = await shopPost(shop, 'm1');
  const reporter = await appUser('m1-reporter', 'Ali Reporter');
  const reportId = await reportAs(reporter, { type: 'post', id: post.id }, 'spam', 'Looks like an advert with a phone number');
  expect(await publicPostStatus(reporter, shop, post.id)).toBe('visible');

  await signInAs(context, page, ['MOD'], { path: `/content?target_type=post&report=${reportId}` });
  const report = page.getByTestId('report-item');
  await expect(report).toHaveAttribute('data-report', reportId);
  await expect(report.getByText('Looks like an advert with a phone number')).toBeVisible();
  await expectNoAxeViolations(page);

  // Triage into a new case (medium, the proposal for spam).
  await page.getByRole('button', { name: 'Open a case' }).click();
  let dialog = await chooseReason(page, 'en', 'needs_review');
  await dialog.getByRole('button', { name: 'Open a case' }).click();
  await expect(page.getByText('The report is in a case now.')).toBeVisible();
  await page.getByRole('link', { name: 'Open its case' }).click();
  await page.waitForURL(/\/content\?tab=content&case=/);

  // The case: the post as published, read for the case's purpose; take it.
  const target = page.getByTestId('case-target');
  await expect(target.getByText(post.title)).toBeVisible();
  await expect(target.getByTestId('target-status')).toHaveText('Published');
  await page.getByRole('button', { name: 'Take this case' }).click();
  await expect(page.getByTestId('assigned-to-you')).toBeVisible();
  await expectNoAxeViolations(page);

  // Hide (kept for review): the public list no longer shows it.
  await page.getByTestId('case-actions').getByRole('button', { name: 'Hide' }).click();
  dialog = await chooseReason(page, 'en', 'policy_violation', 'Advert with contact data');
  await dialog.getByRole('button', { name: 'Hide' }).click();
  await expect(page.getByText('Hidden.', { exact: true })).toBeVisible();
  await expect(target.getByTestId('target-status')).toHaveText('Hidden');
  await expect.poll(() => publicPostStatus(reporter, shop, post.id)).toBe('gone');

  // Restore: back on the public list.
  await page.getByTestId('case-actions').getByRole('button', { name: 'Restore' }).click();
  dialog = await chooseReason(page, 'en', 'mistake');
  await dialog.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByText('Restored.', { exact: true })).toBeVisible();
  await expect(target.getByTestId('target-status')).toHaveText('Published');
  await expect.poll(() => publicPostStatus(reporter, shop, post.id)).toBe('visible');

  // Close with an outcome and a resolution.
  await page.getByLabel('Done (action taken)').check();
  await page.getByLabel('Resolution').fill('Hidden by mistake, restored: an educational tip, no contact data.');
  await page.getByRole('button', { name: 'Close the case' }).click();
  dialog = await chooseReason(page, 'en', 'action_completed');
  await dialog.getByRole('button', { name: 'Close the case' }).click();
  await expect(page.getByText('This case is closed: Action taken.')).toBeVisible();
  await expect(page.getByTestId('case-status')).toHaveText('Action taken');
});

test('suspending the author asks for the security key and runs once after it (AC8, FA)', async ({ context, page }) => {
  test.setTimeout(300_000);
  const shop = await publishedShop('m2');
  const post = await shopPost(shop, 'm2');
  const reporter = await appUser('m2-reporter', 'Sara Reporter');
  const reportId = await reportAs(reporter, { type: 'post', id: post.id }, 'harassment', 'Insults customers in the comments');

  await signInAs(context, page, ['MOD'], { path: `/content?target_type=post&report=${reportId}`, locale: 'fa' });
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.getByRole('button', { name: say('fa', 'moderation.reports.openButton') }).click();
  let dialog = await chooseReason(page, 'fa', 'needs_review');
  await dialog.getByRole('button', { name: say('fa', 'moderation.reports.openButton') }).click();
  await page.getByRole('link', { name: say('fa', 'moderation.reports.openCase') }).click();
  await page.waitForURL(/\/content\?tab=content&case=/);
  const account = page.getByTestId('account-actions');
  await expect(account).toBeVisible();
  await expectNoAxeViolations(page);

  // The first suspend call gets the backend's step-up answer; everything after it is real.
  let answered = false;
  await page.route('**/api/v1/admin/moderation/cases/*/actions', async (route) => {
    const body = route.request().postDataJSON() as { action_type?: string } | null;
    if (!answered && body?.action_type === 'suspend_account') {
      answered = true;
      await route.fulfill({
        status: 401,
        contentType: 'application/problem+json',
        headers: { 'www-authenticate': 'DPoP error="insufficient_user_authentication", acr_values="aal3", max_age=600' },
        body: JSON.stringify({ code: 'STEP_UP_REQUIRED', title: 'Step-up required', status: 401 }),
      });
      return;
    }
    await route.continue();
  });

  const suspend = say('fa', 'moderation.do.suspend_account');
  await account.getByRole('button', { name: suspend }).click();
  dialog = await chooseReason(page, 'fa', 'repeated_violations', 'توهین به مشتریان');
  await expect(dialog.getByText(say('fa', 'moderation.stepUp'))).toBeVisible();
  await dialog.getByRole('button', { name: suspend }).click();
  const key = page.getByRole('dialog', { name: say('fa', 'shell.stepUp.title') });
  await key.getByRole('button', { name: say('fa', 'shell.stepUp.continue') }).click();
  await page.waitForURL(/\/id\/signin\?/);
  await page.getByRole('button', { name: say('fa', 'signin.withKey') }).click();
  await page.waitForURL(/\/content\?/, { timeout: 60_000 });
  await expect(page.getByText(say('fa', 'moderation.done.suspend_account'))).toBeVisible({ timeout: 30_000 });
  expect(answered).toBe(true);

  // The author's account is suspended: its next API call is refused.
  await expect.poll(async () => (await shop.owner.call('GET', '/v1/me')).status).toBeGreaterThanOrEqual(401);
});
