// AC7.T6 E2E (acceptance "A CRV can clear the approval queue end to end; a MOD without CRV cannot decide approvals",
// "Dispute decisions by the original decider are refused and explained", "E2E and axe pass in EN and FA").
// Path 2 reviews are written through the real API by fresh users of the mobile client (tests/e2e/app-user.ts):
//   1. The business confirms the customer; a community reviewer opens the review from the queue and confirms it with a
//      reason: the author sees it published as approved_without_visit. A moderator without the reviewer role sees the
//      queue but no decision buttons. Axe on both (EN).
//   2. A reviewer asks for evidence (so they made a decision on it); the business then rejects the customer, which opens
//      a review_approval_objection. That reviewer may not decide the objection: the console explains the refusal. A
//      moderator, in Persian, publishes the review (objection not accepted): the author sees it published and marked
//      disputed by the business. Axe on the dispute in FA.
// Needs backend `pnpm dev` with the console's settings (README "End-to-end tests").
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { authorView, businessAnswers, path2Review, publishedShop } from './app-user';
import { expectNoAxeViolations, gotoReady } from './support';
import { requireBackend, signInAs } from './staff';

type Dict = Record<string, unknown>;
const dict = (l: 'en' | 'fa') =>
  (JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'src', 'lib', 'i18n', 'locales', `${l}.json`), 'utf8')) as Dict)
    .admin as Dict;
const DICT = { en: dict('en'), fa: dict('fa') };
/** A console string by its key under `admin.` (placeholders left out). */
const say = (l: 'en' | 'fa', key: string) => key.split('.').reduce<unknown>((o, k) => (o as Dict)[k], DICT[l]) as string;

test.beforeAll(async () => {
  await requireBackend();
});

/** As the signed-in staff member: the review's approval view through the BFF (its dispute id once the business objected). */
async function approvalView(page: Page, reviewId: string): Promise<{ dispute_id: string | null }> {
  return page.evaluate(async (id) => {
    const res = await fetch(`/api/v1/admin/review-approvals/${id}`, { headers: { 'carpal-access-purpose': `approval:${id}` } });
    return (await res.json()) as { dispute_id: string | null };
  }, reviewId);
}

async function chooseReason(page: Page, l: 'en' | 'fa', code: string, note?: string) {
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(say(l, 'kit.reason.code')).selectOption(code);
  if (note) await dialog.getByRole('textbox').first().fill(note);
  return dialog;
}

test('a community reviewer confirms a Path 2 review end to end; a moderator cannot decide (AC7, EN)', async ({ browser }) => {
  test.setTimeout(300_000);
  const shop = await publishedShop('t1');
  const [confirmed, other] = await Promise.all([path2Review(shop, 't1a', { rating: 2 }), path2Review(shop, 't1b', { rating: 4 })]);
  await businessAnswers(shop, confirmed.id, 'confirmed', 'Yes, last Tuesday');
  await businessAnswers(shop, other.id, 'confirmed');

  const crvCtx = await browser.newContext();
  const modCtx = await browser.newContext();
  const crv = await crvCtx.newPage();
  const mod = await modCtx.newPage();
  await Promise.all([
    signInAs(crvCtx, crv, ['CRV'], { path: `/reviews?review=${confirmed.id}&purpose=approval:${confirmed.id}` }),
    signInAs(modCtx, mod, ['MOD'], { path: `/reviews?review=${other.id}&purpose=approval:${other.id}` }),
  ]);

  // The reviewer: the review with the business's answer; Confirm with a reason (A opens the dialog).
  const item = crv.getByTestId('approval-item');
  await expect(item).toHaveAttribute('data-review', confirmed.id);
  await expect(item.getByTestId('business-answer')).toHaveText('Confirmed by the business');
  await expect(item.getByText('Yes, last Tuesday')).toBeVisible();
  await expect(crv.getByTestId('rating-reminder')).toBeVisible();
  await expectNoAxeViolations(crv);
  await crv.getByRole('button', { name: 'Confirm' }).waitFor();
  await crv.keyboard.press('a');
  const dialog = await chooseReason(crv, 'en', 'customer_confirmed');
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(crv.getByTestId('decision-done')).toContainText('Approved by the business and CarPal');
  await expect.poll(async () => (await authorView(confirmed.author, confirmed.id)).verified_status).toBe('approved_without_visit');
  expect(await authorView(confirmed.author, confirmed.id)).toMatchObject({ status: 'published', reviewer_decision: 'approved' });

  // The moderator: reads the queue and the review, no decision buttons; the review cases tab is theirs.
  await expect(mod.getByTestId('approval-item')).toHaveAttribute('data-review', other.id);
  await expect(mod.getByTestId('cannot-decide')).toHaveText(say('en', 'reviews.crvOnly'));
  await expect(mod.getByRole('button', { name: 'Confirm' })).toHaveCount(0);
  await expect(mod.getByRole('link', { name: 'Review cases' })).toBeVisible();
  await expectNoAxeViolations(mod);
  await gotoReady(mod, '/reviews?tab=cases');
  await expect(mod.getByRole('table', { name: 'Review cases' })).toBeVisible();
  await expectNoAxeViolations(mod);
  await Promise.all([crvCtx.close(), modCtx.close()]);
});

