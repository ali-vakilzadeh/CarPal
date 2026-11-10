// AC5.T8 E2E (acceptance "The four-eyes round trip works with two staff users; the requester cannot approve"): two
// ADM staff members in two browser contexts. Staff A files a four-eyes change through the BFF (a data retention
// policy filed again with its own values, so approving it changes nothing; the Data retention screen is AC6); the
// change never appears in A's Pending approvals, a deep link explains why, and A's own decision is refused with
// SELF_APPROVAL_FORBIDDEN; staff B sees it, approves it with a reason, and it moves to Approved. Also: My work and
// Pending approvals in Persian (RTL), a support agent without access, and axe on every view.
// Needs backend `pnpm dev` with the console's settings (README "End-to-end tests").
import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations, gotoReady } from './support';
import { requireBackend, signInAs } from './staff';

test.beforeAll(async () => {
  await requireBackend();
});

interface Filed {
  status: number;
  change?: { change_id: string; summary: string; op_id: string; status: string };
  body?: string;
}

/** As staff A in the page: re-file one retention policy with its current values (202 PendingChange). */
async function fileRetentionChange(page: Page): Promise<Filed> {
  return page.evaluate(async () => {
    const csrf = ((await (await fetch('/bff/csrf')).json()) as { csrf_token: string }).csrf_token;
    const list = (await (await fetch('/api/v1/admin/retention-policies?limit=100')).json()) as {
      items: { id: string; [k: string]: unknown }[];
    };
    // Another run may have left a pending change on a policy (409 DUPLICATE): try the others, in random order.
    const policies = [...list.items].sort(() => Math.random() - 0.5);
    for (const { id, ...rest } of policies) {
      const res = await fetch(`/api/v1/admin/retention-policies/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({ ...rest, reason: 'planned_change: AC5 E2E four-eyes round trip (same values)' }),
      });
      if (res.status === 202) return { status: 202, change: await res.json() };
      if (res.status !== 409) return { status: res.status, body: await res.text() };
    }
    return { status: 409 };
  });
}

/** As the signed-in staff member: decide a change directly through the BFF (what a crafted request would do). */
async function decideDirectly(page: Page, changeId: string): Promise<{ status: number; code: string }> {
  return page.evaluate(async (id) => {
    const csrf = ((await (await fetch('/bff/csrf')).json()) as { csrf_token: string }).csrf_token;
    const res = await fetch(`/api/v1/admin/four-eyes/${id}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ decision: 'approve', reason: 'checked_and_correct' }),
    });
    return { status: res.status, code: ((await res.json()) as { code?: string }).code ?? '' };
  }, changeId);
}

test('four-eyes round trip: A requests, A cannot approve, B approves with a reason (AC5)', async ({ browser }) => {
  test.setTimeout(240_000);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  await Promise.all([signInAs(ctxA, pageA, ['ADM'], { path: '/approvals' }), signInAs(ctxB, pageB, ['ADM'], { path: '/approvals' })]);
  await expect(pageA.getByRole('heading', { level: 1, name: 'Pending approvals' })).toBeVisible();

  const filed = await fileRetentionChange(pageA);
  expect(filed.status, filed.body).toBe(202);
  const change = filed.change!;
  expect(change).toMatchObject({ op_id: 'admin.retention_update', status: 'pending' });

  // A: not in the list (the server never lists one's own changes); a deep link explains; a direct decision is refused.
  await gotoReady(pageA, `/approvals?change=${change.change_id}`);
  await expect(pageA.getByTestId('approvals-own-hint')).toBeVisible();
  await expect(pageA.getByTestId('approval-not-listed')).toBeVisible();
  await expect(pageA.locator(`tr[data-row="${change.change_id}"]`)).toHaveCount(0);
  expect(await decideDirectly(pageA, change.change_id)).toEqual({ status: 403, code: 'SELF_APPROVAL_FORBIDDEN' });

  // B: sees it in the list, opens it, approves with a reason.
  await gotoReady(pageB, '/approvals');
  const row = pageB.locator(`tr[data-row="${change.change_id}"]`);
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Data retention change' }).click();
  const detail = pageB.getByTestId('approval-detail');
  await expect(detail).toContainText(change.summary);
  await expect(detail).toContainText('Planned change');
  await expectNoAxeViolations(pageB);
  await pageB.getByRole('button', { name: 'Approve', exact: true }).click();
  const dialog = pageB.getByRole('dialog', { name: 'Approve this change' });
  await dialog.getByRole('button', { name: 'Approve' }).click();
  await expect(dialog.getByText('Choose a reason.')).toBeVisible();
  await dialog.getByLabel('Reason').selectOption('checked_and_correct');
  await dialog.getByLabel('Note (optional)').fill('Same values; E2E check.');
  await expectNoAxeViolations(pageB);
  await dialog.getByRole('button', { name: 'Approve' }).click();
  await expect(pageB.getByText('Approved. The change is applied.')).toBeVisible();
  await expect(pageB.locator(`tr[data-row="${change.change_id}"]`)).toHaveCount(0);

  // It is now an approved change, decided by B.
  await gotoReady(pageB, `/approvals?status=approved&change=${change.change_id}`);
  await expect(pageB.getByTestId('approval-status')).toHaveText('Approved');
  await expect(pageB.getByText('Already decided: Approved.')).toBeVisible();
  // A second decision is refused as expired/decided.
  expect((await decideDirectly(pageB, change.change_id)).code).toBe('INVALID_TRANSITION');

  // My work for B: the approvals section and the ADM queues.
  await gotoReady(pageB, '/');
  await expect(pageB.getByRole('heading', { level: 1, name: 'My work' })).toBeVisible();
  await expect(pageB.locator('[data-queue]')).toHaveCount(4);
  await expect(pageB.locator('[data-queue="approvals"]')).not.toHaveAttribute('data-count', '');
  await expect(pageB.getByTestId('my-queue')).toHaveAttribute('href', '/');
  await expectNoAxeViolations(pageB);
  await ctxA.close();
  await ctxB.close();
});

test('Persian: My work and Pending approvals right to left (axe)', async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ locale: 'fa-IR' });
  const page = await context.newPage();
  await signInAs(context, page, ['MOD'], { locale: 'fa' });
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { level: 1, name: 'کارهای من' })).toBeVisible();
  await expect(page.locator('[data-queue]')).toHaveCount(6);
  await expect(page.locator('[data-queue="reports"]')).not.toHaveAttribute('data-count', '');
  await expectNoAxeViolations(page);
  await gotoReady(page, '/approvals');
  await expect(page.getByRole('heading', { level: 1, name: 'تأییدهای در انتظار' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'تغییرها' })).toBeVisible();
  await expectNoAxeViolations(page);
  await context.close();
});

test('support staff cannot open Pending approvals and see their own queues', async ({ context, page }) => {
  test.setTimeout(180_000);
  await signInAs(context, page, ['SUP']);
  await expect(page.locator('[data-queue]')).toHaveCount(2);
  await expect(page.getByTestId('work-approvals')).toHaveCount(0);
  await gotoReady(page, '/approvals');
  await expect(page.getByTestId('no-permission')).toBeVisible();
  await expectNoAxeViolations(page);
});
