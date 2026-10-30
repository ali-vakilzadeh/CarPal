// P8.T7: Community in the built PWA against the live backend (`pnpm dev` in backend/ with the env of pwa/README.md).
// Sara's Ch. 10 in FA: she asks the winter-tyre question (W-QA-02), the page is noindex while unanswered (W-PUB-06); a
// second user answers and reports nothing but tries the report modal (W-RPT-01); Sara accepts the answer and the
// question page becomes indexable with QAPage JSON-LD (served through the 60 s public-read cache, so it is polled).
// Then the signed-in pages of this stage — home (W-FEED-01), Saved (W-NET-01) and the Q&A hub (W-QA-01) — with axe in
// FA and EN. The community flags are seeded off (DI-18): beforeAll turns them on with the dev-only backend CLI (P8.T0)
// and waits until config.client says so.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { backendUp, createUser } from './accounts';
import { decideCookies, expectNoAxeViolations, gotoReady } from './support';

const FA = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'shared', 'i18n', 'locales', 'fa.json'), 'utf8')) as Record<
  string,
  unknown
>;
function fa(key: string): string {
  const v = key.split('.').reduce<unknown>((node, k) => (node as Record<string, unknown>)[k], FA);
  if (typeof v !== 'string') throw new Error(`no fa string ${key}`);
  return v;
}

const BACKEND = join(import.meta.dirname, '..', '..', '..', 'backend');

test.beforeAll(async ({ request, baseURL }) => {
  if (!(await backendUp(request))) return;
  // pnpm is on PATH in `pnpm e2e` (project-local Node); the CLI refuses anything but CARPAL_ENV=dev.
  execFileSync('pnpm', ['-s', 'dev:flags', 'set', 'community', 'on'], { cwd: BACKEND, stdio: 'pipe', shell: process.platform === 'win32' });
  // The PWA caches config.client for up to a minute (stale-while-revalidate).
  await expect
    .poll(async () => (await (await request.get(`${baseURL}/fa/questions`)).text()).includes('data-state="featureOff"'), {
      timeout: 120_000,
      intervals: [2_000],
    })
    .toBe(false);
});

test.beforeEach(async ({ request, context, baseURL }) => {
  test.skip(!(await backendUp(request)), 'needs the backend (`pnpm dev` in backend/)');
  await decideCookies(context, baseURL!);
});

/** Signs a fresh account in through the hosted sign-in and skips the onboarding (lands on /en or /en/home). */
async function signIn(page: Page, user: { email: string; password: string }) {
  await page.goto('/en/login');
  await page.waitForURL(/\/id\/signin\?interaction_id=/);
  await page.locator('html[data-hydrated="true"]').waitFor({ state: 'attached' });
  await page.getByLabel('Mobile number or email').fill(user.email);
  await page.getByRole('button', { name: 'Use password' }).click();
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForURL(/\/en\/onboarding\?next=/);
  await page.getByRole('link', { name: 'Finish later' }).click();
  await page.waitForURL(/\/en(\/home)?$/);
}

async function secondUser(browser: Browser, baseURL: string, request: Parameters<typeof createUser>[0]) {
  const context = await browser.newContext({ baseURL });
  await decideCookies(context, baseURL);
  const page = await context.newPage();
  await signIn(page, await createUser(request, { fullName: 'Mehdi Karimi' }));
  return { context, page };
}

