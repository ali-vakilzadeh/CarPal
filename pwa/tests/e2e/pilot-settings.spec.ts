// Backend S11 / NI-P14-09 in the built PWA against the live backend: contract 1.2.0 for the account (country, quiet hours,
// the AI switches, Deactivate and reactivation at sign-in) and prices at the admin rate. EN and FA where the text matters.
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { backendUp, createUser } from './accounts';
import { hostedSignIn, signIn } from './flows';
import { decideCookies, gotoReady } from './support';

test.beforeEach(async ({ request, context, baseURL }) => {
  test.skip(!(await backendUp(request)), 'backend is not running');
  await decideCookies(context, baseURL!);
});

test('settings: country, quiet hours and the AI switches are saved on the account', async ({ page, request }) => {
  test.setTimeout(120_000);
  const user = await createUser(request);
  await signIn(page, 'en', user);

  await gotoReady(page, '/en/settings/profile');
  await page.getByLabel('Country you live in').selectOption('IR');
  await expect(page.locator('.pwa-toast-text')).toBeVisible();

  await gotoReady(page, '/en/settings/notifications');
  await expect(page.getByRole('columnheader', { name: 'SMS' })).toBeVisible();
  await page.getByRole('switch', { name: 'Use quiet hours' }).click();
  await expect(page.getByRole('switch', { name: 'Use quiet hours' })).toBeChecked();
  await page.reload();
  await expect(page.getByRole('switch', { name: 'Use quiet hours' })).toBeChecked();

  await gotoReady(page, '/en/settings/ai');
  await expect(page.getByRole('switch', { name: 'Personalised Help Me' })).toBeDisabled();
  const why = page.getByRole('switch', { name: "Show why I'm seeing a recommendation" });
  await expect(why).toBeChecked();
  await why.click();
  await expect(why).not.toBeChecked();
  await page.reload();
  await expect(page.getByRole('switch', { name: "Show why I'm seeing a recommendation" })).not.toBeChecked();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('prices show the admin rate for everybody, and no per-browser rate is left', async ({ page }) => {
  await gotoReady(page, '/fa');
  const cookies = await page.context().cookies();
  expect(cookies.some((c) => c.name === 'cp_price')).toBe(false);
});

for (const [locale, title, action] of [
  ['en', 'Your account is deactivated', 'Reactivate my account'],
  ['fa', 'حساب شما غیرفعال است', 'فعال‌سازی دوبارهٔ حساب'],
] as const) {
  test(`deactivate, then the next sign-in offers reactivation (${locale})`, async ({ page, request }) => {
    test.setTimeout(180_000);
    const user = await createUser(request, { locale });
    await signIn(page, locale, user);
    await gotoReady(page, `/${locale}/settings/data`);
    const open = locale === 'en' ? 'Deactivate my account' : 'غیرفعال کردن حساب من';
    await page.getByRole('button', { name: open }).click();
    await page.getByRole('dialog').getByRole('button', { name: open }).click();
    // A fresh sign-in meets AAL2 for an account without a second factor, so the action runs at once.
    await page.waitForURL(new RegExp(`/${locale}/?$`), { timeout: 30_000 });

    await page.goto(`/${locale}/login`);
    await hostedSignIn(page, locale, user, { onboarding: false });
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.getByRole('button', { name: action }).click();
    await expect(page.getByTestId('reactivate-step')).toHaveCount(0, { timeout: 30_000 });
    await expect(page).not.toHaveURL(/\/id\/signin/);
  });
}
