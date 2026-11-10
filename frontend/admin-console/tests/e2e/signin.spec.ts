// AC4.T8: staff sign-in and the console shell against the live backend (strict mode for the acceptance run). Each test
// makes its own staff account (backend dev tool) and its own virtual security key, so tests run in parallel.
import { expect, test } from '@playwright/test';
import { expectNoAxeViolations } from './support';
import { addSecurityKey, createStaff, navSections, requireBackend, signInAs, signInOnPage } from './staff';

test.beforeAll(requireBackend);
// A sign-in creates an account (backend tool), checks a password (Argon2id) and, in strict mode, solves a proof of work
// in the browser: allow for several browsers doing that at once.
test.describe.configure({ timeout: 120_000 });

test('first sign-in: password, emailed code, security key enrolment, the key; the shell at aal3 (ADM)', async ({ context, page }) => {
  const email = createStaff(['ADM'], { name: 'Ada Admin' });
  await addSecurityKey(context, page);
  await page.goto('/flags');
  await page.waitForURL(/\/id\/signin\?/);
  await expect(page.getByRole('heading', { level: 1, name: 'Staff sign-in' })).toBeVisible();
  await expect(page.getByTestId('env-badge')).toContainText('DEV');
  await expectNoAxeViolations(page);

  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill('wrong-password-for-sure');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  // (Next.js's route announcer is an empty role=alert too: match the text.)
  await expect(page.getByRole('alert').filter({ hasText: 'The email or password is not correct.' })).toBeVisible({ timeout: 60_000 });

  await signInOnPage(page, email, { enrol: true });
  // Back on the page that was asked for, in the shell.
  await expect(page).toHaveURL(/\/flags$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Feature flags' })).toBeVisible();
  const session = await (await page.request.get('/bff/session')).json();
  expect(session).toMatchObject({ signed_in: true, staff: { roles: ['ADM'], acr: 'aal3', display_name: 'Ada Admin' } });
  expect(await navSections(page)).toEqual(expect.arrayContaining(['Feature flags', 'Exchange rates', 'Audit log', 'Staff']));
  // The browser holds the session cookie and the language cookie only (no token, GD-12).
  const cookies = (await context.cookies()).map((c) => c.name).sort();
  expect(cookies).toEqual(['__Host-cpa_sid', 'cpa_locale']);
  await expectNoAxeViolations(page);
});

test('a moderator sees no ADM-only section, and an ADM URL answers the no-permission page', async ({ context, page }) => {
  await signInAs(context, page, ['MOD']);
  await expect(page.getByRole('heading', { level: 1, name: 'My work' })).toBeVisible();
  const sections = await navSections(page);
  expect(sections).toEqual(expect.arrayContaining(['Pending approvals', 'Reviews', 'Content', 'Disputes & appeals']));
  for (const adm of ['Feature flags', 'Exchange rates', 'Plans & entitlements', 'Data retention', 'Audit log', 'MCP clients', 'Staff'])
    expect(sections).not.toContain(adm);

  // In the shell, server-rendered (status 200, D-26: forbidden() would leave a blank page under Trusted Types).
  await page.goto('/flags');
  await expect(page.getByRole('heading', { level: 1, name: "You don't have access to this page" })).toBeVisible();
  await expect(page).toHaveTitle(/^No access/);
  await expect(page.getByTestId('forbidden-roles')).toHaveText('This page needs one of these staff roles: Platform admin.');
  // Still inside the shell.
  await expect(page.getByRole('navigation', { name: 'Console sections' })).toBeVisible();
  await expectNoAxeViolations(page);

  const allowed = await page.goto('/reviews');
  expect(allowed?.status()).toBe(200);
  await expect(page.getByTestId('section-placeholder')).toContainText('It arrives in stage AC7');
  await page.goto('/no-such-section');
  await expect(page.getByRole('heading', { level: 1, name: "This page doesn't exist" })).toBeVisible();
});

for (const [role, expected] of [
  ['SUP', ['Dashboard', 'Content', 'Privacy requests', 'Users', 'Organizations', 'Analytics']],
  ['CRV', ['Dashboard', 'Reviews', 'Disputes & appeals']],
] as const) {
  test(`${role} sees exactly its sections`, async ({ context, page }) => {
    await signInAs(context, page, [role]);
    expect(await navSections(page)).toEqual([...expected]);
    await page.goto('/approvals');
    await expect(page.getByTestId('no-permission')).toBeVisible();
  });
}

test('the next sign-in goes straight to the key; sign-out ends the session', async ({ context, page }) => {
  const email = await signInAs(context, page, ['ADM']);
  await page.getByRole('button', { name: /E2E ADM/ }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL(/\/id\/signed-out\?reason=logout/);
  await expect(page.getByRole('heading', { level: 1, name: 'You are signed out' })).toBeVisible();
  expect((await (await page.request.get('/bff/session')).json()).signed_in).toBe(false);
  await expectNoAxeViolations(page);

  await page.getByRole('link', { name: 'Sign in again' }).click();
  await signInOnPage(page, email, { enrol: false });
  await expect(page.getByRole('heading', { level: 1, name: 'My work' })).toBeVisible();
});

test('idle warning at 25 minutes, "Stay signed in", and sign-out at 30 (clock mocked)', async ({ context, page }) => {
  await page.clock.install();
  await signInAs(context, page, ['SUP'], { path: '/users' });
  await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible();

  await page.clock.fastForward('25:00');
  const warning = page.getByRole('alertdialog', { name: 'Still there?' });
  await expect(warning).toBeVisible();
  await expect(warning).toContainText(/signed out in [45]:\d\d/);
  await expectNoAxeViolations(page);
  await warning.getByRole('button', { name: 'Stay signed in' }).click();
  await expect(warning).toBeHidden();

  await page.clock.fastForward('20:00');
  await expect(warning).toBeHidden();
  await page.clock.fastForward('10:01');
  await page.waitForURL(/\/id\/signed-out\?reason=idle&return_to=%2Fusers/);
  await expect(page.getByRole('heading', { level: 1, name: 'You were signed out' })).toBeVisible();
  expect((await (await page.request.get('/bff/session')).json()).signed_in).toBe(false);
  await expect(page.getByRole('link', { name: 'Sign in again' })).toHaveAttribute('href', '/bff/login?return_to=%2Fusers');
});

test('Persian: sign-in and shell right to left, in the staff member’s language', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'fa-IR' });
  const page = await context.newPage();
  await signInAs(context, page, ['CRV'], { locale: 'fa' });
  const html = page.locator('html');
  await expect(html).toHaveAttribute('lang', 'fa');
  await expect(html).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { level: 1, name: 'کارهای من' })).toBeVisible();
  expect(await navSections(page, 'بخش‌های کنسول')).toEqual(['داشبورد', 'نظرها', 'اختلاف‌ها و اعتراض‌ها']);
  await expectNoAxeViolations(page);
  await context.close();
});

