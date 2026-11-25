// AC15.T1: one journey per staff role (MOD, CRV, SUP, ADM) in English and in Persian, against the live backend (strict
// for the acceptance run). Each journey signs in a fresh staff member in that language, checks the page direction and
// the exact sections of the role in the navigation, walks every one of those sections through the navigation (the
// page opens with its heading, the link is marked current, nothing fails to load, no permission or not-found state),
// opens a section the role may not open (the console explains why), does one piece of the role's own work, and signs
// out from the account menu:
//   SUP  a ticket filed by an app user is read for its purpose and taken (assigned to oneself);
//   CRV  a Path 2 review the business confirmed is confirmed with a reason from the approval queue;
//   MOD  the content queues (reports, cases) and the review queue read without the reviewer's decision buttons;
//   ADM  Pending approvals, then "My actions in the audit log" from the account menu.
// The deep flows of each screen live in the section suites; this file proves the roles' paths through the whole app.
// Needs backend `pnpm int:env backend` (strict) and the console's settings (README "End-to-end tests").
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { appUser, businessAnswers, fileTicket, path2Review, publishedShop } from './app-user';
import { requireBackend, signInAs } from './staff';
import { gotoReady } from './support';

type Locale = 'en' | 'fa';
type Dict = Record<string, unknown>;
const dict = (l: Locale) =>
  (JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'src', 'lib', 'i18n', 'locales', `${l}.json`), 'utf8')) as Dict)
    .admin as Dict;
const DICT = { en: dict('en'), fa: dict('fa') };
/** A console string by its key under `admin.`, with {{placeholders}} filled. */
const say = (l: Locale, key: string, vars: Record<string, string> = {}) =>
  (key.split('.').reduce<unknown>((o, k) => (o as Dict)[k], DICT[l]) as string).replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? '');

test.beforeAll(requireBackend);
test.describe.configure({ timeout: 420_000 });

type Role = 'MOD' | 'CRV' | 'SUP' | 'ADM';

/** The sections each role sees, in navigation order (src/features/shell/sections.ts over the generated role table). */
const SECTIONS: Record<Role, readonly string[]> = {
  MOD: [
    'dashboard',
    'approvals',
    'verification',
    'reviews',
    'content',
    'inventory',
    'disputes',
    'users',
    'orgs',
    'taxonomy',
    'ai',
    'analytics',
  ],
  CRV: ['dashboard', 'reviews', 'disputes'],
  SUP: ['dashboard', 'content', 'privacy', 'support', 'users', 'orgs', 'analytics'],
  ADM: [
    'dashboard',
    'approvals',
    'recoveries',
    'verification',
    'reviews',
    'content',
    'inventory',
    'privacy',
    'support',
    'users',
    'orgs',
    'taxonomy',
    'ai',
    'mcp',
    'analytics',
    'audit',
    'plans',
    'flags',
    'rates',
    'retention',
    'policies',
    'notifications',
    'staff',
  ],
};

/** A section the role may not open. */
const HIDDEN: Record<Role, string> = { MOD: '/staff', CRV: '/users', SUP: '/approvals', ADM: '/disputes' };

const pathOf = (id: string) => (id === 'dashboard' ? '/' : `/${id}`);

/** The page has finished its first reads: no table or panel still loading, none failed. */
async function expectSettled(page: Page, where: string) {
  await expect(page.locator('[data-state="loading"]'), `${where}: still loading`).toHaveCount(0, { timeout: 45_000 });
  await expect(page.locator('[data-state="error"]'), `${where}: a read failed`).toHaveCount(0);
  await expect(page.getByTestId('no-permission'), where).toHaveCount(0);
  await expect(page.getByTestId('not-found'), where).toHaveCount(0);
}

/** Through the navigation: every section of the role opens with its heading and is marked as the current one. */
async function walkSections(page: Page, l: Locale, role: Role) {
  const nav = page.getByRole('navigation', { name: say(l, 'shell.nav.label') });
  expect(await nav.getByRole('link').allTextContents()).toEqual(SECTIONS[role].map((id) => say(l, `shell.nav.${id}`)));
  for (const id of SECTIONS[role]) {
    await test.step(`${role} ${l}: ${id}`, async () => {
      const link = nav.locator(`a[data-section="${id}"]`);
      await link.click();
      await page.waitForURL((u) => u.pathname === pathOf(id));
      await expect(link).toHaveAttribute('aria-current', 'page');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expectSettled(page, id);
    });
  }
}

async function signOut(page: Page, l: Locale) {
  await page.getByRole('button', { name: new RegExp(say(l, 'shell.account.menu')) }).click();
  await page.getByRole('button', { name: say(l, 'shell.account.signOut') }).click();
  await page.waitForURL(/\/id\/signed-out\?reason=logout/);
  await expect(page.getByRole('heading', { level: 1, name: say(l, 'signedOut.logoutTitle') })).toBeVisible();
  expect((await (await page.request.get('/bff/session')).json()).signed_in).toBe(false);
}

