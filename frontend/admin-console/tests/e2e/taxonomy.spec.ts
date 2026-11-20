// AC12.T6: taxonomy management against the live backend (strict for the acceptance run). Test data: two brands with
// an "e2e-" slug; the duplicate is merged into the other, which is set inactive at the end, so neither shows in the
// apps' pickers. Seed nodes are only read.
//   EN  a brand cannot be saved without EN and FA labels; a duplicate brand; a Latin-letter transliteration; an edit
//       with If-Match; the merge filed by admin A, approved by admin B on Pending approvals, its job followed to the
//       end; the duplicate is "merged" on the taxonomy page; the survivor set inactive
//   FA  a moderator reads the tree and a node (no editing), and the zero-result searches; axe
import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations, gotoReady } from './support';
import { requireBackend, signInAs } from './staff';

test.beforeAll(requireBackend);
test.describe.configure({ mode: 'serial', timeout: 240_000 });

const run = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

async function reason(page: Page, dialogName: string, code: string, o: { note?: string; tick?: boolean; confirm: string }) {
  const dialog = page.getByRole('dialog', { name: dialogName });
  await dialog.getByLabel('Reason').selectOption(code);
  if (o.note) await dialog.getByRole('textbox').last().fill(o.note);
  if (o.tick) await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: o.confirm, exact: true }).click();
}

/** Creates a top-level brand from /taxonomy and returns its id (from the URL). */
async function createBrand(page: Page, en: string, fa: string, slug: string): Promise<string> {
  await gotoReady(page, '/taxonomy?type=vehicle_brand');
  await page.getByRole('button', { name: 'Add to Vehicle brands' }).click();
  const editor = page.getByTestId('node-editor');
  await editor.getByLabel('Label (English)').fill(en);
  if (fa) await editor.getByLabel('Label (Persian)').fill(fa);
  await editor.getByLabel('Slug').fill(slug);
  await editor.getByRole('button', { name: 'Create node' }).click();
  if (!fa) return '';
  await reason(page, 'Create the node', 'new_item', { confirm: 'Create node' });
  await expect(page).toHaveURL(/[?&]node=[0-9a-f-]{36}/, { timeout: 30_000 });
  return new URL(page.url()).searchParams.get('node')!;
}

