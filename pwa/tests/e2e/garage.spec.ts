// P7.T7: My Garage in the built PWA against the live backend (`pnpm dev` in backend/ with the env of pwa/README.md).
// Sara's Ch. 4 in FA: add the car (W-GAR-03), update the mileage inline, add a service record with a PDF invoice and
// a photo dropped into the upload kit (both end "clean" and open through signed URLs: the PDF in place, the photo full
// size, Download), see it in the history table, open the buyer-friendly print view. Then the vehicle limit: the
// server refuses a 6th active car and W-GAR-03 shows the C-PLAN-01 panel with the entered data kept. axe on every
// visited garage page.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import { backendUp, createUser } from './accounts';
import { decideCookies, expectNoAxeViolations, gotoReady } from './support';

const FA = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'shared', 'i18n', 'locales', 'fa.json'), 'utf8')) as Record<
  string,
  unknown
>;
/** A Persian string of the dictionary by key ("garage.addVehicle"). */
function fa(key: string): string {
  const v = key.split('.').reduce<unknown>((node, k) => (node as Record<string, unknown>)[k], FA);
  if (typeof v !== 'string') throw new Error(`no fa string ${key}`);
  return v;
}

test.beforeEach(async ({ request, context, baseURL }) => {
  test.skip(!(await backendUp(request)), 'needs the backend (`pnpm dev` in backend/)');
  await decideCookies(context, baseURL!);
});

/** Signs a fresh account in through the hosted sign-in and skips the onboarding. */
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

/** A small valid PNG (the backend decodes and re-encodes images, SEC-UP-3). */
function png(width = 24, height = 16): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) row.set([200, 40 + y * 8, 40 + x * 6], 1 + x * 3);
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n',
);

/** Fills the car on W-GAR-03: the first brand and model of the taxonomy, a year. */
async function fillCar(page: Page, o: { brand: string; model: string; year: string }) {
  const brand = page.getByRole('combobox', { name: o.brand, exact: true });
  await expect(brand.locator('option')).not.toHaveCount(1);
  await brand.selectOption({ index: 1 });
  const model = page.getByRole('combobox', { name: o.model, exact: true });
  await expect(model.locator('option')).not.toHaveCount(1);
  await model.selectOption({ index: 1 });
  await page.getByRole('combobox', { name: o.year, exact: true }).selectOption('2008');
}