async function confirmWith(page: Page, l: Locale, title: string, confirm: string, code: string) {
  const dialog = page.getByRole('dialog', { name: title });
  await dialog.getByLabel(say(l, 'kit.reason.code')).selectOption(code);
  await dialog.getByRole('button', { name: confirm, exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
}

for (const l of ['en', 'fa'] as const) {
  const dir = l === 'fa' ? 'rtl' : 'ltr';

  test(`support agent journey (${l}, ${dir}): sections, a ticket taken, sign-out`, async ({ browser }) => {
    const user = await appUser(`e2e-jsup-${l}`, l === 'fa' ? 'Sara Nemooneh' : 'Sara Example');
    const subject = `E2E journey ${l} ${Date.now()}`;
    const id = await fileTicket(user, { topic: 'other', subject, body: 'Where do I change my phone number?' });
    const ctx = await browser.newContext(l === 'fa' ? { locale: 'fa-IR' } : {});
    const page = await ctx.newPage();
    await signInAs(ctx, page, ['SUP'], { locale: l });
    await expect(page.locator('html')).toHaveAttribute('dir', dir);
    await expect(page.locator('html')).toHaveAttribute('lang', l);
    await walkSections(page, l, 'SUP');
    await gotoReady(page, HIDDEN.SUP);
    await expect(page.getByTestId('no-permission')).toBeVisible();

    await gotoReady(page, `/support?ticket=${id}`);
    const ticket = page.getByTestId('support-ticket');
    await expect(ticket).toHaveAttribute('data-status', 'new', { timeout: 30_000 });
    await expect(ticket.getByText('Where do I change my phone number?')).toBeVisible();
    await page.getByRole('button', { name: say(l, 'support.assign.me') }).click();
    await confirmWith(page, l, say(l, 'support.dialog.assign', { subject }), say(l, 'support.assign.confirm'), 'taking_over');
    await expect(page.getByText(say(l, 'support.assign.done'))).toBeVisible({ timeout: 30_000 });

    await signOut(page, l);
    await ctx.close();
  });

  test(`community reviewer journey (${l}, ${dir}): sections, a Path 2 review confirmed, sign-out`, async ({ browser }) => {
    const shop = await publishedShop(`j${l}`);
    const review = await path2Review(shop, `j${l}a`, { rating: 4 });
    await businessAnswers(shop, review.id, 'confirmed');
    const ctx = await browser.newContext(l === 'fa' ? { locale: 'fa-IR' } : {});
    const page = await ctx.newPage();
    await signInAs(ctx, page, ['CRV'], { locale: l });
    await expect(page.locator('html')).toHaveAttribute('dir', dir);
    await walkSections(page, l, 'CRV');
    await gotoReady(page, HIDDEN.CRV);
    await expect(page.getByTestId('no-permission')).toBeVisible();

    await gotoReady(page, `/reviews?review=${review.id}&purpose=approval:${review.id}`);
    await expect(page.getByTestId('approval-item')).toHaveAttribute('data-review', review.id, { timeout: 30_000 });
    await page.getByRole('button', { name: say(l, 'reviews.confirm'), exact: true }).click();
    await confirmWith(page, l, say(l, 'reviews.dialog.confirm.title'), say(l, 'reviews.dialog.confirm.button'), 'customer_confirmed');
    await expect(page.getByTestId('decision-done')).toBeVisible({ timeout: 30_000 });

    await signOut(page, l);
    await ctx.close();
  });

  test(`moderator journey (${l}, ${dir}): sections, the content and review queues, sign-out`, async ({ browser }) => {
    const ctx = await browser.newContext(l === 'fa' ? { locale: 'fa-IR' } : {});
    const page = await ctx.newPage();
    await signInAs(ctx, page, ['MOD'], { locale: l });
    await expect(page.locator('html')).toHaveAttribute('dir', dir);
    await walkSections(page, l, 'MOD');
    await gotoReady(page, HIDDEN.MOD);
    await expect(page.getByTestId('no-permission')).toBeVisible();

    // The content queues: reports and cases are tables that load (the deep flow is moderation.spec.ts).
    await gotoReady(page, '/content');
    await expect(page.locator('[data-kit="data-table"]').first()).toBeVisible();
    await expectSettled(page, 'content');
    // The review queue reads for a moderator, but deciding approvals is the reviewer's (AC7).
    await gotoReady(page, '/reviews');
    await expectSettled(page, 'reviews');
    await expect(page.getByRole('button', { name: say(l, 'reviews.confirm'), exact: true })).toHaveCount(0);

    await signOut(page, l);
    await ctx.close();
  });

  test(`administrator journey (${l}, ${dir}): sections, approvals, my actions in the audit log, sign-out`, async ({ browser }) => {
    const ctx = await browser.newContext(l === 'fa' ? { locale: 'fa-IR' } : {});
    const page = await ctx.newPage();
    await signInAs(ctx, page, ['ADM'], { locale: l });
    await expect(page.locator('html')).toHaveAttribute('dir', dir);
    await walkSections(page, l, 'ADM');
    await gotoReady(page, HIDDEN.ADM);
    await expect(page.getByTestId('no-permission')).toBeVisible();

    await gotoReady(page, '/approvals');
    await expect(page.getByRole('heading', { level: 1, name: say(l, 'shell.nav.approvals') })).toBeVisible();
    await expectSettled(page, 'approvals');
    await page.getByRole('button', { name: new RegExp(say(l, 'shell.account.menu')) }).click();
    await page.getByRole('link', { name: say(l, 'shell.account.myActions') }).click();
    await page.waitForURL((u) => u.pathname === '/audit');
    await expectSettled(page, 'audit (my actions)');

    await signOut(page, l);
    await ctx.close();
  });
}
