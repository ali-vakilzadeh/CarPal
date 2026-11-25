// AC10.T6 E2E (acceptance "No user data can be opened without a work item purpose", "A deletion runs only after a
// second staff member approves", "E2E and axe pass in EN and FA"). The requests come from the real API: an app user
// files them as the app's privacy settings do (tests/e2e/app-user.ts requestData).
//   1. EN: platform admin A takes a deletion request through the identity check into processing, opens the user for
//      the request (the user page without a purpose asks for a work item), suspends the account for 7 days and
//      reactivates it, and asks for the deletion (four-eyes). Platform admin B approves it on Pending approvals; A sees
//      the outcome under "Your requests" (BR-21) and the request completes. Axe on the queue and the user page.
//   2. FA: a support agent takes an export request into processing, builds the export file (followed with
//      admin.job_get) and completes the request; then looks the user up for the request. Axe in FA.
// Needs backend `pnpm int:env backend` (strict) and the console's settings (README "End-to-end tests").
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { appUser, requestData } from './app-user';
import { requireBackend, signInAs } from './staff';
import { expectNoAxeViolations, gotoReady } from './support';

type Dict = Record<string, unknown>;
const dict = (l: 'en' | 'fa') =>
  (JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'src', 'lib', 'i18n', 'locales', `${l}.json`), 'utf8')) as Dict)
    .admin as Dict;
const DICT = { en: dict('en'), fa: dict('fa') };
const say = (l: 'en' | 'fa', key: string, vars: Record<string, string> = {}) =>
  (key.split('.').reduce<unknown>((o, k) => (o as Dict)[k], DICT[l]) as string).replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? '');

const purpose = (id: string) => encodeURIComponent(`dsr:${id}`);

test.beforeAll(requireBackend);

/** Fill the reason dialog (code, optional note) and confirm; `irreversible` ticks the second confirmation. */
async function confirmWith(page: Page, l: 'en' | 'fa', title: string, confirm: string, code: string, note?: string, irreversible = false) {
  const dialog = page.getByRole('dialog', { name: title });
  await dialog.getByLabel(say(l, 'kit.reason.code')).selectOption(code);
  if (note) await dialog.getByLabel(/^Note|^توضیح/).fill(note);
  if (irreversible) await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: confirm, exact: true }).click();
  await expect(dialog).toBeHidden();
}

/** The request through its first two steps (received -> checking identity -> in progress). */
async function startProcessing(page: Page, l: 'en' | 'fa') {
  await page.getByRole('button', { name: say(l, 'privacy.move.verifying_identity') }).click();
  await confirmWith(page, l, say(l, 'privacy.dialog.verifying_identity'), say(l, 'privacy.move.verifying_identity'), 'identity_checked');
  await expect(page.getByTestId('dsr-status')).toHaveText(say(l, 'privacy.status.verifying_identity'));
  await page.getByRole('button', { name: say(l, 'privacy.move.in_progress') }).click();
  await confirmWith(page, l, say(l, 'privacy.dialog.in_progress'), say(l, 'privacy.move.in_progress'), 'identity_verified', 'AC10 E2E');
  await expect(page.getByTestId('dsr-status')).toHaveText(say(l, 'privacy.status.in_progress'));
}