test('Sara Ch. 4 in FA: add the car, update the mileage, add a record with an invoice PDF and a photo, print the history', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const user = await createUser(request, { locale: 'fa' });
  await signIn(page, user);

  // Empty garage → Add your first car.
  await gotoReady(page, '/fa/garage');
  await expect(page.getByRole('heading', { name: fa('garage.empty.title') })).toBeVisible();
  await expectNoAxeViolations(page);
  await page
    .getByRole('link', { name: fa('garage.addVehicle') })
    .last()
    .click();
  await page.waitForURL(/\/fa\/garage\/add$/);
  await page.locator('html[data-hydrated="true"]').waitFor({ state: 'attached' });

  // W-GAR-03: the car, the live preview and the completeness meter.
  await fillCar(page, { brand: 'برند', model: 'مدل', year: 'سال' });
  await page.getByLabel(fa('garage.form.nickname'), { exact: true }).fill('نقره‌ای');
  await page.getByLabel(fa('garage.history.mileage'), { exact: true }).fill('۱۵۲۴۰۰');
  await expect(page.getByTestId('vehicle-preview')).toContainText('نقره‌ای');
  await expectNoAxeViolations(page);
  await page.getByRole('button', { name: fa('common.actions.save') }).click();
  await page.waitForURL(/\/fa\/garage\/[0-9a-f-]{36}\/overview$/);
  const vehicleUrl = page.url().replace(/\/overview$/, '');
  await expect(page.getByRole('heading', { level: 2, name: 'نقره‌ای' })).toBeVisible();
  await expect(page.getByText('۱۵۲٬۴۰۰ کیلومتر').first()).toBeVisible();

  // Mileage inline (C-GARAGE-08): Enter saves.
  await page.getByRole('button', { name: fa('garage.mileage.update') }).click();
  const mileage = page.getByLabel(fa('garage.mileage.new'));
  await mileage.fill('153000');
  await mileage.press('Enter');
  await expect(page.getByText(fa('garage.mileage.saved'))).toBeVisible();
  await expect(page.getByText('۱۵۳٬۰۰۰ کیلومتر').first()).toBeVisible();
  await expectNoAxeViolations(page);

  // W-GAR-02: a record with an invoice (PDF) and a photo through the upload kit.
  await page.getByRole('link', { name: fa('garage.quick.addRecord') }).click();
  await page.waitForURL(/\/records\/new$/);
  await page.locator('html[data-hydrated="true"]').waitFor({ state: 'attached' });
  await page.getByLabel(fa('garage.form.whatWasDone')).fill('تعویض لنت جلو و هر دو دیسک');
  const category = page.getByRole('combobox', { name: fa('garage.history.category'), exact: true });
  await expect(category.locator('option')).not.toHaveCount(1);
  await category.selectOption({ index: 1 });
  await page.getByRole('combobox', { name: 'تاریخ سال' }).selectOption('1405');
  await page.getByRole('combobox', { name: 'تاریخ ماه' }).selectOption('7');
  await page.getByRole('combobox', { name: 'تاریخ روز' }).selectOption('10');
  await page.getByLabel(fa('garage.form.cost'), { exact: true }).fill('4500000');
  await page.locator('input[type="file"]').setInputFiles([
    { name: 'invoice.pdf', mimeType: 'application/pdf', buffer: PDF },
    { name: 'pads.png', mimeType: 'image/png', buffer: png() },
  ]);
  await expect(page.locator('[data-upload-phase="ready"]')).toHaveCount(2, { timeout: 60_000 });
  await expectNoAxeViolations(page);
  await page.getByRole('button', { name: fa('common.actions.save') }).click();
  await page.waitForURL(/\/history$/);

  // The history table with the source mark; the drawer with both files previewed through signed URLs.
  const table = page.getByTestId('history-table');
  await expect(table.getByText(fa('garage.record.addedByYou'))).toBeVisible();
  await expect(table.locator('tbody tr')).toHaveCount(1);
  await expectNoAxeViolations(page);
  await table.locator('tbody tr').first().getByRole('button').click();
  const drawer = page.getByTestId('record-detail');
  await expect(drawer.locator('.pwa-evidence')).toHaveCount(2, { timeout: 30_000 });
  await drawer.locator('.pwa-evidence-open', { hasText: fa('garage.record.evidenceType.invoice') }).click();
  const pdfFrame = page.getByTestId('pdf-preview');
  await expect(pdfFrame).toHaveAttribute('src', /^blob:/);
  const download = page.waitForEvent('download');
  await page
    .getByRole('dialog', { name: fa('garage.record.evidenceType.invoice'), exact: true })
    .getByRole('button', { name: fa('media.download') })
    .click();
  expect((await download).suggestedFilename()).toMatch(/\.pdf$/);
  await page.keyboard.press('Escape');
  await drawer.locator('.pwa-evidence-open', { hasText: fa('garage.record.evidenceType.photo') }).click();
  const image = page.getByTestId('image-preview');
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // Buyer-friendly print view: the record, no full VIN or plate; print CSS hides the app shell.
  await gotoReady(page, `${vehicleUrl}/print`);
  const print = page.getByTestId('print-view');
  await expect(print.getByRole('heading', { name: fa('garage.print.title') })).toBeVisible();
  await expect(print.locator('tbody tr')).toHaveCount(1);
  await expectNoAxeViolations(page);
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.pwa-header')).toBeHidden();
  await expect(print.locator('tbody tr')).toBeVisible();
});

test('the server enforces the vehicle limit and W-GAR-03 shows the plan panel, keeping what was entered', async ({ page, request }) => {
  test.setTimeout(150_000);
  const user = await createUser(request);
  await signIn(page, user);
  await gotoReady(page, '/en/garage');
  // Five active cars through the BFF (same origin, CSRF token), the free plan's limit.
  const added = await page.evaluate(async () => {
    const csrf = ((await (await fetch('/bff/csrf')).json()) as { csrf_token: string }).csrf_token;
    const get = async (path: string) => (await (await fetch(`/api/v1${path}`)).json()) as { items: { id: string }[] };
    const brand = (await get('/taxonomy/nodes?type=vehicle_brand&limit=5')).items[0]!.id;
    const model = (await get(`/taxonomy/nodes?type=vehicle_model&parent_id=${brand}&limit=5`)).items[0]!.id;
    let created = 0;
    for (let i = 0; i < 5; i++) {
      const res = await fetch('/api/v1/me/vehicles', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({ brand_node_id: brand, model_node_id: model, year: 2010 + i, nickname: `Car ${i + 1}` }),
      });
      if (res.status === 201) created++;
    }
    return created;
  });
  expect(added).toBe(5);

  await gotoReady(page, '/en/garage/add');
  await fillCar(page, { brand: 'Brand', model: 'Model', year: 'Year' });
  await page.getByLabel('Nickname', { exact: true }).fill('Sixth');
  await page.getByRole('button', { name: 'Save' }).click();
  const panel = page.getByRole('dialog', { name: 'Vehicle limit' });
  await expect(panel).toBeVisible();
  await expect(panel.getByText('The free plan includes 5 active vehicles.')).toBeVisible();
  await expectNoAxeViolations(page);
  await panel.getByRole('button', { name: 'Mark as sold' }).first().click();
  await expect(page.getByText('Slot freed. Your entries are kept.').first()).toBeVisible();
  await expect(page.getByLabel('Nickname', { exact: true })).toHaveValue('Sixth');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.waitForURL(/\/en\/garage\/[0-9a-f-]{36}\/overview$/);
  await expect(page.getByRole('heading', { level: 2, name: 'Sixth' })).toBeVisible();
  await expect(page.getByTestId('plan-line')).toHaveText('5 of 5 vehicles on the free plan');
});
