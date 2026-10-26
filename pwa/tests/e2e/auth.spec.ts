// P4.T8: the hosted sign-in and the web onboarding in the built PWA against the live backend (`pnpm dev` in backend/
// with the env of pwa/README.md, incl. CARPAL_RATE_LIMIT_SCALE=100 and the https://localhost:3100 redirect URI).
// Sara's Ch. 1-3 path: sign up with email + code (read from the outbox), onboarding with the BMW 320i E90, sign out,
// sign in with the password, then with a code in another browser context and see the car. Also the Persian
// variant, the gated action round trip (P3 criterion 3) and the password reset link. axe on every visited page.
import { expect, test, type Page } from '@playwright/test';
import { backendUp, createUser, mailedCode, mailedLinkToken, newEmail, now } from './accounts';
import { decideCookies, expectNoAxeViolations, gotoReady } from './support';

const VIN_CHARS = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';

test.beforeEach(async ({ request, context, baseURL }) => {
  test.skip(!(await backendUp(request)), 'needs the backend (`pnpm dev` in backend/)');
  await decideCookies(context, baseURL!);
});

/** Waits for the hosted sign-in to be interactive. */
async function onHostedSignin(page: Page) {
  await page.waitForURL(/\/id\/signin\?interaction_id=/);
  await page.locator('html[data-hydrated="true"]').waitFor({ state: 'attached' });
}

async function enterCode(page: Page, code: string) {
  await page.getByRole('textbox', { name: /Digit 1 of 6|رقم ۱ از ۶/ }).fill(code);
}

test('Sara: sign up with a code, add the BMW E90, sign out, sign in with the password and with a code elsewhere', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const email = newEmail('sara');
  const password = 'silver e90 from 2012';
  // One owner per VIN (BA-04): a fresh European VIN per run (no check digit), position 10 "B" = model year 2011.
  const vin = `WBAPH5C55B${Array.from({ length: 7 }, () => VIN_CHARS[Math.floor(Math.random() * VIN_CHARS.length)]).join('')}`;

  // Ch. 1: from the landing page to the hosted sign-in, on account creation.
  await gotoReady(page, '/en');
  await page.getByRole('banner').getByRole('link', { name: 'Sign up' }).click();
  await onHostedSignin(page);
  await expect(page.getByRole('heading', { name: 'Create account' })).toBeVisible();
  await expectNoAxeViolations(page);
  await page.getByLabel('Full name').fill('Sara Mohammadi');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password (optional)').fill(password);
  await page.getByLabel('I agree to the Terms').check();
  await page.getByLabel('I have read the Privacy Policy').check();
  const since = now();
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page.getByRole('heading', { name: 'Verify your email' })).toBeVisible();
  await expectNoAxeViolations(page);
  await enterCode(page, await mailedCode(email, since));

  // Ch. 2: onboarding, with the first car.
  await page.waitForURL(/\/en\/onboarding\?next=/);
  await expect(page.getByRole('heading', { name: 'How will you mainly use CarPal?' })).toBeVisible();
  await expectNoAxeViolations(page);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Add your car' })).toBeVisible();
  await page.getByLabel('Brand').selectOption({ label: 'BMW' });
  await page.getByLabel('Model').selectOption({ label: '3 Series' });
  await page.getByLabel('Series (optional)').selectOption({ label: 'E90' });
  await page.getByLabel('Year').selectOption('2012');
  await page.getByLabel('VIN (optional)').fill(vin.toLowerCase());
  await page.getByLabel('Mileage (optional)').fill('148000');
  await page.getByLabel('Nickname (optional)').fill('Silver');
  await expectNoAxeViolations(page);
  await page.getByRole('button', { name: 'Save vehicle' }).click();
  await expect(page.getByText('Silver · BMW 3 Series is in your garage.')).toBeVisible();
  // The lite decoder reads the model year from the VIN (position 10 "B" = 2011).
  await expect(page.getByText('This VIN suggests 2011; you entered 2012.')).toBeVisible();
  await page.getByRole('button', { name: 'Keep 2012' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Is anything wrong with this car right now?' })).toBeVisible();
  await page.getByRole('button', { name: 'Not now' }).click();
  await expect(page.getByRole('heading', { name: 'Permissions' })).toBeVisible();
  await expectNoAxeViolations(page);
  await page.getByRole('button', { name: 'Finish' }).click();

  // Signed in, onboarded: the landing page sends the account home; the garage box shows the car.
  await page.waitForURL(/\/en\/home$/);
  await expect(page.getByRole('region', { name: 'Your garage' }).getByRole('link', { name: 'Silver · BMW 3 Series' })).toBeVisible();

  // Sign out; the private page sends the guest to the hosted sign-in. Ch. 3: back in with the password.
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('button', { name: 'Log out' }).click();
  await onHostedSignin(page);
  await page.getByLabel('Mobile number or email').fill(email);
  await page.getByRole('button', { name: 'Use password' }).click();
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForURL(/\/en\/home$/);
  await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible();

  // Another browser: sign in with a code and see the car.
  const other = await browser.newContext({ baseURL });
  await other.addCookies([{ name: 'cp_consent', value: 'v1.a0', url: baseURL! }]);
  const laptop = await other.newPage();
  await laptop.goto('/en/login');
  await onHostedSignin(laptop);
  await laptop.getByLabel('Mobile number or email').fill(email);
  const codeSince = now();
  await laptop.getByRole('button', { name: 'Continue' }).click();
  await expect(laptop.getByRole('heading', { name: 'Enter your code' })).toBeVisible();
  await enterCode(laptop, await mailedCode(email, codeSince));
  await laptop.waitForURL(/\/en\/home$/);
  await expect(laptop.getByRole('region', { name: 'Your garage' }).getByRole('link', { name: 'Silver · BMW 3 Series' })).toBeVisible();
  await other.close();
});