test('brands, a transliteration, an edit and a merge approved by a second admin (EN)', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  await Promise.all([signInAs(ctxA, pageA, ['ADM'], { path: '/taxonomy' }), signInAs(ctxB, pageB, ['ADM'], { path: '/approvals' })]);
  await expect(pageA.getByRole('heading', { level: 1, name: 'Taxonomy' })).toBeVisible();
  await expect(pageA.getByTestId('tax-node').first()).toBeVisible({ timeout: 30_000 });
  await expectNoAxeViolations(pageA);

  // Not without both labels.
  await createBrand(pageA, `E2E Brand ${run}`, '', `e2e-brand-${run}`);
  await expect(pageA.getByTestId('editor-problems')).toContainText('Enter the Persian label.');
  await expect(pageA.getByRole('dialog', { name: 'Create the node' })).toHaveCount(0);

  const keep = await createBrand(pageA, `E2E Brand ${run}`, `برند آزمایشی ${run}`, `e2e-brand-${run}`);
  const dup = await createBrand(pageA, `E2E Brand dup ${run}`, `برند تکراری ${run}`, `e2e-brand-dup-${run}`);
  expect(keep).not.toBe(dup);

  // A Latin-letter Persian spelling of the kept brand.
  await gotoReady(pageA, `/taxonomy?type=vehicle_brand&node=${keep}&tab=synonyms`);
  const form = pageA.getByTestId('synonym-add');
  await form.getByLabel('Term', { exact: true }).fill(`e2e barand ${run}`);
  await form.getByLabel('Kind', { exact: true }).selectOption('transliteration');
  await form.getByLabel(/^Script/).selectOption('latin');
  await form.getByRole('button', { name: 'Add' }).click();
  await reason(pageA, 'Add this term', 'search_gap', { confirm: 'Add' });
  const syn = pageA.locator(`[data-testid="synonym"][data-term="e2e barand ${run}"]`);
  await expect(syn).toHaveAttribute('data-status', 'active', { timeout: 30_000 });
  await expect(syn).toContainText('Transliteration (Latin letters)');

  // An edit (If-Match from the version).
  await gotoReady(pageA, `/taxonomy?type=vehicle_brand&node=${keep}`);
  const editor = pageA.getByTestId('node-editor');
  await editor.getByLabel('Label (English)').fill(`E2E Brand ${run} edited`);
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await reason(pageA, 'Save the node', 'correction', { confirm: 'Save changes' });
  await expect(pageA.getByText('Saved.')).toBeVisible({ timeout: 30_000 });
  await expect(pageA.getByTestId('tax-node-title')).toContainText('edited');

  // A files the merge of the duplicate; it waits for a second admin.
  await gotoReady(pageA, `/taxonomy?type=vehicle_brand&node=${dup}&tab=merge`);
  const panel = pageA.getByTestId('merge-panel');
  await panel.getByLabel(/^Merge into/).selectOption(keep);
  await panel.getByRole('button', { name: 'Merge', exact: true }).click();
  await reason(pageA, 'Merge this node', 'duplicate', { note: 'Same brand, E2E', tick: true, confirm: 'Merge' });
  const banner = panel.locator('[data-kit="four-eyes-banner"]');
  await expect(banner).toBeVisible({ timeout: 30_000 });
  const changeId = await banner.getAttribute('data-change');
  expect(changeId).toMatch(/^[0-9a-f-]{36}$/);
  await expectNoAxeViolations(pageA);

  // B approves on Pending approvals and watches the job finish.
  await gotoReady(pageB, `/approvals?change=${changeId}`);
  await expect(pageB.getByTestId('approval-detail')).toContainText('Taxonomy merge');
  await pageB.getByRole('button', { name: 'Approve', exact: true }).click();
  await reason(pageB, 'Approve this change', 'checked_and_correct', { confirm: 'Approve' });
  const job = pageB.locator('[data-kit="job"]');
  await expect(job).toBeVisible({ timeout: 30_000 });
  await expect(job).toHaveAttribute('data-status', 'succeeded', { timeout: 90_000 });

  // A: the duplicate is merged; the job shows under "Merges you asked for".
  await gotoReady(pageA, `/taxonomy?type=vehicle_brand&node=${dup}&tab=merge`);
  await expect(pageA.getByTestId('merge-panel')).toHaveAttribute('data-merged', 'true', { timeout: 30_000 });
  await expect(pageA.getByTestId('tax-node-title')).toContainText('Merged');

  // Clean-up: the kept test brand stops being offered.
  await gotoReady(pageA, `/taxonomy?type=vehicle_brand&node=${keep}`);
  await pageA.getByTestId('node-editor').getByLabel('Status').selectOption('inactive');
  await pageA.getByTestId('node-editor').getByRole('button', { name: 'Save changes' }).click();
  await reason(pageA, 'Save the node', 'catalog_cleanup', { confirm: 'Save changes' });
  await expect(pageA.getByTestId('tax-node-title')).toContainText('Inactive', { timeout: 30_000 });
  await ctxA.close();
  await ctxB.close();
});

test('a moderator reads the catalog and the zero-result searches (FA)', async ({ browser }) => {
  const ctx = await browser.newContext({ locale: 'fa-IR' });
  const page = await ctx.newPage();
  await signInAs(ctx, page, ['MOD'], { path: '/taxonomy?type=symptom', locale: 'fa' });
  await expect(page.getByRole('heading', { level: 1, name: 'رده‌بندی' })).toBeVisible();
  const first = page.getByTestId('tax-node').first();
  await expect(first).toBeVisible({ timeout: 30_000 });
  await first.click();
  const editor = page.getByTestId('node-editor');
  await expect(editor).toBeVisible();
  await expect(editor.getByRole('button', { name: 'ذخیرهٔ تغییرات' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^افزودن به/ })).toHaveCount(0);
  await expectNoAxeViolations(page);

  await page.getByRole('tab', { name: 'جست‌وجوهای بی‌نتیجه' }).click();
  await expect(page.getByTestId('terms-stats')).toBeVisible({ timeout: 30_000 });
  await expectNoAxeViolations(page);
  await ctx.close();
});
