// AC14-2 E2E (AC14.T6 for these screens) against the live backend (strict for the acceptance run). The shared database
// keeps its state: fresh app users and shops are made per run, throwaway e2e- staff sign in, and every four-eyes
// request (a new retention policy, an organization merge) is rejected by a second administrator, so nothing changes
// for real data.
//   EN  admins A and B: retention Add (an archive policy of a made-up record type, rejected by B) and the Dry run;
//       Plans Assignments and Plan requests. Axe on each view.
//   EN  a moderator: a fresh shop's business check taken, more information asked (the clock pauses); the
//       organization read for that check: Capabilities & badges, Portfolio, Members, Plan history, a profile
//       correction and the profile history. Axe on each tab.
//   FA  a community reviewer: a business's objection to a Path 2 review: both threads, a message to the business,
//       My decisions. Axe on each view.
//   EN  admins A and B: /orgs filters and saved views; Merge duplicate between two fresh shops (preview, rejected by
//       B); a user's Vehicles, Appointments, Consents and Sessions tabs for a privacy request; a moderation view.
// Needs backend `pnpm int:env backend` (strict) and the console's settings (README "End-to-end tests").
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { appUser, businessAnswers, path2Review, publishedShop, requestData, submitVerification } from './app-user';
import { requireBackend, signInAs } from './staff';
import { expectNoAxeViolations, gotoReady } from './support';

type Dict = Record<string, unknown>;
const dict = (l: 'en' | 'fa') =>
  (JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'src', 'lib', 'i18n', 'locales', `${l}.json`), 'utf8')) as Dict)
    .admin as Dict;
const DICT = { en: dict('en'), fa: dict('fa') };
const say = (l: 'en' | 'fa', key: string, vars: Record<string, string> = {}) =>
  (key.split('.').reduce<unknown>((o, k) => (o as Dict)[k], DICT[l]) as string).replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? '');

test.beforeAll(requireBackend);
test.describe.configure({ timeout: 360_000 });