test('keyboard: ? lists the shortcuts, / goes to the lookup box', async ({ context, page }) => {
  await signInAs(context, page, ['MOD']);
  await page.keyboard.press('Shift+Slash');
  const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(help).toBeVisible();
  await expect(help.getByRole('row')).toHaveCount(9);
  await expectNoAxeViolations(page);
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();
  await page.keyboard.press('/');
  await expect(page.getByRole('searchbox', { name: 'Look up' })).toBeFocused();
});

test('step-up: /bff/reauth asks for the security key first and returns with a fresh sign-in (GD-11)', async ({ context, page }) => {
  await signInAs(context, page, ['ADM'], { path: '/rates' });
  const before = (await (await page.request.get('/bff/session')).json()) as { staff: { auth_time: string; id: string } };
  // auth_time has whole seconds: let one pass.
  await page.waitForTimeout(1_100);
  await page.goto('/bff/reauth?return_to=%2Frates');
  await page.waitForURL(/\/id\/signin\?/);
  await expect(page.getByRole('heading', { level: 1, name: "Confirm it's you" })).toBeVisible();
  await expectNoAxeViolations(page);
  // The key alone (WebAuthn purpose signin, a discoverable credential): no password needed for a step-up.
  await page.getByRole('button', { name: 'Sign in with a security key' }).click();
  await page.waitForURL(/\/rates$/, { timeout: 60_000 });
  const after = (await (await page.request.get('/bff/session')).json()) as { staff: { auth_time: string; id: string; acr: string } };
  expect(after.staff.id).toBe(before.staff.id);
  expect(after.staff.acr).toBe('aal3');
  expect(Date.parse(after.staff.auth_time)).toBeGreaterThan(Date.parse(before.staff.auth_time));
});
