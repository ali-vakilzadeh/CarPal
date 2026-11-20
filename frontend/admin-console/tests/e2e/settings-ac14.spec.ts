// AC14.T6 E2E for AC14-1 (staff directory, policies and consent texts, notification templates, rules and delivery
// health, the notice bell) against the live backend (strict for the acceptance run). The shared database keeps its
// state: only a throwaway e2e- staff account is changed (pruned by `pnpm dev:staff prune`); every four-eyes request
// (role grant, enable, policy publish) is rejected by a second administrator, so no policy version goes live and no
// re-consent reaches the PWA; one e2e- draft per document is reused across runs; a template override is reset and the
// rules are saved back to what they were.
//   EN  admin A: the directory (filters, oneself cannot be disabled); a throwaway moderator gets a role grant that
//       admin B rejects, and A's bell shows the outcome; A disables the moderator at once and asks to enable them
//       again, which B rejects. Policies: the version in force read-only; an e2e- draft of a consent text created (or
//       edited) and sent for publication with re-consent (keep preselected); B rejects it. Axe on each view.
//   FA  an administrator: an editable built-in email template saved with a staff text, previewed, then reset; the
//       rules changed and saved back (If-Match both times); delivery health. Axe on each view.
// Needs backend `pnpm int:env backend` (strict) and the console's settings (README "End-to-end tests").
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { createStaff, requireBackend, signInAs } from './staff';
import { expectNoAxeViolations, gotoReady } from './support';

type Dict = Record<string, unknown>;
const dict = (l: 'en' | 'fa') =>
  (JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'src', 'lib', 'i18n', 'locales', `${l}.json`), 'utf8')) as Dict)
    .admin as Dict;
const DICT = { en: dict('en'), fa: dict('fa') };
const say = (l: 'en' | 'fa', key: string, vars: Record<string, string> = {}) =>
  (key.split('.').reduce<unknown>((o, k) => (o as Dict)[k], DICT[l]) as string).replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? '');

test.beforeAll(requireBackend);
test.describe.configure({ timeout: 300_000 });

async function confirmWith(page: Page, l: 'en' | 'fa', title: string | RegExp, confirm: string, code: string, note?: string) {
  const dialog = page.getByRole('dialog', { name: title });
  await dialog.getByLabel(say(l, 'kit.reason.code')).selectOption(code);
  if (note) await dialog.getByLabel(/^Note|^توضیح/).fill(note);
  await dialog.getByRole('button', { name: confirm, exact: true }).click();
  await expect(dialog).toBeHidden();
}

/** The four-eyes banner's change id under `scope`. */
async function pendingChange(scope: ReturnType<Page['getByTestId']>): Promise<string> {
  const banner = scope.locator('[data-kit="four-eyes-banner"]');
  await expect(banner).toBeVisible({ timeout: 30_000 });
  const id = await banner.getAttribute('data-change');
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  return id!;
}

/** Admin B rejects a change on Pending approvals. */
async function reject(page: Page, changeId: string, what: string) {
  await gotoReady(page, `/approvals?change=${changeId}`);
  await expect(page.getByTestId('approval-detail')).toContainText(what);
  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  await confirmWith(page, 'en', 'Reject this change', 'Reject', 'not_justified', 'AC14 E2E, rejected by design');
  await expect(page.getByText('Rejected. The change will not be applied.')).toBeVisible({ timeout: 30_000 });
}

