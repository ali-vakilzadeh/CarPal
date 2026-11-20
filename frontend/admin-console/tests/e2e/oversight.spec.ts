// AC13.T7: oversight against the live backend (strict for the acceptance run). Nothing is changed in the shared
// database: the MCP scope change is rejected by the second administrator, and the client is never suspended (other
// specs run in parallel and AI paths would stop; suspension is covered by the DOM tests).
//   EN  the home dashboard of an administrator: every widget loads (queues from admin.work_summary, System, AI);
//       every analytics dashboard key renders with data or its empty state (axe each);
//       MCP: admin A removes a tool from admin_copilot (only the tools list, If-Match), the change waits; admin B
//       rejects it on Pending approvals; the audit log finds the request and the rejection by the client's id; the
//       client still has the tool; the access log answers a search
//   FA  a moderator: every analytics dashboard key (axe each), AI oversight (no kill-switch read) and the AI outputs;
//       an administrator: the audit log and the MCP pages
import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations, gotoReady } from './support';
import { requireBackend, signInAs } from './staff';

test.beforeAll(requireBackend);
test.describe.configure({ mode: 'serial', timeout: 300_000 });

const DASHBOARDS = [
  'activation',
  'matching',
  'search_and_map',
  'trust',
  'reviews',
  'provider_value',
  'vendor_value',
  'fleet_value',
  'growth',
  'moderation_load',
  'ai_quality',
];
const TOOL = 'tool:moderation.prioritize_queue@1';

async function reason(page: Page, dialogName: string, code: string, o: { note?: string; confirm: string }) {
  const dialog = page.getByRole('dialog', { name: dialogName });
  await dialog.getByLabel('Reason').selectOption(code);
  if (o.note) await dialog.getByRole('textbox').last().fill(o.note);
  await dialog.getByRole('button', { name: o.confirm, exact: true }).click();
}

/** Opens every dashboard key in turn: each ends ready (numbers or the empty note), with axe. */
async function everyDashboard(page: Page) {
  await gotoReady(page, '/analytics');
  const nav = page.locator('.adm-anl-nav');
  for (const key of DASHBOARDS) {
    await nav.locator(`[data-dashboard="${key}"]`).click();
    const view = page.getByTestId('dashboard-view');
    await expect(view).toHaveAttribute('data-dashboard', key);
    await expect(view).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
    await expect(view.locator('figure.adm-chart, [role="status"]').first()).toBeVisible();
    await expectNoAxeViolations(page);
  }
}

test('administrator: the home dashboard and every analytics dashboard (EN)', async ({ context, page }) => {
  await signInAs(context, page, ['ADM']);
  await expect(page.getByRole('heading', { level: 1, name: 'My work' })).toBeVisible();
  const widgets = page.locator('[data-widget]');
  await expect(widgets).toHaveCount(7);
  for (const id of ['my-work', 'queues', 'safety', 'growth', 'trust', 'ai', 'system'])
    await expect(page.locator(`[data-widget="${id}"]`)).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  await expect(page.locator('[data-queue]')).toHaveCount(8);
  await expect(page.getByTestId('system-sms')).toBeVisible();
  await expect(page.locator('[data-widget="ai"] [data-testid="ai-kill"]')).toHaveAttribute('data-state', /^(on|off)$/);
  await expectNoAxeViolations(page);
  // The period of the metric widgets.
  await page.getByTestId('period').getByLabel('Period').selectOption('7');
  await expect(page).toHaveURL(/[?&]range=7/);
  await expect(page.locator('[data-widget="growth"]')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });

  await everyDashboard(page);
});