test('a business objection is decided by a different staff member; the first decider is refused (AC7, FA)', async ({ browser }) => {
  test.setTimeout(300_000);
  const shop = await publishedShop('t2');
  const review = await path2Review(shop, 't2', { rating: 1 });

  const aCtx = await browser.newContext();
  const bCtx = await browser.newContext();
  const a = await aCtx.newPage();
  const b = await bCtx.newPage();
  await Promise.all([
    signInAs(aCtx, a, ['CRV'], { path: `/reviews?stage=awaiting_business&review=${review.id}&purpose=approval:${review.id}` }),
    signInAs(bCtx, b, ['MOD'], { path: '/disputes', locale: 'fa' }),
  ]);

  // Reviewer A asks for evidence while the business has not answered (Confirm waits for the business).
  await expect(a.getByTestId('approval-item')).toHaveAttribute('data-review', review.id);
  await expect(a.getByRole('button', { name: 'Confirm' })).toBeDisabled();
  await expect(a.getByTestId('confirm-block')).toBeVisible();
  await a.getByRole('button', { name: 'Ask for evidence' }).click();
  const ask = await chooseReason(a, 'en', 'invoice_needed');
  await ask.getByRole('button', { name: 'Ask for evidence' }).click();
  await expect(a.getByTestId('decision-done')).toContainText('Evidence requested');

  // The business says the author was not its customer: an objection dispute opens; the review stays.
  await businessAnswers(shop, review.id, 'rejected', 'We have no record of this customer.');
  const disputeId = (await approvalView(a, review.id)).dispute_id;
  expect(disputeId).toBeTruthy();
  expect(await authorView(review.author, review.id)).toMatchObject({
    status: 'pending_approval',
    business_confirmation_status: 'rejected',
  });

  // A made a decision on this review: deciding its objection is refused and explained.
  await gotoReady(a, `/disputes?dispute=${disputeId}&purpose=dispute:${disputeId}`);
  await expect(a.getByTestId('dispute-item')).toHaveAttribute('data-dispute', disputeId!);
  await expect(a.getByTestId('first-decider')).toBeVisible();
  const formA = a.getByTestId('dispute-decision');
  await formA.getByLabel(say('en', 'disputes.outcomesObjection.resolved_upheld')).check();
  await formA.getByLabel(say('en', 'disputes.resolutionRequiredLabel')).fill('The author showed an invoice.');
  await formA.getByRole('button', { name: 'Record the decision' }).click();
  const refusedDialog = await chooseReason(a, 'en', 'evidence_supports_claim');
  await refusedDialog.getByRole('checkbox').check();
  await refusedDialog.getByRole('button', { name: 'Record the decision' }).click();
  await expect(a.getByTestId('different-staff-refused')).toContainText('A colleague must decide this');
  await expectNoAxeViolations(a);

  // Moderator B, in Persian, publishes the review (the objection is not accepted).
  await gotoReady(b, `/disputes?type=review_approval_objection&dispute=${disputeId}&purpose=dispute:${disputeId}`);
  await expect(b.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(b.getByRole('heading', { level: 1, name: say('fa', 'disputes.title') })).toBeVisible();
  await expect(b.getByTestId('disputed-review')).toBeVisible();
  await expectNoAxeViolations(b);
  const formB = b.getByTestId('dispute-decision');
  await formB.getByLabel(say('fa', 'disputes.outcomesObjection.resolved_upheld')).check();
  await expect(formB.getByTestId('outcome-effect')).toHaveText(say('fa', 'disputes.effect.objectionUpheld'));
  await formB.getByLabel(say('fa', 'disputes.resolutionRequiredLabel')).fill('نویسنده فاکتور را نشان داد.');
  await formB.getByRole('button', { name: say('fa', 'disputes.record') }).click();
  const dialogB = await chooseReason(b, 'fa', 'evidence_supports_claim');
  await dialogB.getByRole('checkbox').check();
  await dialogB.getByRole('button', { name: say('fa', 'disputes.record') }).click();
  await expect(b.getByTestId('dispute-closed')).toBeVisible();
  await expect(b.getByTestId('dispute-resolution')).toHaveText('نویسنده فاکتور را نشان داد.');
  await expectNoAxeViolations(b);

  await expect.poll(async () => (await authorView(review.author, review.id)).status).toBe('published');
  expect(await authorView(review.author, review.id)).toMatchObject({
    verified_status: 'approved_without_visit',
    disputed_by_business: true,
  });
  await Promise.all([aCtx.close(), bCtx.close()]);
});