/** A staff member's id by display name (admin.staff_list pages, as the directory's own lookup does). */
async function staffId(page: Page, name: string): Promise<string> {
  let cursor = '';
  for (let i = 0; i < 50; i++) {
    const res = await page.request.get(`/api/v1/admin/staff?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as { items: { user_id: string; display_name: string }[]; next_cursor: string | null };
    const hit = body.items.find((m) => m.display_name === name);
    if (hit) return hit.user_id;
    if (!body.next_cursor) break;
    cursor = body.next_cursor;
  }
  throw new Error(`staff member ${name} not found`);
}

test('staff directory: a role grant and an enable rejected by a second admin, a disable at once, the bell (EN)', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  await Promise.all([signInAs(ctxA, pageA, ['ADM'], { path: '/staff' }), signInAs(ctxB, pageB, ['ADM'], { path: '/approvals' })]);
  const name = `E2E Throwaway ${Date.now()}`;
  createStaff(['MOD'], { name });

  await expect(pageA.getByRole('heading', { level: 1, name: 'Staff & permissions' })).toBeVisible();
  await expect(pageA.getByTestId('staff-gaps')).toBeVisible();
  // Filters go to the server; oneself cannot be disabled.
  await pageA.getByLabel('Role', { exact: true }).selectOption('platform_admin');
  await expect(pageA).toHaveURL(/[?&]role=platform_admin/);
  const session = (await (await pageA.request.get('/bff/session')).json()) as { staff: { id: string } };
  await gotoReady(pageA, `/staff?member=${session.staff.id}`);
  await expect(pageA.getByTestId('staff-self')).toBeVisible({ timeout: 30_000 });
  await expectNoAxeViolations(pageA);

  // The throwaway moderator: a Support role grant waits for B, who rejects it.
  const id = await staffId(pageA, name);
  await gotoReady(pageA, `/staff?member=${id}`);
  const panel = pageA.getByTestId('staff-member');
  await expect(panel).toHaveAttribute('data-status', 'active', { timeout: 30_000 });
  await expectNoAxeViolations(pageA);
  await panel.getByLabel('Role to give').selectOption('platform_support');
  await panel.getByRole('button', { name: 'Request the role' }).click();
  await confirmWith(pageA, 'en', 'Give the role Support', 'Request the role', 'role_change', 'AC14 E2E');
  const grant = await pendingChange(panel);
  await reject(pageB, grant, 'Staff role grant');

  // A's bell: the outcome of the request (staff.four_eyes_outcome, written by the notification worker).
  await expect
    .poll(
      async () => {
        await gotoReady(pageA, `/staff?member=${id}`);
        await pageA.getByTestId('notice-bell').click();
        const panel = pageA.getByTestId('notice-panel');
        await expect(panel.getByRole('status')).toHaveCount(0, { timeout: 30_000 });
        return panel.innerText();
      },
      { timeout: 90_000, intervals: [3_000] },
    )
    .toContain('Your change "Staff role grant" was rejected.');
  await expectNoAxeViolations(pageA);
  await pageA.keyboard.press('Escape');

  // Disable at once, then ask to enable again: B rejects; the member stays disabled.
  await gotoReady(pageA, `/staff?member=${id}`);
  await pageA.getByTestId('staff-member-access').getByRole('button', { name: 'Disable' }).click();
  await confirmWith(pageA, 'en', `Disable ${name}`, 'Disable', 'staff_left', 'AC14 E2E throwaway');
  await expect(pageA.getByText(`${name} is disabled.`)).toBeVisible({ timeout: 30_000 });
  await expect(pageA.getByTestId('staff-member')).toHaveAttribute('data-status', 'disabled', { timeout: 30_000 });
  await pageA.getByRole('button', { name: 'Request enable' }).click();
  await confirmWith(pageA, 'en', `Enable ${name} again`, 'Request enable', 'mistake', 'AC14 E2E, rejected by design');
  const enable = await pendingChange(pageA.getByTestId('staff-member'));
  await reject(pageB, enable, 'Staff account re-enabled');
  await gotoReady(pageA, `/staff?member=${id}`);
  await expect(pageA.getByTestId('staff-member')).toHaveAttribute('data-status', 'disabled', { timeout: 30_000 });
  await ctxA.close();
  await ctxB.close();
});

test('policies: the version in force read-only; an e2e- draft of a consent text sent for publication and rejected (EN)', async ({
  browser,
}) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  await Promise.all([signInAs(ctxA, pageA, ['ADM'], { path: '/policies' }), signInAs(ctxB, pageB, ['ADM'], { path: '/approvals' })]);
  await expect(pageA.getByRole('heading', { level: 1, name: 'Policies & consent texts' })).toBeVisible();
  const list = (await (await pageA.request.get('/api/v1/admin/policies')).json()) as {
    items: { policy_key: string; reconsent_mode: string; versions: { id: string; status: string; policy_version: string }[] }[];
  };
  expect(list.items.length).toBeGreaterThanOrEqual(16);
  await expectNoAxeViolations(pageA);

  // A version in force is read-only (when the dev database has one).
  const inForce = list.items.flatMap((d) => d.versions.map((v) => ({ d, v }))).find((x) => x.v.status === 'published');
  if (inForce) {
    await gotoReady(pageA, `/policies?policy=${inForce.d.policy_key}&version=${inForce.v.id}`);
    await expect(pageA.getByTestId('policy-readonly')).toBeVisible({ timeout: 30_000 });
    await expect(pageA.getByTestId('policy-form')).toHaveCount(0);
    await expectNoAxeViolations(pageA);
  }

  // The e2e- draft of the marketing consent text: created on the first run, edited on later ones.
  const marketing = list.items.find((d) => d.policy_key === 'marketing')!;
  expect(marketing.reconsent_mode).toBe('consent');
  const existing = marketing.versions.find((v) => v.status === 'draft' && v.policy_version.startsWith('e2e-'));
  const summary = `AC14 E2E ${Date.now()}`;
  if (existing) {
    await gotoReady(pageA, `/policies?policy=marketing&version=${existing.id}`);
    const form = pageA.getByTestId('policy-form');
    await form.getByLabel('What changed (English)').fill(summary);
    await form.getByLabel('What changed (Persian)').fill('آزمون AC14');
    await form.getByRole('button', { name: 'Save the draft' }).click();
    await confirmWith(pageA, 'en', `Save draft ${existing.policy_version}`, 'Save the draft', 'correction');
    await expect(pageA.getByText('Draft saved.')).toBeVisible({ timeout: 30_000 });
  } else {
    await gotoReady(pageA, '/policies?policy=marketing&version=new');
    const form = pageA.getByTestId('policy-form');
    await expect(form).toBeVisible({ timeout: 30_000 });
    await form.getByLabel('Version label').fill(`e2e-${Date.now()}`.slice(0, 20));
    for (const l of ['English', 'Persian']) {
      if (!(await form.getByLabel(`Title (${l})`).inputValue())) await form.getByLabel(`Title (${l})`).fill(`E2E ${l}`);
      if (!(await form.getByLabel(`Text (${l})`).inputValue())) await form.getByLabel(`Text (${l})`).fill(`AC14 E2E text (${l}).`);
    }
    await form.getByLabel('What changed (English)').fill(summary);
    await form.getByLabel('What changed (Persian)').fill('آزمون AC14');
    await form.getByRole('button', { name: 'Create the draft' }).click();
    await confirmWith(pageA, 'en', 'New draft of Marketing messages', 'Create the draft', 'planned_change');
    await expect(pageA).toHaveURL(/[?&]version=[0-9a-f-]{36}/, { timeout: 30_000 });
  }
  await expect(pageA.getByTestId('policy-version')).toHaveAttribute('data-status', 'draft', { timeout: 30_000 });
  await expectNoAxeViolations(pageA);

  // Publish with re-consent: keep is preselected for a consent text; B rejects it.
  const publish = pageA.getByTestId('policy-publish');
  await publish.getByLabel('People must agree to this version again').check();
  await expect(publish.getByTestId('reconsent-action').getByLabel('Stay in effect until confirmed')).toBeChecked();
  await publish.getByRole('button', { name: 'Send for approval' }).click();
  await confirmWith(pageA, 'en', /^Publish Marketing messages /, 'Send for approval', 'legal_update', 'AC14 E2E, rejected by design');
  const change = await pendingChange(publish);
  await reject(pageB, change, 'Policy version published');
  await ctxA.close();
  await ctxB.close();
});

test('Persian: a template text saved, previewed and reset; the rules changed and saved back; delivery health', async ({ browser }) => {
  const ctx = await browser.newContext({ locale: 'fa-IR' });
  const page = await ctx.newPage();
  await signInAs(ctx, page, ['ADM'], { path: '/notifications', locale: 'fa' });
  await expect(page.getByRole('heading', { level: 1, name: say('fa', 'notif.title') })).toBeVisible();
  await expectNoAxeViolations(page);

  // An editable email template still on its built-in Persian text (a run that stopped half-way left its staff text:
  // reset those first).
  const MARK = '(آزمون AC14)';
  const read = async () =>
    (
      (await (await page.request.get('/api/v1/admin/notification-templates?channel=email&locale=fa')).json()) as {
        items: { template_key: string; editable: boolean; source: string; body: string }[];
      }
    ).items;
  for (const left of (await read()).filter((x) => x.source === 'override' && x.body.includes(MARK))) {
    await gotoReady(page, `/notifications?template=${encodeURIComponent(`${left.template_key}|email|fa`)}`);
    await page
      .getByTestId('template-editor')
      .getByRole('button', { name: say('fa', 'notif.reset') })
      .click();
    await confirmWith(page, 'fa', say('fa', 'notif.dialog.reset', { key: left.template_key }), say('fa', 'notif.reset'), 'correction');
    await expect(page.getByText(say('fa', 'notif.resetDone'))).toBeVisible({ timeout: 30_000 });
  }
  const all = { items: await read() };
  const tpl = all.items.find((x) => x.editable && x.source === 'code');
  expect(tpl, 'an editable built-in Persian email template').toBeTruthy();
  await gotoReady(page, `/notifications?template=${encodeURIComponent(`${tpl!.template_key}|email|fa`)}`);
  const editor = page.getByTestId('template-editor');
  await expect(editor).toHaveAttribute('data-editable', 'true', { timeout: 30_000 });
  const text = editor.getByLabel(say('fa', 'notif.field.body'));
  await text.fill(`${tpl!.body}\n(آزمون AC14)`);
  await editor.getByRole('button', { name: say('fa', 'notif.preview') }).click();
  await expect(editor.getByTestId('template-preview')).toContainText(MARK, { timeout: 30_000 });
  await expectNoAxeViolations(page);
  await editor.getByRole('button', { name: say('fa', 'notif.save') }).click();
  await confirmWith(page, 'fa', say('fa', 'notif.dialog.save', { key: tpl!.template_key }), say('fa', 'notif.save'), 'correction');
  await expect(page.getByText(say('fa', 'notif.saved'))).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('template-editor').getByRole('button', { name: say('fa', 'notif.reset') })).toBeVisible({
    timeout: 30_000,
  });
  await page
    .getByTestId('template-editor')
    .getByRole('button', { name: say('fa', 'notif.reset') })
    .click();
  await confirmWith(page, 'fa', say('fa', 'notif.dialog.reset', { key: tpl!.template_key }), say('fa', 'notif.reset'), 'correction');
  await expect(page.getByText(say('fa', 'notif.resetDone'))).toBeVisible({ timeout: 30_000 });
  const after = (await (
    await page.request.get(`/api/v1/admin/notification-templates?template_key=${tpl!.template_key}&channel=email&locale=fa`)
  ).json()) as {
    items: { source: string }[];
  };
  expect(after.items[0]!.source).toBe('code');

  // Rules: the mileage window one km up, saved, then saved back (If-Match both times).
  await gotoReady(page, '/notifications?tab=rules');
  const form = page.getByTestId('notif-rules');
  await expect(form).toBeVisible({ timeout: 30_000 });
  await expectNoAxeViolations(page);
  const km = form.getByLabel(say('fa', 'notif.rules.mileageKm'));
  const before = await km.inputValue();
  const changed = String(Number(before) >= 5000 ? Number(before) - 1 : Number(before) + 1);
  for (const value of [changed, before]) {
    await gotoReady(page, '/notifications?tab=rules');
    await page.getByTestId('notif-rules').getByLabel(say('fa', 'notif.rules.mileageKm')).fill(value);
    await page
      .getByTestId('notif-rules')
      .getByRole('button', { name: say('fa', 'notif.rules.save') })
      .click();
    await confirmWith(page, 'fa', say('fa', 'notif.rules.dialog'), say('fa', 'notif.rules.save'), 'planned_change');
    await expect(page.getByText(say('fa', 'notif.rules.saved'))).toBeVisible({ timeout: 30_000 });
  }
  const rules = (await (await page.request.get('/api/v1/admin/notification-rules')).json()) as { mileage_due_window_km: number };
  expect(String(rules.mileage_due_window_km)).toBe(before);

  // Delivery health: a table or the empty note.
  await gotoReady(page, '/notifications?tab=health');
  await expect(page.getByTestId('notif-health')).toBeVisible({ timeout: 30_000 });
  await expectNoAxeViolations(page);
  await ctx.close();
});