test('Persian: sign up and verify in FA (rtl), finish onboarding later', async ({ page }) => {
  test.setTimeout(90_000);
  const email = newEmail('fa');
  await page.goto('/fa/signup');
  await onHostedSignin(page);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { name: 'ساخت حساب' })).toBeVisible();
  await expectNoAxeViolations(page);
  await page.getByLabel('نام و نام خانوادگی').fill('سارا محمدی');
  await page.getByLabel('ایمیل').fill(email);
  await page.getByLabel('شرایط استفاده را می‌پذیرم').check();
  await page.getByLabel('سیاست حریم خصوصی را خوانده‌ام').check();
  const since = now();
  await page.getByRole('button', { name: 'ساخت حساب' }).click();
  await expect(page.getByRole('heading', { name: 'تأیید ایمیل' })).toBeVisible();
  await enterCode(page, await mailedCode(email, since));
  await page.waitForURL(/\/fa\/onboarding\?next=/);
  await expect(page.getByRole('heading', { name: 'بیشتر برای چه از کارپال استفاده می‌کنید؟' })).toBeVisible();
  await expect(page.getByText('مرحله ۱ از ۴')).toBeVisible();
  await expectNoAxeViolations(page);
  await page.getByRole('link', { name: 'بعداً تمام می‌کنم' }).click();
  await page.waitForURL(/\/fa\/home$/);
});

test('a gated action survives the hosted sign-in (GD-06): follow on the dev kit, sign in, come back followed', async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const user = await createUser(request);
  await gotoReady(page, '/en/dev-kit');
  await page.getByRole('button', { name: 'Follow' }).click();
  await page.getByRole('dialog', { name: 'Sign in to follow Reza Auto Suspension' }).getByRole('button', { name: 'Log in' }).click();
  await onHostedSignin(page);
  // The context line of the hosted sign-in names the action.
  await expect(page.getByText('Sign in to follow Reza Auto Suspension')).toBeVisible();
  await page.getByLabel('Mobile number or email').fill(user.email);
  await page.getByRole('button', { name: 'Use password' }).click();
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Continue' }).click();
  // A new account passes the onboarding first; "Finish later" goes on to the page, where the action replays once.
  await page.waitForURL(/\/en\/onboarding\?next=%2Fen%2Fdev-kit/);
  await page.getByRole('link', { name: 'Finish later' }).click();
  await page.waitForURL(/\/en\/dev-kit$/);
  await expect(page.getByText('You are following Reza Auto Suspension')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Following' })).toBeVisible();
  const view = (await (await page.request.get('/bff/session')).json()) as { pending_intents: unknown[] };
  expect(view.pending_intents).toEqual([]);
});

test('forgot password: the reset link sets a new password, then it signs in', async ({ page, request }) => {
  test.setTimeout(90_000);
  const user = await createUser(request);
  await page.goto('/en/login');
  await onHostedSignin(page);
  await page.getByLabel('Mobile number or email').fill(user.email);
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  const since = now();
  await page.getByRole('button', { name: 'Send link' }).click();
  await expect(page.getByText(/If this email belongs to an account, we sent it a link/)).toBeVisible();
  const token = await mailedLinkToken(user.email, 'identity.password_reset', since);

  await page.goto(`/l/pr#${token}`);
  await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
  await expect(page).toHaveURL(/\/l\/pr$/);
  await expectNoAxeViolations(page);
  await page.getByLabel('New password', { exact: true }).fill('spring service at Reza');
  await page.getByLabel('Confirm new password').fill('spring service at Reza');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByRole('heading', { name: 'Password changed' })).toBeVisible();
  await page.getByRole('link', { name: 'Log in' }).click();
  await onHostedSignin(page);
  await page.getByLabel('Mobile number or email').fill(user.email);
  await page.getByRole('button', { name: 'Use password' }).click();
  await page.getByLabel('Password', { exact: true }).fill('spring service at Reza');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForURL(/\/en\/onboarding\?next=/);
});