async function confirmWith(page: Page, l: 'en' | 'fa', title: string | RegExp, confirm: string, code: string, note?: string) {
  const dialog = page.getByRole('dialog', { name: title });
  await dialog.getByLabel(say(l, 'kit.reason.code')).selectOption(code);
  if (note) await dialog.getByLabel(/^Note|^توضیح/).fill(note);
  const tick = dialog.getByLabel(say(l, 'kit.confirm.understood'));
  if (await tick.count()) await tick.check();
  await dialog.getByRole('button', { name: confirm, exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function pendingChange(scope: ReturnType<Page['getByTestId']>): Promise<string> {
  const banner = scope.locator('[data-kit="four-eyes-banner"]');
  await expect(banner).toBeVisible({ timeout: 30_000 });
  const id = await banner.getAttribute('data-change');
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  return id!;
}

async function reject(page: Page, changeId: string) {
  await gotoReady(page, `/approvals?change=${changeId}`);
  await expect(page.getByTestId('approval-detail')).toBeVisible();
  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  await confirmWith(page, 'en', 'Reject this change', 'Reject', 'not_justified', 'AC14-2 E2E, rejected by design');
  await expect(page.getByText('Rejected. The change will not be applied.')).toBeVisible({ timeout: 30_000 });
}

async function tab(page: Page, name: string, testId: string) {
  await page.getByRole('tab', { name, exact: true }).click();
  await expect(page.getByTestId(testId)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Loading…')).toHaveCount(0, { timeout: 30_000 });
}

test('retention Add (rejected by a second admin) and Dry run; plan assignments and requests (EN)', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  await Promise.all([signInAs(ctxA, a, ['ADM'], { path: '/retention?policy=new' }), signInAs(ctxB, b, ['ADM'], { path: '/approvals' })]);

  // Add: a made-up record type with archive (any entity may be archived), so the pair is new on every run.
  const form = a.getByTestId('policy-new');
  await expect(form).toBeVisible();
  await expectNoAxeViolations(a);
  const entity = `E2eArchive${Date.now().toString(36)}`;
  await form.getByLabel('Record type').fill(entity);
  await form.getByLabel('Kept for').fill('400');
  await form.getByLabel('Afterwards').selectOption('archive');
  await form.getByRole('button', { name: 'Send for approval' }).click();
  await confirmWith(a, 'en', `Add a retention policy for ${entity}`, 'Send for approval', 'planned_change', 'AC14-2 E2E');
  await reject(b, await pendingChange(form));

  // Dry run on the first listed policy.
  await gotoReady(a, '/retention');
  await a.getByRole('table', { name: 'Retention policies' }).locator('button[data-row-button]').first().click();
  const dry = a.getByTestId('retention-dry-run');
  await dry.getByRole('button', { name: 'Count what the next run would do' }).click();
  await expect(dry.getByTestId('dry-run-result')).toBeVisible({ timeout: 30_000 });
  await expectNoAxeViolations(a);

  // Plans: assignments and plan requests.
  await gotoReady(a, '/plans?tab=assignments');
  await expect(a.getByRole('table', { name: 'Subscriptions' })).toBeVisible();
  await expect(a.getByTestId('assign-form')).toBeVisible();
  await expect(a.getByText('Loading…')).toHaveCount(0, { timeout: 30_000 });
  await expectNoAxeViolations(a);
  await a.getByRole('tab', { name: 'Plan requests' }).click();
  await expect(a.getByRole('table', { name: 'Plan requests' })).toBeVisible();
  await expect(a.getByText('Loading…')).toHaveCount(0, { timeout: 30_000 });
  await expectNoAxeViolations(a);
  await ctxA.close();
  await ctxB.close();
});

test('a moderator takes a business check, asks for more information, reads and corrects the organization (EN)', async ({ browser }) => {
  const shop = await publishedShop('ac142-ver');
  const checkId = await submitVerification(shop, 'business_identity');
  const purpose = encodeURIComponent(`verification:${checkId}`);
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInAs(context, page, ['MOD'], { path: `/verification?verification=${checkId}&purpose=${purpose}` });

  await expect(page.getByTestId('verification-item')).toHaveAttribute('data-verification', checkId);
  const assign = page.getByTestId('verification-assign');
  await assign.getByRole('button', { name: 'Take this check' }).click();
  await expect(assign.getByTestId('verification-assignee')).toHaveText('You are reviewing this check.', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Ask the business for more' }).click();
  const info = page.getByTestId('info-request-form');
  await info.getByLabel('Kind of request').selectOption('details_mismatch');
  await expectNoAxeViolations(page);
  await info.getByRole('button', { name: 'Send the request' }).click();
  await confirmWith(page, 'en', 'Ask the business for more information', 'Send the request', 'details_mismatch');
  await expect(page.getByTestId('clock-paused')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('info-request')).toContainText('Asked for more information');

  // The organization for this check: the S23 tabs.
  await gotoReady(page, `/orgs/${shop.id}?purpose=${purpose}`);
  await expect(page.getByTestId('profile-tab')).toBeVisible();
  await expect(page.getByTestId('profile-history')).toBeVisible();
  await page.getByRole('button', { name: 'Correct the profile' }).click();
  const fix = page.getByTestId('profile-correction');
  await fix.getByLabel('Website').fill('https://example.com/ac142');
  await fix.getByRole('button', { name: 'Save the correction' }).click();
  await confirmWith(page, 'en', "Correct this organization's profile", 'Save the correction', 'obvious_error', 'AC14-2 E2E');
  await expect(page.getByText('Corrected. The business is told.')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('profile-history')).toContainText('https://example.com/ac142', { timeout: 30_000 });
  await expectNoAxeViolations(page);
  for (const [name, id] of [
    ['Capabilities & badges', 'caps-tab'],
    ['Portfolio', 'portfolio-tab'],
    ['Members', 'members-tab'],
    ['Plan', 'plan-history'],
  ] as const) {
    await tab(page, name, id);
    await expectNoAxeViolations(page);
  }
  await context.close();
});

test('a community reviewer writes to the business in an objection thread; My decisions (FA)', async ({ browser }) => {
  const shop = await publishedShop('ac142-dsp');
  const review = await path2Review(shop, 'ac142-dsp');
  await businessAnswers(shop, review.id, 'rejected', 'We have no record of this customer.');
  const context = await browser.newContext({ locale: 'fa-IR' });
  const page = await context.newPage();
  await signInAs(context, page, ['CRV'], { path: '/disputes', locale: 'fa' });
  const disputeId = await page.evaluate(async (reviewId) => {
    for (let i = 0; i < 20; i++) {
      const res = await fetch('/api/v1/admin/disputes?status=open&dispute_type=review_approval_objection&limit=100');
      const body = (await res.json()) as { items: { id: string; target: { id: string } }[] };
      const hit = body.items.find((d) => d.target.id === reviewId);
      if (hit) return hit.id;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return null;
  }, review.id);
  expect(disputeId).toBeTruthy();
  await gotoReady(page, `/disputes?dispute=${disputeId}&purpose=dispute:${disputeId}`);
  await expect(page.getByTestId('dispute-item')).toHaveAttribute('data-dispute', disputeId!);
  const raiser = page.getByTestId('thread-raiser');
  await expect(raiser).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('dispute-respondent')).toBeVisible();
  const composer = page.getByTestId('composer-raiser');
  await composer.getByLabel(say('fa', 'disputes.thread.templateLabel')).selectOption('request_evidence');
  await expect(composer.getByLabel(say('fa', 'disputes.thread.message'), { exact: true })).toHaveValue(
    say('fa', 'disputes.thread.text.request_evidence'),
  );
  await expectNoAxeViolations(page);
  await composer.getByRole('button', { name: say('fa', 'disputes.thread.send') }).click();
  await confirmWith(page, 'fa', say('fa', 'disputes.thread.dialog.raiser'), say('fa', 'disputes.thread.send'), 'evidence_needed');
  await expect(raiser.getByText(say('fa', 'disputes.thread.text.request_evidence'))).toBeVisible({ timeout: 30_000 });
  await expect(raiser).toContainText('CarPal');

  await gotoReady(page, '/decisions');
  await expect(page.getByRole('heading', { level: 1, name: say('fa', 'decisions.title') })).toBeVisible();
  await expect(page.getByRole('table', { name: say('fa', 'decisions.listLabel') })).toBeVisible();
  await expectNoAxeViolations(page);
  await context.close();
});

test('organization filters and Merge duplicate (rejected by a second admin); a user’s tabs; a moderation view (EN)', async ({
  browser,
}) => {
  const [keep, dup] = await Promise.all([publishedShop('ac142-keep'), publishedShop('ac142-dup')]);
  const user = await appUser('ac142-user', 'Dana Example');
  const dsr = await requestData(user, 'export', 'AC14-2 E2E');
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  await Promise.all([
    signInAs(ctxA, a, ['ADM'], { path: '/orgs?location_issue=true' }),
    signInAs(ctxB, b, ['ADM'], { path: '/approvals' }),
  ]);

  await expect(a.getByRole('table', { name: 'Organizations' })).toBeVisible();
  await expect(a.getByRole('navigation', { name: 'Saved views' }).getByRole('link', { name: 'Possible duplicates' })).toBeVisible();
  await expect(a.getByText('Loading…')).toHaveCount(0, { timeout: 60_000 });
  await expectNoAxeViolations(a);

  await gotoReady(a, `/orgs/${dup.id}`);
  await a.getByRole('button', { name: 'Merge duplicate' }).click();
  const panel = a.getByTestId('merge-panel');
  await panel.getByLabel('Or its ID').fill(keep.id);
  await panel.getByRole('button', { name: 'Preview with this ID' }).click();
  await expect(panel.getByTestId('merge-preview')).toBeVisible({ timeout: 30_000 });
  await expectNoAxeViolations(a);
  const send = panel.getByRole('button', { name: 'Send the merge for approval' });
  await expect(send).toBeEnabled();
  await send.click();
  await confirmWith(a, 'en', 'Merge this organization', 'Send the merge for approval', 'duplicate', 'AC14-2 E2E, rejected by design');
  await reject(b, await pendingChange(panel));

  // The user of a privacy request: the S23 tabs under dsr:<id>.
  const purpose = encodeURIComponent(`dsr:${dsr.id}`);
  await gotoReady(a, `/privacy?type=export&status=received&request=${dsr.id}&purpose=${purpose}`);
  const userHref = await a.getByTestId('dsr-user-link').getAttribute('href');
  await gotoReady(a, userHref!);
  await expect(a.getByTestId('user-name')).toBeVisible();
  for (const [name, id] of [
    ['Vehicles', 'user-vehicles'],
    ['Appointments', 'user-appointments'],
    ['Consents', 'user-consents'],
    ['Sessions & devices', 'user-sessions'],
  ] as const) {
    await tab(a, name, id);
    await expectNoAxeViolations(a);
  }

  // A moderation view goes to the server as a reason filter.
  await gotoReady(a, '/content?tab=content&view=consent');
  await expect(a.getByText('Loading…')).toHaveCount(0, { timeout: 60_000 });
  await expect(a.getByRole('combobox', { name: 'Reason' })).toBeVisible();
  await ctxA.close();
  await ctxB.close();
});