test('Sara Ch. 10 in FA: ask, a second user answers, Sara accepts, the question becomes indexable', async ({
  page,
  browser,
  request,
  baseURL,
}) => {
  test.setTimeout(300_000);
  await signIn(page, await createUser(request, { fullName: 'Sara Mohammadi' }));
  const run = Math.random().toString(36).slice(2, 7);
  const title = `چه لاستیک زمستانی برای E90 با رینگ ۱۷ مناسب است؟ ${run}`;

  // W-QA-02: title, details, a category; the similar-questions panel; post.
  await gotoReady(page, '/fa/questions/ask');
  await page.getByLabel(fa('community.ask.title')).fill(title);
  await page.getByLabel(fa('community.ask.details'), { exact: true }).fill('بیشتر رانندگی شهری در تهران، گاهی سفر شمال در زمستان.');
  const category = page.getByLabel(fa('community.ask.categoryPick'));
  await expect(category.locator('option')).not.toHaveCount(1);
  await category.selectOption({ index: 1 });
  await expect(page.getByRole('heading', { name: fa('community.ask.similar') })).toBeVisible();
  await expectNoAxeViolations(page);
  await page.getByRole('button', { name: fa('community.ask.post') }).click();
  await page.waitForURL(/\/fa\/questions\/[0-9a-f-]{36}-/, { timeout: 30_000 });
  const url = page.url();

  // W-PUB-06 unanswered: noindex, no QAPage, "No answers yet".
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  await expect(page.getByText(fa('community.answer.none'))).toBeVisible();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  expect(await page.content()).not.toContain('"QAPage"');
  await expectNoAxeViolations(page);

  // A second user answers in FA and opens the report modal (reasons visible; sent once).
  const helper = await secondUser(browser, baseURL!, request);
  await gotoReady(helper.page, url);
  await helper.page
    .getByLabel(fa('community.answer.label'))
    .fill('اگر رینگ‌ها متفاوت است، جلو 225/45 R17 و عقب 255/40 R17. لاستیک زمستانی درجه‌یک با رانفلت انتخاب مطمئنی است.');
  await helper.page.getByRole('button', { name: fa('community.answer.post') }).click();
  await expect(helper.page.getByText(fa('community.answer.sent'))).toBeVisible();
  await helper.page
    .getByRole('button', { name: fa('shell.report.open') })
    .first()
    .click();
  const dialog = helper.page.getByRole('dialog', { name: fa('shell.report.title') });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(fa('shell.report.reason.off_topic')).check();
  await expectNoAxeViolations(helper.page);
  await dialog.getByRole('button', { name: fa('shell.report.send') }).click();
  await expect(helper.page.getByText(fa('shell.report.sent'))).toBeVisible();
  await helper.context.close();

  // Sara accepts the answer.
  await gotoReady(page, url);
  await page.getByRole('button', { name: fa('community.answer.accept') }).click();
  await expect(page.getByText(fa('community.answer.acceptedToast'))).toBeVisible();
  await expect(page.locator('.pwa-answer.is-accepted').getByText(fa('community.answer.accepted'))).toBeVisible();
  await expectNoAxeViolations(page);

  // Indexable now (public reads are cached up to 60 s): robots index + QAPage JSON-LD with the accepted answer.
  await expect
    .poll(
      async () => {
        const html = await (await request.get(url)).text();
        return html.includes('"QAPage"') && html.includes('"acceptedAnswer"') && !/<meta name="robots" content="noindex/.test(html);
      },
      { timeout: 120_000, intervals: [5_000] },
    )
    .toBe(true);

  // The hub lists it for guests (server-rendered first page).
  await expect
    .poll(async () => (await (await request.get(`${baseURL}/fa/questions?status=answered`)).text()).includes(run), {
      timeout: 90_000,
      intervals: [5_000],
    })
    .toBe(true);
});

test('signed-in community pages pass axe in FA and EN: home, Saved, Q&A hub', async ({ page, request }) => {
  test.setTimeout(180_000);
  await signIn(page, await createUser(request));
  for (const locale of ['fa', 'en'] as const) {
    await gotoReady(page, `/${locale}/home`);
    await expect(page.locator('#home-discover')).toBeVisible();
    await expect(page.locator('.pwa-feed-card, .pwa-feed-block, [data-state="empty"]').first()).toBeVisible({ timeout: 30_000 });
    await expectNoAxeViolations(page);
    await gotoReady(page, `/${locale}/saved`);
    await expect(page.getByRole('tablist')).toBeVisible();
    await page.getByRole('tab').nth(1).click();
    await expect(page).toHaveURL(/tab=following/);
    await expectNoAxeViolations(page);
    await gotoReady(page, `/${locale}/questions`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectNoAxeViolations(page);
  }
});