test('MCP: a tool removal waits for a second admin, who rejects it; the audit log shows both (EN)', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  await Promise.all([signInAs(ctxA, pageA, ['ADM'], { path: '/mcp' }), signInAs(ctxB, pageB, ['ADM'], { path: '/approvals' })]);
  await expect(pageA.getByRole('heading', { level: 1, name: 'MCP clients and access log' })).toBeVisible();
  await pageA.getByRole('button', { name: 'admin_copilot', exact: true }).click();
  await expect(pageA).toHaveURL(/[?&]client=[0-9a-f-]{36}/);
  const clientId = new URL(pageA.url()).searchParams.get('client')!;
  const detail = pageA.getByTestId('mcp-client');
  const tools = detail.locator('[data-field="allowed_tools"]');
  await tools.locator('summary', { hasText: 'moderation' }).click();
  const box = tools.getByRole('checkbox', { name: TOOL });
  await expect(box).toBeChecked();
  await expectNoAxeViolations(pageA);
  await box.uncheck();
  await detail.getByRole('button', { name: 'Ask to save' }).click();
  await expect(pageA.getByTestId('mcp-diff')).toContainText(`Removed: ${TOOL}`);
  await reason(pageA, "Change the client's access", 'least_privilege', {
    note: 'AC13 E2E, rejected by design',
    confirm: 'Ask for approval',
  });
  const banner = detail.locator('[data-kit="four-eyes-banner"]');
  await expect(banner).toBeVisible({ timeout: 30_000 });
  const changeId = await banner.getAttribute('data-change');
  expect(changeId).toMatch(/^[0-9a-f-]{36}$/);

  // B rejects it: the client keeps its tools.
  await gotoReady(pageB, `/approvals?change=${changeId}`);
  await expect(pageB.getByTestId('approval-detail')).toContainText('MCP client change');
  await pageB.getByRole('button', { name: 'Reject', exact: true }).click();
  await reason(pageB, 'Reject this change', 'not_justified', { note: 'AC13 E2E clean-up', confirm: 'Reject' });
  await expect(pageB.getByText('Rejected. The change will not be applied.')).toBeVisible({ timeout: 30_000 });

  await gotoReady(pageA, `/mcp?client=${clientId}`);
  const again = pageA.getByTestId('mcp-client').locator('[data-field="allowed_tools"]');
  await again.locator('summary', { hasText: 'moderation' }).click();
  await expect(again.getByRole('checkbox', { name: TOOL })).toBeChecked();

  // The audit log: the request and the rejection, by the client's id (the search itself is recorded).
  await gotoReady(pageA, '/audit');
  await expect(pageA.getByTestId('audit-idle')).toBeVisible();
  const form = pageA.getByTestId('audit-search');
  await form.getByLabel('Entity type').fill('mcp_client');
  await form.getByLabel('Entity ID').fill(clientId);
  await form.getByLabel('Time').selectOption('1');
  await form.getByRole('button', { name: 'Search' }).click();
  const results = pageA.getByTestId('audit-results');
  await expect(results.getByText('admin.four_eyes_requested').first()).toBeVisible({ timeout: 30_000 });
  await expect(results.getByText('admin.four_eyes_rejected').first()).toBeVisible();
  await expectNoAxeViolations(pageA);

  // The access log answers a search (rows or the empty note).
  await gotoReady(pageA, '/mcp?tab=log');
  await expect(pageA.getByTestId('mcp-log-idle')).toBeVisible();
  await pageA.getByTestId('mcp-log-search').getByRole('button', { name: 'Search' }).click();
  const log = pageA.getByTestId('mcp-log-results');
  await expect(log.locator('[data-kit="data-table"]')).toHaveAttribute('data-state', /^(ready|empty)$/, { timeout: 30_000 });
  await expectNoAxeViolations(pageA);
  await ctxA.close();
  await ctxB.close();
});

test('Persian: a moderator reads every dashboard and AI oversight; an administrator the audit log and MCP', async ({ browser }) => {
  const ctxM = await browser.newContext({ locale: 'fa-IR' });
  const pageM = await ctxM.newPage();
  await signInAs(ctxM, pageM, ['MOD'], { locale: 'fa' });
  await expect(pageM.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(pageM.locator('[data-widget="ai"]')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  await expectNoAxeViolations(pageM);
  await everyDashboard(pageM);

  await gotoReady(pageM, '/ai');
  await expect(pageM.getByRole('heading', { level: 1, name: 'نظارت بر هوش مصنوعی' })).toBeVisible();
  await expect(pageM.getByTestId('ai-stats')).toBeVisible({ timeout: 30_000 });
  await expect(pageM.getByText('وضعیت کلید توقف برای مدیران پلتفرم نمایش داده می‌شود.')).toBeVisible();
  await expectNoAxeViolations(pageM);
  await gotoReady(pageM, '/ai?tab=insights');
  await expect(pageM.getByTestId('ai-insights').locator('[data-kit="data-table"]')).toHaveAttribute('data-state', /^(ready|empty)$/, {
    timeout: 30_000,
  });
  await expectNoAxeViolations(pageM);
  // The audit log is for administrators only.
  await gotoReady(pageM, '/audit');
  await expect(pageM.getByTestId('no-permission')).toBeVisible();
  await ctxM.close();

  const ctxA = await browser.newContext({ locale: 'fa-IR' });
  const pageA = await ctxA.newPage();
  await signInAs(ctxA, pageA, ['ADM'], { locale: 'fa', path: '/audit' });
  await expect(pageA.getByRole('heading', { level: 1, name: 'گزارش ممیزی' })).toBeVisible();
  await pageA.getByTestId('audit-search').getByLabel('اقدام').fill('admin.four_eyes_rejected');
  await pageA.getByTestId('audit-search').getByRole('button', { name: 'جست‌وجو' }).click();
  await expect(pageA.getByTestId('audit-results').locator('[data-kit="data-table"]')).toHaveAttribute('data-state', /^(ready|empty)$/, {
    timeout: 30_000,
  });
  await expectNoAxeViolations(pageA);
  await gotoReady(pageA, '/mcp');
  await pageA.getByRole('button', { name: 'ai_pipelines', exact: true }).click();
  await expect(pageA.getByTestId('mcp-client')).toHaveAttribute('data-client', 'ai_pipelines');
  await expectNoAxeViolations(pageA);
  await ctxA.close();
});
