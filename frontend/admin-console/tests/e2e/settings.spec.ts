// AC6.T6 E2E (acceptance: "The USD/IRR rate set in the console is what the PWA displays (via config.client)", "Kill
// switch on and off works with the four-eyes rule for off", "E2E and axe pass in EN and FA"). Against backend
// `pnpm dev` (strict mode as in AC5). config.client is read on the api host as an anonymous app would
// (tests/e2e/public-api.ts): the console itself cannot read it (BR-18).
//  - Exchange rate: a 5 % change applies at once and config.client serves it; a change over 20 % warns first; the
//    rate is put back afterwards.
//  - Kill switch: staff A turns it on (every AI flag is off in config.client), asks to turn it off (four-eyes, still
//    off), staff B approves on Pending approvals, AI flags are on again. A also files a plan and a retention change
//    (B rejects them, so the shared database keeps its values) and assigns Individual Free to itself.
//  - A flag change with a stale version (someone changed it meanwhile) shows the conflict; Reload and save works.
//  - Persian: the four screens right to left, axe on each.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { flagOf, rateOf, readClientConfig } from './public-api';
import { requireBackend, signInAs } from './staff';
import { expectNoAxeViolations, gotoReady } from './support';

const BACKEND = join(import.meta.dirname, '..', '..', '..', '..', 'backend');
const KILL = 'ai.automation.kill_switch';

test.beforeAll(async () => {
  await requireBackend();
});

