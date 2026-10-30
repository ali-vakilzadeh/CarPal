// P9.T6: settings, notifications and My Activity in the built PWA against the live backend (`pnpm dev` in backend/ with
// the env of pwa/README.md). Sara turns on two-step sign-in with an authenticator app (QR + key, a real TOTP code,
// recovery codes shown once), logs out and signs in again with the code (the hosted sign-in's MFA step); with the
// stronger sign-in she requests a data export and sees it in the list (Data & account, and My Activity → Reports &
// requests); the welcome notification is in the bell and on the page; her display name preview updates. axe on every
// visited page, the settings sections in EN and FA.
import { expect, test, type Page } from '@playwright/test';
import { totp } from '../support/totp';
import { backendUp, createUser } from './accounts';
import { decideCookies, expectNoAxeViolations, gotoReady } from './support';

test.beforeEach(async ({ request, context, baseURL }) => {
  test.skip(!(await backendUp(request)), 'needs the backend (`pnpm dev` in backend/)');
  await decideCookies(context, baseURL!);
});

async function passwordStep(page: Page, user: { email: string; password: string }) {
  await page.waitForURL(/\/id\/signin\?interaction_id=/);
  await page.locator('html[data-hydrated="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Mobile number or email').fill(user.email);
  await page.getByRole('button', { name: 'Use password' }).click();
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Continue' }).click();
}

async function finishOnboarding(page: Page) {
  await page.waitForURL(/\/en\/onboarding\?next=/);
  await page.getByRole('link', { name: 'Finish later' }).click();
  await page.waitForURL(/\/en(\/home)?$/);
}

/** Waits for the next 30-second TOTP window, so a code is never used twice. */
async function freshCode(page: Page, secret: string, last: { at: number }) {
  const window = (t: number) => Math.floor(t / 30_000);
  if (window(Date.now()) === window(last.at)) await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 500);
  last.at = Date.now();
  return totp(secret);
}

test('two-step sign-in with an authenticator app, then a data export (P9 E2E)', async ({ page, request }) => {
  test.setTimeout(150_000);
  const user = await createUser(request, { fullName: 'Sara Mohammadi' });
  await page.goto('/en/login');
  await passwordStep(page, user);
  await finishOnboarding(page);

  // Profile: the public name preview.
  await gotoReady(page, '/en/settings/profile');
  await expect(page.getByText('Your reviews show: Sara M.')).toBeVisible();
  await expectNoAxeViolations(page);

  // Sign-in & security: enrol the authenticator app.
  await gotoReady(page, '/en/settings/security');
  await expect(page.getByTestId('session-row').first()).toBeVisible({ timeout: 15_000 });
  await expectNoAxeViolations(page);
  await page.getByRole('button', { name: 'Add authenticator app' }).click();
  await expect(page.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
  const secret = (await page.getByTestId('totp-secret').innerText()).replace(/\s/g, '');
  await expectNoAxeViolations(page);
  const used = { at: 0 };
  await page.getByLabel('Code from the app').fill(await freshCode(page, secret, used));
  await page.getByRole('button', { name: 'Turn on' }).click();
  const codes = page.getByRole('dialog', { name: 'Your recovery codes' });
  await expect(codes.getByTestId('recovery-codes').locator('li')).toHaveCount(10);
  await expectNoAxeViolations(page);
  await codes.getByRole('button', { name: "I've saved them" }).click();
  await expect(page.getByText('Authenticator app ·', { exact: false })).toBeVisible();

  // Log out (on a public page: on a private one the session gate goes straight to the hosted sign-in) and sign in
  // again: password, then the code from the app.
  await gotoReady(page, '/en/how-ranking-works');
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Log in' }).first()).toBeVisible();
  await page.goto('/en/login');
  await passwordStep(page, user);
  await expect(page.getByRole('heading', { name: 'Two-step sign-in' })).toBeVisible();
  await expectNoAxeViolations(page);
  // The code boxes send by themselves once six digits are in (P4 CodeInput).
  await page.getByRole('textbox', { name: 'Digit 1 of 6' }).fill(await freshCode(page, secret, used));
  await finishOnboarding(page);

  // Data & account: request the export (AAL2, met by the fresh two-step sign-in) and see it listed.
  await gotoReady(page, '/en/settings/data');
  await page.getByRole('button', { name: 'Request my data' }).click();
  await expect(page.getByTestId('export-status')).toContainText('Received');
  await expect(page.getByTestId('dsr-table')).toContainText('Data export');
  await expectNoAxeViolations(page);
  await gotoReady(page, '/en/activity?tab=reports');
  await expect(page.getByTestId('activity-dsr')).toContainText('Data export');
  await expectNoAxeViolations(page);

  // Notifications: the welcome is in the bell's dropdown and on the page.
  await gotoReady(page, '/en/notifications');
  await expect(page.getByText('Welcome to CarPal').first()).toBeVisible();
  await expectNoAxeViolations(page);
  await page.getByRole('button', { name: /^Notifications/ }).click();
  await expect(page.getByRole('link', { name: 'See all notifications' })).toBeVisible();
  await expectNoAxeViolations(page);
});

test('every settings section renders in FA and EN without axe violations', async ({ page, request }) => {
  // 18 pages with axe: about a minute alone, longer when every worker is busy.
  test.setTimeout(300_000);
  const user = await createUser(request);
  await page.goto('/en/login');
  await passwordStep(page, user);
  await finishOnboarding(page);
  for (const locale of ['fa', 'en'] as const) {
    for (const section of ['profile', 'security', 'privacy', 'ai', 'notifications', 'language', 'data', 'help']) {
      await gotoReady(page, `/${locale}/settings/${section}`);
      await expect(page.locator('#settings-section-title')).toBeVisible();
      await page.waitForLoadState('networkidle');
      await expectNoAxeViolations(page);
    }
    await gotoReady(page, `/${locale}/activity`);
    await page.waitForLoadState('networkidle');
    await expectNoAxeViolations(page);
  }
});