test('a deletion request: identity, the user, a timed suspension, and the deletion by four-eyes (AC10, EN) @pilot', async ({ browser }) => {
  test.setTimeout(360_000);
  const user = await appUser('dsr-del', 'Dana Deletion');
  const dsr = await requestData(user, 'deletion', 'Please delete my CarPal account.');
  expect(dsr.status).toBe('received');

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  await Promise.all([
    signInAs(ctxA, a, ['ADM'], { path: `/privacy?type=deletion&status=received&request=${dsr.id}&purpose=${purpose(dsr.id)}` }),
    signInAs(ctxB, b, ['ADM'], { path: '/approvals' }),
  ]);
  const detail = a.getByTestId('dsr-detail');
  await expect(detail).toHaveAttribute('data-request', dsr.id);
  await expect(detail.getByText('Please delete my CarPal account.')).toBeVisible();
  await expectNoAxeViolations(a);
  await startProcessing(a, 'en');
  // A deletion is never completed by hand.
  await expect(a.getByRole('button', { name: 'Mark completed' })).toHaveCount(0);

  // The user, for this request only. Without a purpose the page asks for a work item first.
  const userHref = await detail.getByTestId('dsr-user-link').getAttribute('href');
  const userId = userHref!.split('/users/')[1]!.split('?')[0]!;
  await gotoReady(a, `/users/${userId}`);
  await expect(a.getByText('Open this from a work item')).toBeVisible();
  await gotoReady(a, userHref!);
  await expect(a.getByTestId('user-name')).toHaveText('D*** D***');
  await expect(a.getByTestId('user-overview')).not.toContainText(user.email);
  await expectNoAxeViolations(a);

  // A 7-day suspension: the end is stored and shown; then reactivate.
  await a.getByRole('button', { name: 'Suspend the account' }).click();
  const suspend = a.getByRole('dialog', { name: 'Suspend this account' });
  await suspend.getByLabel('Suspend for').selectOption('7d');
  await expect(suspend.getByTestId('suspend-summary')).toContainText('reactivated automatically');
  await confirmWith(a, 'en', 'Suspend this account', 'Suspend the account', 'legal_request', 'AC10 E2E timed suspension', true);
  await expect(a.getByTestId('user-status')).toHaveText('Suspended');
  await expect(a.getByTestId('user-suspended-until')).toContainText('Suspended until');
  await a.getByRole('button', { name: 'Reactivate the account' }).click();
  await confirmWith(a, 'en', 'Reactivate this account', 'Reactivate the account', 'mistake', 'AC10 E2E');
  await expect(a.getByTestId('user-status')).toHaveText('Active');

  // The deletion waits for a second administrator.
  await gotoReady(a, `/privacy?type=deletion&status=in_progress&request=${dsr.id}&purpose=${purpose(dsr.id)}`);
  const box = a.getByTestId('dsr-deletion');
  await box.getByRole('button', { name: 'Run the deletion' }).click();
  await confirmWith(a, 'en', 'Run the deletion', 'Run the deletion', 'identity_verified', 'AC10 E2E deletion', true);
  const banner = box.locator('[data-kit="four-eyes-banner"]');
  await expect(banner).toBeVisible();
  const changeId = (await banner.getAttribute('data-change'))!;

  await gotoReady(b, `/approvals?change=${changeId}`);
  await expect(b.getByTestId('approval-detail')).toContainText('Account data deletion');
  await b.getByRole('button', { name: 'Approve' }).click();
  await confirmWith(b, 'en', 'Approve this change', 'Approve', 'checked_and_correct');
  await expect(b.getByText('Approved. The change is applied.')).toBeVisible();

  // A learns the outcome from the server (BR-21), and the request completes once the worker has erased the data.
  await gotoReady(a, '/approvals');
  await expect(a.getByTestId('my-requests').locator(`[data-change="${changeId}"][data-status="approved"]`)).toBeVisible({
    timeout: 30_000,
  });
  await expect
    .poll(
      async () => {
        await gotoReady(a, `/privacy?type=deletion&status=completed&request=${dsr.id}&purpose=${purpose(dsr.id)}`);
        return (
          (await a
            .getByTestId('dsr-status')
            .textContent({ timeout: 15_000 })
            .catch(() => null)) ?? ''
        );
      },
      { timeout: 120_000, intervals: [5_000] },
    )
    .toBe('Completed');
  await ctxA.close();
  await ctxB.close();
});

test('an export request in Persian: the file built in the background, then completed; the user looked up (AC10, FA)', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const user = await appUser('dsr-exp', 'Sami Export');
  const dsr = await requestData(user, 'export');
  const ctx = await browser.newContext({ locale: 'fa-IR' });
  const page = await ctx.newPage();
  await signInAs(ctx, page, ['SUP'], {
    locale: 'fa',
    path: `/privacy?type=export&status=received&request=${dsr.id}&purpose=${purpose(dsr.id)}`,
  });
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByTestId('dsr-detail')).toHaveAttribute('data-request', dsr.id);
  await startProcessing(page, 'fa');

  const box = page.getByTestId('dsr-export');
  await box.getByRole('button', { name: say('fa', 'privacy.export.build') }).click();
  await confirmWith(page, 'fa', say('fa', 'privacy.export.title'), say('fa', 'privacy.export.build'), 'user_request');
  await expect(box.getByTestId('dsr-job')).toHaveAttribute('data-status', 'succeeded', { timeout: 120_000 });
  await expectNoAxeViolations(page);

  // While the request is open: the user, found by email within this request only (the search is logged).
  const lookup = async () => {
    await gotoReady(page, `/users?purpose=${purpose(dsr.id)}`);
    await page.getByLabel(say('fa', 'users.search.text')).fill(user.email);
    await page.getByRole('button', { name: say('fa', 'users.search.go') }).click();
  };
  await lookup();
  const found = page.getByTestId('user-result');
  // No display name at sign-up: the full name is masked.
  await expect(found).toHaveText('S*** E***');
  await expect(page.getByTestId('users-results')).not.toContainText(user.email);
  await expectNoAxeViolations(page);
  await found.click();
  await expect(page.getByTestId('user-overview')).toBeVisible();
  // Support staff cannot suspend.
  await expect(page.getByRole('button', { name: say('fa', 'users.status.do.suspend') })).toHaveCount(0);
  await expectNoAxeViolations(page);

  // Complete the request; its purpose ends, so the same lookup is refused (SEC-ADM-5).
  await gotoReady(page, `/privacy?type=export&status=in_progress&request=${dsr.id}&purpose=${purpose(dsr.id)}`);
  await page.getByRole('button', { name: say('fa', 'privacy.move.completed') }).click();
  await confirmWith(page, 'fa', say('fa', 'privacy.dialog.completed'), say('fa', 'privacy.move.completed'), 'export_delivered');
  await expect(page.getByTestId('dsr-status')).toHaveText(say('fa', 'privacy.status.completed'));
  await lookup();
  await expect(page.getByTestId('users-error')).toBeVisible();
  await ctx.close();
});
