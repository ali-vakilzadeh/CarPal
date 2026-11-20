// AC10b.T5: staff security keys, recovery codes and account recovery against the live backend (strict for the
// acceptance run; backend S16a, S16b). Every account is new (a completed recovery restricts its account for 72 hours
// and ends its sessions, so the shared dev accounts are never used). Chrome's virtual authenticators stand for the
// security keys: a second one for a backup key, and a fresh one for the "new device" after a lost key.
//   EN  the Security page: codes shown once at enrolment, a backup key, the first key removed, new codes
//   EN  a lost key: the request with a stored code, two administrators approve it, the new key and new codes, the
//       restriction banner; the request completed on Recovery requests
//   FA  a request rejected by an administrator; the requester learns it on the waiting page; axe on the pages
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { expectNoAxeViolations } from './support';
import {
  addSecurityKey,
  createStaff,
  EN,
  FA,
  lastCode,
  requireBackend,
  signInOnPage,
  signInWithCodes,
  STAFF_PASSWORD,
  storeRecoveryCodes,
} from './staff';

test.beforeAll(requireBackend);
test.describe.configure({ mode: 'serial', timeout: 240_000 });

const unique = (prefix: string) => `${prefix} ${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

async function freshContext(browser: Browser, locale: 'en-US' | 'fa-IR' = 'en-US'): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ locale });
  return { context, page: await context.newPage() };
}

/** "Lost your security key?" on a new sign-in page: the request with a stored code, then the emailed code. */
async function askForRecovery(page: Page, email: string, code: string, fa = false) {
  await page.goto('/');
  await page.waitForURL(/\/id\/signin\?/);
  await page.locator('html[data-hydrated="true"]').waitFor({ state: 'attached' });
  await page.getByRole('button', { name: fa ? 'کلید امنیتی خود را گم کرده‌اید؟' : 'Lost your security key?' }).click();
  const form = page.getByTestId('recover-start');
  await form.getByLabel(fa ? FA.email : EN.email).fill(email);
  await form.getByLabel(fa ? FA.password : EN.password, { exact: true }).fill(STAFF_PASSWORD);
  await form.getByLabel(fa ? 'کد بازیابی' : 'Recovery code').fill(code.toLowerCase());
  if (!fa) await expectNoAxeViolations(page);
  await form.getByRole('button', { name: fa ? 'درخواست بازیابی' : 'Ask for a recovery' }).click();
  const verify = page.getByTestId('recover-code');
  await verify.getByLabel(fa ? FA.code : EN.code).fill(await lastCode(email, 'identity.staff_recovery_code'));
  await verify.getByRole('button', { name: fa ? 'فرستادن درخواست' : 'Send the request' }).click();
  await expect(page.getByTestId('recover-wait')).toBeVisible({ timeout: 60_000 });
}

/** An administrator opens the request of `name` on Recovery requests and decides it. */
async function decide(page: Page, name: string, decision: 'approve' | 'reject', fa = false) {
  await page.goto('/recoveries');
  const table = page.getByRole('table', { name: fa ? 'درخواست‌های بازیابی' : 'Recovery requests' });
  await table.getByRole('button', { name }).click();
  const detail = page.getByTestId('recovery-detail');
  await expect(detail).toBeVisible();
  if (decision === 'approve') {
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Approve the recovery' });
    await dialog.getByLabel('Call to a known phone number').check();
    await dialog.getByLabel('Reason').selectOption('identity_verified');
    await dialog.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(page.getByText('Approval recorded.')).toBeVisible({ timeout: 30_000 });
  } else {
    await page.getByRole('button', { name: fa ? 'رد' : 'Reject', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: fa ? 'رد بازیابی' : 'Reject the recovery' });
    await dialog.getByLabel(fa ? 'دلیل' : 'Reason').selectOption('suspicious_request');
    await dialog.getByRole('textbox').fill(fa ? 'کسی با ما تماس نگرفت' : 'Nobody called us');
    await dialog.getByRole('button', { name: fa ? 'رد' : 'Reject', exact: true }).click();
    await expect(page.getByText(fa ? 'درخواست رد شد.' : 'The request was rejected.')).toBeVisible({ timeout: 30_000 });
  }
}

test('Security page: a backup key, the first key removed, new recovery codes shown once (EN)', async ({ context, page }) => {
  const { codes, key } = await signInWithCodes(context, page, ['MOD']);
  expect(codes).toHaveLength(10);
  expect(codes[0]).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){4}$/);
  // The codes were never kept by the browser (GD-12).
  // eslint-disable-next-line no-restricted-globals -- reads the storage only to prove nothing was put there
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))).not.toContain(codes[0]);

  await page.getByRole('button', { name: /Account menu/ }).click();
  await page.getByRole('link', { name: 'Security keys and recovery codes' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Security keys and recovery codes' })).toBeVisible();
  await expect(page.getByTestId('security-key')).toHaveCount(1);
  await expect(page.getByTestId('security-codes-left')).toHaveAttribute('data-remaining', '10');
  await expectNoAxeViolations(page);

  // A second security key (another authenticator; the first one already holds this account's credential).
  await key.remove();
  const backup = await addSecurityKey(context, page);
  await page.getByLabel('Name of the key').fill('Backup key');
  await page.getByRole('button', { name: 'Add backup key' }).click();
  await expect(page.getByTestId('security-added')).toContainText('Backup key "Backup key" added.', { timeout: 60_000 });
  await expect(page.getByTestId('security-key')).toHaveCount(2);

  // The first key goes; the backup key stays (the last sign-in key could not be removed).
  const first = page.getByTestId('security-key').filter({ hasNotText: 'Backup key' });
  await first.getByRole('button', { name: /^Remove / }).click();
  await page.getByRole('dialog', { name: 'Remove this security key?' }).getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByTestId('security-removed')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('security-key')).toHaveCount(1);
  await expect(page.getByTestId('security-key').getByRole('button', { name: /^Remove / })).toBeDisabled();

  // New recovery codes: the old set stops working; the new one is shown once.
  await page.getByRole('button', { name: 'New recovery codes' }).click();
  await page.getByRole('dialog', { name: 'Make new recovery codes?' }).getByRole('button', { name: 'New recovery codes' }).click();
  await expect(page.getByTestId('recovery-code')).toHaveCount(10, { timeout: 30_000 });
  const fresh = await page.getByTestId('recovery-code').allTextContents();
  expect(fresh).toHaveLength(10);
  expect(fresh).not.toContain(codes[0]);
  await page.getByLabel('I have stored them').check();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByTestId('recovery-code')).toHaveCount(0);
  await expect(page.getByTestId('security-codes-left')).toHaveAttribute('data-remaining', '10');
  await backup.remove();
});

test('lost key: a recovery approved by two administrators, a new key and new codes, then restricted (EN)', async ({ browser }) => {
  const name = unique('E2E Recover');
  const email = createStaff(['MOD'], { name });
  const before = await freshContext(browser);
  await addSecurityKey(before.context, before.page);
  await before.page.goto('/');
  const codes = await signInOnPage(before.page, email, { enrol: true });
  await before.context.close();
  const requester = await freshContext(browser);

  // The key is lost: another browser asks for a recovery with a stored code.
  await askForRecovery(requester.page, email, codes[3]!);
  await expect(requester.page.getByTestId('recover-wait')).toHaveAttribute('data-approvals', '0');
  // The request handle is server-side only (AC10b.T3).
  const cookieNames = (await requester.context.cookies()).map((c) => c.name);
  expect(cookieNames).toContain('__Host-cpa_rcv');
  expect(await requester.page.content()).not.toMatch(/request_handle/);
  await expectNoAxeViolations(requester.page);

  for (const n of [1, 2]) {
    const admin = await freshContext(browser);
    await signInWithCodes(admin.context, admin.page, ['ADM'], { path: '/recoveries' });
    await decide(admin.page, name, 'approve');
    await expect(admin.page.getByTestId('recovery-approvals')).toContainText(`${n} of 2`);
    if (n === 1) await expectNoAxeViolations(admin.page);
    if (n === 2) await expect(admin.page.getByTestId('recovery-status')).toHaveText('Approved');
    await admin.context.close();
  }

  // Back on the waiting page: approved; a new key on a new device, then the new codes once.
  await requester.page.getByRole('button', { name: 'Check again' }).click();
  await expect(requester.page.getByTestId('recover-approved')).toBeVisible({ timeout: 30_000 });
  await requester.page.getByRole('button', { name: 'Continue' }).click();
  const newKey = await addSecurityKey(requester.context, requester.page);
  await requester.page.getByTestId('recover-key').getByRole('button', { name: 'Create security key' }).click();
  const newCodes = await storeRecoveryCodes(requester.page);
  expect(newCodes).toHaveLength(10);
  expect(newCodes).not.toContain(codes[0]);
  await requester.page.getByRole('button', { name: EN.useKey }).click({ timeout: 60_000 });
  await requester.page.waitForURL((u) => !u.pathname.startsWith('/id/') && !u.pathname.startsWith('/bff/'), { timeout: 60_000 });
  await expect(requester.page.getByTestId('restricted-banner')).toContainText('Your account was recovered recently');
  expect((await requester.context.cookies()).map((c) => c.name)).not.toContain('__Host-cpa_rcv');
  await newKey.remove();
  await requester.context.close();
});

test('a recovery rejected by an administrator; the requester learns it (FA)', async ({ browser }) => {
  const name = unique('E2E Rejected');
  const email = createStaff(['CRV'], { name, locale: 'fa' });
  const before = await freshContext(browser, 'fa-IR');
  await addSecurityKey(before.context, before.page);
  await before.page.goto('/');
  const codes = await signInOnPage(before.page, email, { enrol: true, labels: FA });
  await before.context.close();
  const requester = await freshContext(browser, 'fa-IR');
  await askForRecovery(requester.page, email, codes[0]!, true);
  await expectNoAxeViolations(requester.page);

  const admin = await freshContext(browser, 'fa-IR');
  await signInWithCodes(admin.context, admin.page, ['ADM'], { path: '/recoveries', locale: 'fa' });
  await decide(admin.page, name, 'reject', true);
  await expect(admin.page.getByTestId('recovery-status')).toHaveText('ردشده');
  await expectNoAxeViolations(admin.page);
  await admin.context.close();

  await requester.page.getByRole('button', { name: 'بررسی دوباره' }).click();
  await expect(requester.page.getByTestId('recover-ended')).toHaveAttribute('data-state', 'rejected', { timeout: 30_000 });
  await expectNoAxeViolations(requester.page);
  // The ended request was dropped from the BFF.
  expect((await requester.context.cookies()).map((c) => c.name)).not.toContain('__Host-cpa_rcv');
  await requester.context.close();
});