/** backend `pnpm dev:flags` (dev only): the flag straight in the database, for a cleanup the four-eyes rule would block. */
function devFlag(key: string, on: boolean): string {
  const tsx = join(BACKEND, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  return execFileSync(process.execPath, [tsx, '--conditions=source', 'tools/db/dev-flags-cli.ts', 'set', key, on ? 'on' : 'off'], {
    cwd: BACKEND,
    encoding: 'utf8',
  });
}

/** As the signed-in staff member, through the BFF (what the screen sends, without the screen). */
async function bff<T>(page: Page, method: string, path: string, body?: unknown, ifMatch?: string): Promise<{ status: number; body: T }> {
  return page.evaluate(
    async ({ method, path, body, ifMatch }) => {
      const csrf = ((await (await fetch('/bff/csrf')).json()) as { csrf_token: string }).csrf_token;
      const headers: Record<string, string> = { 'x-csrf-token': csrf };
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (ifMatch) headers['if-match'] = ifMatch;
      const res = await fetch(path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const text = await res.text();
      return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
    },
    { method, path, body, ifMatch },
  );
}

async function reason(page: Page, dialogName: string | RegExp, confirm: string, code = 'planned_change', note = 'AC6 E2E') {
  const dialog = page.getByRole('dialog', { name: dialogName });
  await dialog.getByLabel('Reason').selectOption(code);
  await dialog.getByLabel(/^Note/).fill(note);
  await dialog.getByRole('button', { name: confirm, exact: true }).click();
  await expect(dialog).toBeHidden();
}

test('exchange rate: set in the console, served by config.client; over 20 % warns (AC6.T1)', async ({ context, page }) => {
  test.setTimeout(180_000);
  await signInAs(context, page, ['ADM'], { path: '/rates?currency=IRR' });
  await expect(page.getByRole('heading', { level: 1, name: 'Exchange rates' })).toBeVisible();
  const before = rateOf(await readClientConfig(), 'IRR');
  expect(before).toBeGreaterThan(0);
  const editor = page.getByTestId('rate-editor');
  await expect(editor).toBeVisible();
  const input = editor.getByLabel('New rate (IRR per US dollar)');

  // Over 20 %: the warning, before anything is sent.
  await input.fill(String(Math.round(before * 2)));
  await expect(editor.getByTestId('rate-four-eyes-warning')).toBeVisible();
  await expect(editor.getByRole('button', { name: 'Send for approval' })).toBeVisible();
  await expectNoAxeViolations(page);

  // 5 %: applied at once, and the apps' configuration serves it.
  const next = Math.round(before * 1.05);
  await input.fill(String(next));
  await expect(editor.getByTestId('rate-change')).toContainText('+5');
  await editor.getByRole('button', { name: 'Save rate' }).click();
  await expectNoAxeViolations(page);
  await reason(page, 'Change the IRR rate', 'Save rate');
  await expect(editor.getByText('Saved. The apps show the new rate within five minutes.')).toBeVisible();
  await expect.poll(async () => rateOf(await readClientConfig(), 'IRR'), { timeout: 30_000 }).toBe(next);
  await expect(page.getByTestId('rate-IRR')).toContainText(next.toLocaleString('en'));

  // Back to the rate the test found (−4.8 %: no second admin).
  await input.fill(String(before));
  await editor.getByRole('button', { name: 'Save rate' }).click();
  await reason(page, 'Change the IRR rate', 'Save rate', 'correction', 'AC6 E2E: rate restored');
  await expect(editor.getByText('Saved. The apps show the new rate within five minutes.')).toBeVisible();
  await expect.poll(async () => rateOf(await readClientConfig(), 'IRR'), { timeout: 30_000 }).toBe(before);
});

test('kill switch on at once, off only with a second admin; plan, retention and assignment (AC6.T2-T5)', async ({ browser }) => {
  test.setTimeout(300_000);
  // A run that stopped half-way may have left the kill switch on: turn it off directly and let the cache expire.
  if (flagOf(await readClientConfig(), KILL)) {
    devFlag(KILL, false);
    await expect.poll(async () => flagOf(await readClientConfig(), KILL), { timeout: 45_000 }).toBe(false);
  }
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  try {
    await Promise.all([signInAs(ctxA, pageA, ['ADM'], { path: '/flags' }), signInAs(ctxB, pageB, ['ADM'], { path: '/approvals' })]);
    expect(flagOf(await readClientConfig(), 'ai.triage.enabled')).toBe(true);

    // A: on, at once, with a reason and confirmation.
    const panel = pageA.getByTestId('kill-switch');
    await expect(panel.getByTestId('kill-state')).toHaveText('Off: AI runs');
    await expectNoAxeViolations(pageA);
    await panel.getByRole('button', { name: 'Stop all AI features' }).click();
    await expect(pageA.getByRole('dialog', { name: 'Stop all AI features' }).getByText(/takes effect at once/)).toBeVisible();
    await expectNoAxeViolations(pageA);
    await reason(pageA, 'Stop all AI features', 'Stop all AI features', 'incident_response');
    await expect(panel.getByTestId('kill-state')).toHaveText('On: AI is stopped');
    // Every AI feature is off for the apps (SEC-AI-6; AI operations then answer 503 AI_UNAVAILABLE, backend ai.int.test).
    await expect.poll(async () => flagOf(await readClientConfig(), 'ai.triage.enabled'), { timeout: 45_000 }).toBe(false);
    expect(flagOf(await readClientConfig(), KILL)).toBe(true);

    // A: off needs a second admin; it waits and AI stays off.
    await panel.getByRole('button', { name: 'Turn AI back on' }).click();
    await reason(pageA, 'Turn this flag off', 'Send for approval');
    const banner = panel.locator('[data-kit="four-eyes-banner"]');
    await expect(banner).toContainText('Waiting for a second staff member');
    const changeId = (await banner.getAttribute('data-change'))!;
    expect(flagOf(await readClientConfig(), 'ai.triage.enabled')).toBe(false);

    // B: approves on Pending approvals.
    await gotoReady(pageB, `/approvals?change=${changeId}`);
    await expect(pageB.getByTestId('approval-detail')).toContainText('Turn ai.automation.kill_switch off');
    await pageB.getByRole('button', { name: 'Approve', exact: true }).click();
    await reason(pageB, 'Approve this change', 'Approve', 'checked_and_correct');
    await expect(pageB.getByText('Approved. The change is applied.')).toBeVisible();
    await expect.poll(async () => flagOf(await readClientConfig(), 'ai.triage.enabled'), { timeout: 45_000 }).toBe(true);
    await gotoReady(pageA, '/flags');
    await expect(pageA.getByTestId('kill-state')).toHaveText('Off: AI runs');

    // A: a plan change and a retention change wait for a second admin (B rejects both: the data stays as it was).
    await gotoReady(pageA, '/plans');
    await expect(pageA.getByTestId('ranking-rule')).toContainText('Plans never change organic ranking');
    await pageA.getByRole('table', { name: 'Plans' }).getByRole('button', { name: 'Fleet 20' }).click();
    const plan = pageA.getByTestId('plan-editor');
    const vehicles = plan.getByLabel('Vehicles', { exact: true });
    await vehicles.fill(String(Number(await vehicles.inputValue()) + 1));
    await expectNoAxeViolations(pageA);
    await plan.getByRole('button', { name: 'Send for approval' }).click();
    await reason(pageA, 'Change Fleet 20', 'Send for approval');
    const planChange = plan.locator('[data-kit="four-eyes-banner"]');
    await expect(planChange).toContainText('Plan change was filed');
    const planChangeId = (await planChange.getAttribute('data-change'))!;

    await gotoReady(pageA, '/retention');
    await expect(pageA.getByTestId('retention-gaps')).toBeVisible();
    const rows = pageA.getByRole('table', { name: 'Retention policies' }).locator('button[data-row-button]');
    await expect(rows.first()).toBeVisible();
    // Another run may have left a policy waiting (409 DUPLICATE): try the policies until one is filed.
    let retentionChangeId: string | null = null;
    for (let i = 0; i < (await rows.count()) && !retentionChangeId; i++) {
      await rows.nth(i).click();
      const editor = pageA.getByTestId('policy-editor');
      const days = editor.getByLabel('Kept for');
      await days.fill(String(Number(await days.inputValue()) + 1));
      await editor.getByRole('button', { name: 'Send for approval' }).click();
      await reason(pageA, /^Change retention of/, 'Send for approval');
      const outcome = editor.locator('[data-kit="four-eyes-banner"], [data-outcome="failed"]').first();
      await expect(outcome).toBeVisible();
      retentionChangeId = await editor
        .locator('[data-kit="four-eyes-banner"]')
        .getAttribute('data-change', { timeout: 1_000 })
        .catch(() => null);
    }
    expect(retentionChangeId).toBeTruthy();
    await expectNoAxeViolations(pageA);
    for (const id of [planChangeId, retentionChangeId!]) {
      const r = await bff<{ status: string }>(pageB, 'POST', `/api/v1/admin/four-eyes/${id}/decision`, {
        decision: 'reject',
        reason: 'not_justified: AC6 E2E cleanup',
      });
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('rejected');
    }

    // A: Individual Free, active, assigned to A's own account (a harmless manual assignment).
    const me = (await (await pageA.request.get('/bff/session')).json()) as { staff: { id: string } };
    await gotoReady(pageA, `/plans?subscriber=user:${me.staff.id}`);
    const form = pageA.getByTestId('assign-form');
    await expect(form.getByLabel('User ID')).toHaveValue(me.staff.id);
    await form.getByLabel('Plan').selectOption('individual_free');
    await form.getByRole('button', { name: 'Assign plan' }).click();
    await reason(pageA, 'Assign this plan', 'Assign plan', 'pilot_operation');
    await expect(form.getByText("Assigned. The subscriber's limits change at once.")).toBeVisible();
    await expect(form.getByTestId('assign-result')).toContainText('Individual Free — Active');
    await expectNoAxeViolations(pageA);
  } finally {
    if (flagOf(await readClientConfig(), KILL)) devFlag(KILL, false);
    await ctxA.close();
    await ctxB.close();
  }
});

test('a flag changed meanwhile: the save is refused and explained; Reload, then save (AC6.T2/T6)', async ({ context, page }) => {
  test.setTimeout(180_000);
  const key = 'skill_heatmap.visible';
  await signInAs(context, page, ['ADM'], { path: `/flags?flag=${key}` });
  const detail = page.getByTestId('flag-detail');
  await expect(detail).toBeVisible();
  type Flags = { items: { key: string; version: number; targeting: unknown }[] };
  const read = async () => (await bff<Flags>(page, 'GET', '/api/v1/admin/flags?limit=100')).body.items.find((f) => f.key === key)!;
  const original = await read();

  // Someone else saves the flag (same targeting) after this page read it: its version moves on.
  const other = await bff(
    page,
    'PATCH',
    `/api/v1/admin/flags/${key}`,
    { targeting: original.targeting, reason: 'correction: AC6 E2E' },
    `"v${original.version}"`,
  );
  expect(other.status).toBe(200);

  try {
    // 100 % of users matches everyone, so the flag behaves the same.
    await detail.getByLabel('Share of users (%)').fill('100');
    await detail.getByRole('button', { name: 'Save targeting' }).click();
    await reason(page, 'Change the targeting', 'Save');
    await expect(page.getByText('Someone changed this record meanwhile. Reload it and try again.')).toBeVisible();
    await expectNoAxeViolations(page);
    await page.getByRole('button', { name: 'Reload' }).click();
    await expect(detail.getByLabel('Share of users (%)')).toHaveValue('100');
    await detail.getByRole('button', { name: 'Save targeting' }).click();
    await reason(page, 'Change the targeting', 'Save');
    await expect(page.getByText('Saved. Apps follow within one configuration refresh.')).toBeVisible();
    await expect(detail.getByTestId('flag-targeting')).toHaveText('100 % of users');
  } finally {
    const now = await read();
    await bff(
      page,
      'PATCH',
      `/api/v1/admin/flags/${key}`,
      { targeting: original.targeting, reason: 'correction: AC6 E2E cleanup' },
      `"v${now.version}"`,
    );
  }
});

test('Persian: exchange rates, flags, plans and retention right to left (axe)', async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ locale: 'fa-IR' });
  const page = await context.newPage();
  await signInAs(context, page, ['ADM'], { locale: 'fa', path: '/rates?currency=IRR' });
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  for (const [path, heading, ready] of [
    ['/rates?currency=IRR', 'نرخ ارز', 'rate-editor'],
    ['/flags?flag=featured.enabled', 'پرچم‌های قابلیت', 'flag-detail'],
    ['/plans', 'طرح‌ها و امکانات', 'assign-form'],
    ['/retention', 'نگهداری داده‌ها', 'retention-gaps'],
  ] as const) {
    await gotoReady(page, path);
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    await expect(page.getByTestId(ready)).toBeVisible();
    await expectNoAxeViolations(page);
  }
  await context.close();
});
