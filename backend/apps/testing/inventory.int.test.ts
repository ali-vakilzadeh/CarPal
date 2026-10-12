// S5 vendor inventory and stock inquiries (40 §13): items with the SKU,
// price and entitlement rules, list sorts and body-paged search, fitment
// and AI-suggestion decisions, catalog quality on the vendor profile, trade
// accounts and trade-price visibility (acceptance: absent without an
// approved trade account), inquiries on both sides with the consent-gated
// vehicle snapshot, the CSV import (acceptance: a formula-injection row and
// an invalid row → the job succeeds with a formula-safe error report), bulk
// updates, W15 rules and record-level BOLA.
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jpegWithExif } from '#libs/testing/index.js';
import { TxRunner, type TenancyContext } from '#libs/tenancy/index.js';
import { InventoryRead } from '#modules/inventory/interface/inventory.js';
import { InquiryReservationRule } from '#modules/inventory/application/inventory-rules.js';
import { MediaHarness, taxonomyNodes, type Json, type Nodes } from './s4-support.js';
import { audits, client, newId, outbox, vehicleBody, type Client } from './s5-support.js';
import { createTestApp, type TestApp } from './test-app.js';

let app: TestApp;
let media: MediaHarness;
let n: Nodes;

beforeAll(async () => {
  app = await createTestApp({ host: 'api' });
  media = await MediaHarness.start(app);
  n = await taxonomyNodes(app);
});
afterAll(async () => {
  await media.close();
  await app.close();
});

const sku = () => `SKU-${newId().slice(-12)}`;
const item = (o: Json = {}) => ({
  sku: sku(),
  name_translations: { en: 'Front brake pad set', fa: 'لنت ترمز جلو' },
  part_origin: 'aftermarket',
  condition: 'new',
  part_category_node_id: n.partCategory,
  price_public: '450000',
  currency: 'IRR',
  price_on_request: false,
  stock_status: 'in_stock',
  visibility: 'public',
  status: 'active',
  ...o,
});
const location = () => ({
  address_line_1: '12 Bazaar Street',
  city: 'Tehran',
  country: 'IR',
  pin: { lat: 35.689198, lng: 51.388973 },
  public_address_visibility: 'exact',
  timezone: 'Asia/Tehran',
  is_primary: true,
});

interface Vendor {
  org: { id: string; type: 'vendor' };
  userId: string;
  token: string;
  c: Client;
  vnd: string;
}

/** A vendor organization with an owner and a plan; optionally published (with an active item, so the item counter is used). */
async function vendor(o: { plan?: string; publish?: boolean; trade?: boolean } = {}): Promise<Vendor> {
  const { user, org, token } = await app.fixtures.memberOf('vendor', 'vendor_owner');
  await app.fixtures.subscription(org, o.plan ?? 'vendor_basic');
  const c = client(app, token);
  const vnd = `/v1/orgs/${org.id}/vendor`;
  if (o.publish) {
    const profile = await c.put(
      `${vnd}/profile`,
      {
        vendor_type: 'parts_retailer',
        delivery_options: ['pickup'],
        trade_customers_supported: o.trade ?? true,
        default_price_visibility: 'public',
      },
      { 'idempotency-key': newId() },
    );
    if (profile.status !== 200) throw new Error(`profile ${profile.status} ${profile.text}`);
    await c.post(`/v1/orgs/${org.id}/locations`, location());
    const first = await c.post(`${vnd}/inventory`, item());
    if (first.status !== 201) throw new Error(`item ${first.status} ${first.text}`);
    const pub = await c.post(`${vnd}/publish`);
    if (pub.status !== 200) throw new Error(`publish ${pub.status} ${pub.text}`);
  }
  return { org: org as Vendor['org'], userId: user.id, token, c, vnd };
}

/** Reads in a given RLS context, as discovery (S6) will. */
function asContext<T>(ctx: TenancyContext, fn: (read: InventoryRead, scope: Parameters<Parameters<TxRunner['run']>[1]>[0]) => Promise<T>) {
  const tx = app.app.get(TxRunner, { strict: false });
  const read = app.app.get(InventoryRead, { strict: false });
  return tx.run(ctx, (scope) => fn(read, scope));
}

describe('items (40 §13.2)', () => {
  it('creates, validates, updates, lists, searches and removes items; the SKU is unique per vendor', async () => {
    const v = await vendor({ publish: true });
    const inv = `${v.vnd}/inventory`;
    const created = await v.c.post(
      inv,
      item({ price_trade: '400000', notes: 'Shelf B2', oem_numbers: ['04465-02220'], location_id: undefined }),
    );
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      vendor_organization_id: v.org.id,
      status: 'active',
      price_trade: '400000.00',
      notes: 'Shelf B2',
      oem_numbers: ['04465-02220'],
      normalized_name: 'front brake pad set',
      data_quality_score: 50,
      fitment_count: 0,
      media: [],
      duplicate_of_item_id: null,
    });
    expect((await outbox(app, v.org.id)).filter((e) => e.type === 'inventory.updated').length).toBeGreaterThanOrEqual(2);
    const dup = await v.c.post(inv, item({ sku: created.body.sku }));
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ code: 'DUPLICATE', errors: [{ pointer: '/sku', code: 'not_unique' }] });
    expect((await v.c.post(inv, item({ price_public: undefined }))).body.errors).toEqual([
      { pointer: '/price_public', code: 'conditional_required' },
    ]);
    expect((await v.c.post(inv, item({ currency: undefined }))).body.errors).toEqual([
      { pointer: '/currency', code: 'conditional_required' },
    ]);
    expect((await v.c.post(inv, item({ name_translations: { en: 'ab' } }))).body.errors).toEqual([
      { pointer: '/name_translations/en', code: 'too_short', limit: '3' },
    ]);
    expect((await v.c.post(inv, item({ location_id: newId() }))).body.code).toBe('REFERENCE_NOT_FOUND');
    expect((await v.c.post(inv, item({ part_category_node_id: n.brand }))).body.code).toBe('TAXONOMY_MISMATCH');
    expect(
      (await v.c.post(inv, item({ price_public: undefined, price_on_request: true, currency: undefined, status: 'draft' }))).status,
    ).toBe(201);

    const id = created.body.id as string;
    const upd = await v.c.patch(
      `${inv}/${id}`,
      { warranty_note: '6 months', description_translations: { en: 'Ceramic pads' }, stock_quantity: 4 },
      1,
    );
    expect(upd.status).toBe(200);
    expect(upd.body).toMatchObject({ warranty_note: '6 months', stock_quantity: 4, data_quality_score: 83, version: upd.body.version });
    expect((await v.c.patch(`${inv}/${id}`, { price_on_request: false, price_public: undefined }, 1)).status).toBe(412);

    // Images (media target "inventory_item") complete the data quality score and drive the missing_images filter.
    const img = await media.upload(v.token, {
      owner: { type: 'organization', id: v.org.id },
      purpose: 'inventory_image',
      mime: 'image/jpeg',
      bytes: await jpegWithExif(),
    });
    expect(
      (
        await v.c.post('/v1/media/attachments', {
          media_asset_id: img.id,
          attached_to: { type: 'inventory_item', id },
          role: 'gallery',
          display_order: 0,
        })
      ).status,
    ).toBe(201);
    const withImage = (await v.c.patch(`${inv}/${id}`, { brand: 'Brembo' }, upd.body.version)).body;
    expect(withImage).toMatchObject({ data_quality_score: 100 });
    expect(withImage.media).toHaveLength(1);
    expect((await v.c.get(`${inv}?missing_images=false`)).body.items.map((x: Json) => x.id)).toEqual([id]);
    expect((await v.c.get(`${inv}?missing_images=true`)).body.items.map((x: Json) => x.id)).not.toContain(id);

    // Sorts and keyset paging.
    const bySku = (await v.c.get(`${inv}?sort=sku_asc`)).body.items.map((x: Json) => x.sku);
    expect(bySku).toEqual([...bySku].sort());
    const p1 = await v.c.get(`${inv}?sort=quality_asc&limit=1`);
    const p2 = await v.c.get(`${inv}?sort=quality_asc&limit=1&cursor=${p1.body.next_cursor}`);
    expect(p2.body.items[0].data_quality_score).toBeGreaterThanOrEqual(p1.body.items[0].data_quality_score);
    expect(p2.body.items[0].id).not.toBe(p1.body.items[0].id);
    expect((await v.c.get(`${inv}?missing_fitment=true`)).body.items.map((x: Json) => x.id)).toContain(id);

    // Search pages in the body (40 §3.3): the cursor is bound to the text.
    const s1 = await v.c.post(`${inv}/search`, { text: 'brake pad', limit: 1 });
    expect(s1.status).toBe(200);
    expect(s1.body.items).toHaveLength(1);
    const s2 = await v.c.post(`${inv}/search`, { text: 'brake pad', limit: 1, cursor: s1.body.next_cursor });
    expect(s2.body.items[0].id).not.toBe(s1.body.items[0].id);
    expect((await v.c.post(`${inv}/search`, { text: 'other', cursor: s1.body.next_cursor })).body.code).toBe('CURSOR_MISMATCH');
    expect((await v.c.post(`${inv}/search`, { text: '04465' })).body.items.map((x: Json) => x.id)).toEqual([id]);
    expect((await v.c.post(`${inv}/search`, { text: created.body.sku.slice(-6).toLowerCase() })).body.items.map((x: Json) => x.id)).toEqual(
      [id],
    );

    const other = (await v.c.post(inv, item())).body;
    expect((await v.c.post(`${inv}/${other.id}/duplicate`, { duplicate_of_item_id: id })).body.duplicate_of_item_id).toBe(id);
    expect((await v.c.post(`${inv}/${other.id}/duplicate`, { duplicate_of_item_id: other.id })).body.code).toBe('REFERENCE_NOT_FOUND');
    expect((await v.c.post(`${inv}/${other.id}/duplicate`, { duplicate_of_item_id: null })).body.duplicate_of_item_id).toBeNull();

    expect((await v.c.del(`${inv}/${id}`)).status).toBe(200);
    expect((await v.c.get(`${inv}/${id}`)).status).toBe(404);
    expect(await audits(app, id)).toContain('inventory.item_removed');
    // The SKU is free again after removal.
    expect((await v.c.post(inv, item({ sku: created.body.sku }))).status).toBe(201);
    // Catalog quality reaches the vendor profile (54 §7.2).
    expect((await v.c.get(`${v.vnd}/profile`)).body.catalog_quality_score).toBeGreaterThan(0);
  });

  it('limits active items by max_inventory_items (provider plans have none)', async () => {
    // A hybrid organization on the provider plan (DI-20): a vendor member, but no inventory entitlement.
    const org = await app.fixtures.org('hybrid_provider_vendor');
    await app.fixtures.subscription(org, 'provider_basic');
    const owner = await app.fixtures.user();
    await app.fixtures.member(owner, org, 'vendor_owner');
    const c = client(app, await app.fixtures.token(owner));
    const active = await c.post(`/v1/orgs/${org.id}/vendor/inventory`, item());
    expect(active.status).toBe(409);
    expect(active.body.code).toBe('INVENTORY_LIMIT_REACHED');
    const draft = await c.post(`/v1/orgs/${org.id}/vendor/inventory`, item({ status: 'draft' }));
    expect(draft.status).toBe(403);
    expect(draft.body).toMatchObject({ code: 'ENTITLEMENT_REQUIRED', entitlement_key: 'max_inventory_items' });
  });
});

describe('fitment (40 §13.2, 54 §7.1)', () => {
  it('adds vendor rows with per-row skips, edits and deactivates them, and decides AI suggestions', async () => {
    const v = await vendor();
    const it0 = (await v.c.post(`${v.vnd}/inventory`, item())).body;
    const fit = `${v.vnd}/inventory/${it0.id}/fitment`;
    const res = await v.c.post(fit, {
      items: [
        { brand_node_id: n.brand, model_node_id: n.model, year_start: 2015, year_end: 2020, confidence: 'confirmed' },
        { brand_node_id: n.brand, series_node_id: n.series, confidence: 'likely' },
        { brand_node_id: n.brand, year_start: 2020, year_end: 2010, confidence: 'likely' },
        { brand_node_id: n.brand, model_node_id: n.otherModel, confidence: 'likely' },
        { brand_node_id: n.brand, model_node_id: n.model, year_start: 2015, year_end: 2020, confidence: 'uncertain' },
        { brand_node_id: n.brand, confidence: 'uncertain' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.created.map((f: Json) => [f.confidence, f.source, f.status, f.confirmed_by])).toEqual([
      ['confirmed', 'manual', 'active', v.userId],
      ['uncertain', 'manual', 'active', null],
    ]);
    expect(res.body.skipped).toEqual([
      { index: 1, code: 'conditional_required' },
      { index: 2, code: 'order' },
      { index: 3, code: 'reference_not_found' },
      { index: 4, code: 'not_unique' },
    ]);
    expect((await v.c.get(`${v.vnd}/inventory/${it0.id}`)).body.fitment_count).toBe(2);
    const [confirmed, uncertain] = res.body.created as Json[];
    const lowered = await v.c.patch(`${fit}/${confirmed!.id}`, { confidence: 'likely' }, confirmed!.version);
    expect(lowered.body).toMatchObject({ confidence: 'likely', confirmed_by: null });
    expect((await v.c.patch(`${fit}/${uncertain!.id}`, { model_node_id: n.otherModel }, uncertain!.version)).body.code).toBe(
      'TAXONOMY_MISMATCH',
    );
    expect((await v.c.del(`${fit}/${uncertain!.id}`)).status).toBe(200);
    expect((await v.c.get(fit)).body.items.map((f: Json) => f.id)).toEqual([confirmed!.id]);

    // An AI suggestion (S9 writes these): pending until the vendor decides; only confirmation sets "confirmed".
    const suggestion = newId();
    await app.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
      db
        .insertInto('inventory.inventory_fitment')
        .values({
          id: suggestion,
          inventory_item_id: it0.id,
          brand_node_id: n.brand,
          model_node_id: n.model,
          confidence: 'likely',
          source: 'ai_suggested',
          ai_insight_id: newId(),
          status: 'pending_vendor_confirmation',
        })
        .execute(),
    );
    expect((await v.c.get(`${fit}?status=pending_vendor_confirmation`)).body.items.map((f: Json) => f.id)).toEqual([suggestion]);
    const decided = await v.c.post(`${fit}/${suggestion}/decision`, { decision: 'confirm' });
    expect(decided.body).toMatchObject({ status: 'active', confidence: 'confirmed', source: 'ai_suggested', confirmed_by: v.userId });
    expect((await v.c.post(`${fit}/${suggestion}/decision`, { decision: 'reject' })).body).toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(await audits(app, suggestion)).toEqual(['inventory.fitment_confirmed']);
  });
});

describe('trade accounts and trade prices (S5 acceptance)', () => {
  it('trade prices and trade-only items reach only members of an organization with an approved trade account', async () => {
    const v = await vendor({ publish: true, trade: true });
    const inv = `${v.vnd}/inventory`;
    const pub = (await v.c.post(inv, item({ price_public: '100', price_trade: '80' }))).body;
    const tradeOnly = (await v.c.post(inv, item({ price_public: '200', price_trade: '150', visibility: 'trade_only' }))).body;
    const shop = await app.fixtures.memberOf('provider', 'provider_owner');
    const stranger = await app.fixtures.memberOf('provider', 'provider_owner');
    const cards = (ctx: TenancyContext) =>
      asContext(ctx, (read, scope) => read.publicCards(scope, [pub.id, tradeOnly.id], { locale: 'en' }));
    const shopCtx: TenancyContext = { actorType: 'user', userId: shop.user.id, orgId: shop.org.id };
    const strangerCtx: TenancyContext = { actorType: 'user', userId: stranger.user.id, orgId: stranger.org.id };

    const anon = await cards({ actorType: 'anonymous' });
    expect([...anon.keys()]).toEqual([pub.id]);
    expect(anon.get(pub.id)!.price).toEqual({ amount: '100.00', currency: 'IRR' });
    expect(JSON.stringify([...anon.values()])).not.toContain('80.00');

    const s = client(app, shop.token);
    const request = await s.post(`/v1/orgs/${shop.org.id}/trade-accounts`, {
      vendor_organization_id: v.org.id,
      notes: 'Workshop on Valiasr',
    });
    expect(request.status).toBe(201);
    expect(request.body).toMatchObject({
      status: 'requested',
      vendor: { id: v.org.id },
      trade_customer: { id: shop.org.id },
      approved_at: null,
    });
    expect((await s.post(`/v1/orgs/${shop.org.id}/trade-accounts`, { vendor_organization_id: v.org.id })).status).toBe(409);
    const noTrade = await vendor({ publish: true, trade: false });
    expect((await s.post(`/v1/orgs/${shop.org.id}/trade-accounts`, { vendor_organization_id: noTrade.org.id })).body).toMatchObject({
      code: 'REFERENCE_NOT_FOUND',
      errors: [{ pointer: '/vendor_organization_id', code: 'reference_not_found' }],
    });
    // Requested is not approved: still public prices only.
    expect([...(await cards(shopCtx)).keys()]).toEqual([pub.id]);

    const decided = await v.c.post(`${v.vnd}/trade-accounts/${request.body.id}/decision`, { decision: 'approve' });
    expect(decided.body).toMatchObject({ status: 'approved' });
    expect(await audits(app, request.body.id)).toEqual(['inventory.trade_account_approved']);
    const trade = await cards(shopCtx);
    expect(trade.get(pub.id)!.price).toEqual({ amount: '80.00', currency: 'IRR' });
    expect(trade.get(tradeOnly.id)!.price).toEqual({ amount: '150.00', currency: 'IRR' });
    const detail = await asContext(shopCtx, (read, scope) => read.publicItem(scope, tradeOnly.id, { locale: 'en' }));
    expect(detail).toMatchObject({ is_trade_price: true, vendor_organization_id: v.org.id });
    // Another organization and anonymous callers still see neither.
    const others = await cards(strangerCtx);
    expect([...others.keys()]).toEqual([pub.id]);
    expect(JSON.stringify([...others.values()])).not.toMatch(/80\.00|150\.00/);
    expect(await asContext({ actorType: 'anonymous' }, (read, scope) => read.publicItem(scope, tradeOnly.id, { locale: 'en' }))).toBeNull();

    expect((await s.get(`/v1/orgs/${shop.org.id}/trade-accounts`)).body.items.map((t: Json) => t.status)).toEqual(['approved']);
    expect((await v.c.get(`${v.vnd}/trade-accounts?status=approved`)).body.items).toHaveLength(1);
    expect((await v.c.post(`${v.vnd}/trade-accounts/${request.body.id}/decision`, { decision: 'reject' })).body.code).toBe(
      'INVALID_TRANSITION',
    );
    await v.c.post(`${v.vnd}/trade-accounts/${request.body.id}/decision`, { decision: 'revoke' });
    expect([...(await cards(shopCtx)).keys()]).toEqual([pub.id]);
    expect((await cards(shopCtx)).get(pub.id)!.price!.amount).toBe('100.00');
  });
});

describe('stock inquiries (40 §13.2-13.3)', () => {
  it("runs an inquiry with a shared vehicle context: consent-gated snapshot, messages, both sides' transitions and the review eligibility", async () => {
    const v = await vendor({ publish: true });
    const it0 = (await v.c.post(`${v.vnd}/inventory`, item({ stock_quantity: 3 }))).body;
    const user = await app.fixtures.user();
    const c = client(app, await app.fixtures.token(user));
    const car = (await c.post('/v1/me/vehicles', vehicleBody(n, { vin: undefined, license_plate: '99B999-11' }))).body;
    const created = await c.post('/v1/me/inquiries', {
      inventory_item_id: it0.id,
      quantity: 2,
      message: 'Do these fit my car?',
      content_locale: 'en',
      share_vehicle_context: { vehicle_id: car.id, policy_version: '2026-10' },
    });
    expect(created.status).toBe(201);
    const q = created.body;
    expect(q).toMatchObject({
      inventory_item: { id: it0.id, sku: it0.sku, name: { text: 'Front brake pad set', locale: 'en' } },
      vendor: { id: v.org.id },
      requester_type: 'user',
      status: 'sent',
      quantity: 2,
      can_review: false,
      vehicle_context_snapshot: { year: 2019, series: null, engine: null },
    });
    expect(q.vehicle_context_snapshot.brand.text).toBeTruthy();
    expect(created.text).not.toContain('99B999');
    expect((await outbox(app, q.id)).map((e) => e.type)).toEqual(['inquiry.sent']);
    expect((await c.post('/v1/me/inquiries', { inventory_item_id: it0.id, message: 'Again', content_locale: 'en' })).body.code).toBe(
      'DUPLICATE',
    );

    // Vendor side: grouped list, the snapshot while the consent is granted, and the thread.
    const vq = `${v.vnd}/inquiries/${q.id}`;
    expect((await v.c.get(`${v.vnd}/inquiries?group=open`)).body.items.map((x: Json) => x.id)).toEqual([q.id]);
    const seen = (await v.c.get(vq)).body;
    expect(seen.inquiry.vehicle_context_snapshot).toMatchObject({ year: 2019 });
    expect(seen.messages.map((m: Json) => [m.author_side, m.body])).toEqual([['requester', 'Do these fit my car?']]);
    const reply = await v.c.post(`${vq}/messages`, { body: 'Yes, two sets in stock.', content_locale: 'en' });
    expect(reply.status).toBe(201);
    expect(reply.body).toMatchObject({ author_side: 'vendor', author_display: expect.stringContaining('Test vendor') });
    const answered = (await v.c.get(vq)).body.inquiry;
    expect(answered.status).toBe('answered');
    expect(answered.first_response_at).not.toBeNull();
    expect(answered.last_message_at).not.toBeNull();
    const tooFar = new Date(Date.now() + 15 * 86_400_000).toISOString();
    expect((await v.c.post(`${vq}/transitions`, { to: 'reserved', reserved_until: tooFar })).body.errors).toEqual([
      { pointer: '/reserved_until', code: 'out_of_range' },
    ]);
    expect((await v.c.post(`${vq}/transitions`, { to: 'reserved' })).body.errors).toEqual([
      { pointer: '/reserved_until', code: 'conditional_required' },
    ]);
    const until = new Date(Date.now() + 2 * 86_400_000).toISOString();
    expect((await v.c.post(`${vq}/transitions`, { to: 'reserved', reserved_until: until })).body).toMatchObject({ status: 'reserved' });
    expect((await v.c.post(`${vq}/transitions`, { to: 'cancelled' })).body.code).toBe('INVALID_TRANSITION');

    // The requester withdraws the vehicle consent: the vendor no longer sees the snapshot (SEC-AZ-8).
    const consents = (await c.get('/v1/me/consents?consent_type=vendor_fitment_context')).body.items as Json[];
    expect(consents.map((x) => [x.scope_entity_type, x.scope_entity_id, x.granted_to_id])).toEqual([['stock_inquiry', q.id, v.org.id]]);
    expect((await c.post(`/v1/me/consents/${consents[0]!.id}/withdraw`)).status).toBe(200);
    expect((await v.c.get(vq)).body.inquiry.vehicle_context_snapshot).toBeNull();
    expect((await c.get(`/v1/me/inquiries/${q.id}`)).body.inquiry.vehicle_context_snapshot).not.toBeNull();

    // "I picked it up": the requester completes; the inquiry is closed and reviewable (Path 1).
    const done = await c.post(`/v1/me/inquiries/${q.id}/transitions`, { to: 'completed' });
    expect(done.body).toMatchObject({ status: 'completed', closed_by_side: 'requester', can_review: true });
    expect(done.body.closed_at).not.toBeNull();
    expect((await c.post(`/v1/me/inquiries/${q.id}/messages`, { body: 'Thanks', content_locale: 'en' })).body).toMatchObject({
      code: 'INVALID_TRANSITION',
    });
    expect((await v.c.post(`${vq}/transitions`, { to: 'answered' })).body.code).toBe('INVALID_TRANSITION');
    expect((await c.get('/v1/me/inquiries?status=completed')).body.items.map((x: Json) => x.id)).toEqual([q.id]);
    // Vendor insights read the inquiry figures (organization extension sources).
    const today = new Date().toISOString().slice(0, 10);
    const ins = (await v.c.get(`${v.vnd}/insights?from=${today}&to=${today}`)).body;
    expect(ins).toMatchObject({ inquiries_received: 1, inquiry_fulfillment_rate: '1.0000', items_missing_fitment: 2 });
    expect(ins.measured_response_time_minutes).toBe(0);
  });

  it('refuses hidden, trade-only and unpublished items, needs a verified contact, and lets a provider inquire as its organization', async () => {
    const v = await vendor({ publish: true });
    const unpublished = await vendor();
    const hidden = (await v.c.post(`${v.vnd}/inventory`, item({ visibility: 'hidden' }))).body;
    const tradeOnly = (await v.c.post(`${v.vnd}/inventory`, item({ visibility: 'trade_only' }))).body;
    const elsewhere = (await unpublished.c.post(`${unpublished.vnd}/inventory`, item())).body;
    const user = await app.fixtures.user();
    const c = client(app, await app.fixtures.token(user));
    for (const id of [hidden.id, tradeOnly.id, elsewhere.id, newId()])
      expect((await c.post('/v1/me/inquiries', { inventory_item_id: id, message: 'Available?', content_locale: 'en' })).body).toMatchObject(
        {
          code: 'REFERENCE_NOT_FOUND',
          errors: [{ pointer: '/inventory_item_id', code: 'reference_not_found' }],
        },
      );
    const someoneElsesCar = await app.fixtures.vehicle(await app.fixtures.user(), n);
    const pub = (await v.c.post(`${v.vnd}/inventory`, item())).body;
    expect(
      (
        await c.post('/v1/me/inquiries', {
          inventory_item_id: pub.id,
          message: 'Fit?',
          content_locale: 'en',
          share_vehicle_context: { vehicle_id: someoneElsesCar, policy_version: '2026-10' },
        })
      ).body.errors,
    ).toEqual([{ pointer: '/share_vehicle_context/vehicle_id', code: 'reference_not_found' }]);
    // An account still pending verification (an active account always has a verified contact, DB rule).
    const unverified = await app.fixtures.user();
    await app.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
      db
        .updateTable('identity.user_accounts')
        .set({ email_verified_at: null, status: 'pending_verification' })
        .where('id', '=', unverified.id)
        .execute(),
    );
    expect(
      (
        await client(app, await app.fixtures.token(unverified)).post('/v1/me/inquiries', {
          inventory_item_id: pub.id,
          message: 'Hi',
          content_locale: 'en',
        })
      ).body.code,
    ).toBe('VERIFIED_CONTACT_REQUIRED');

    // A provider with an approved trade account inquires about a trade-only item as its organization.
    const shop = await app.fixtures.memberOf('provider', 'provider_staff');
    const owner = await app.fixtures.user();
    await app.fixtures.member(owner, shop.org, 'provider_owner');
    const account = (
      await client(app, await app.fixtures.token(owner)).post(`/v1/orgs/${shop.org.id}/trade-accounts`, {
        vendor_organization_id: v.org.id,
      })
    ).body;
    await v.c.post(`${v.vnd}/trade-accounts/${account.id}/decision`, { decision: 'approve' });
    const s = client(app, shop.token);
    const q = await s.post(`/v1/orgs/${shop.org.id}/inquiries`, {
      inventory_item_id: tradeOnly.id,
      message: 'Price for 10?',
      content_locale: 'en',
      quantity: 10,
    });
    expect(q.status).toBe(201);
    expect(q.body).toMatchObject({
      requester_type: 'provider',
      requester_display: expect.stringContaining('Test provider'),
      vehicle_context_snapshot: null,
    });
    expect((await s.get(`/v1/orgs/${shop.org.id}/inquiries`)).body.items.map((x: Json) => x.id)).toEqual([q.body.id]);
    // The requester's personal inquiries are separate from the organization's.
    expect((await client(app, shop.token).get('/v1/me/inquiries')).body.items).toEqual([]);
    // After the vendor hides the item, the requester still sees what it asked about.
    await v.c.patch(`${v.vnd}/inventory/${tradeOnly.id}`, { visibility: 'hidden' }, tradeOnly.version);
    expect((await s.get(`/v1/orgs/${shop.org.id}/inquiries/${q.body.id}`)).body.inquiry.inventory_item.sku).toBe(tradeOnly.sku);
    // The requester cannot use vendor transitions, and the vendor side releases an expired reservation (W15).
    expect((await s.post(`/v1/orgs/${shop.org.id}/inquiries/${q.body.id}/transitions`, { to: 'completed' })).body.code).toBe(
      'INVALID_TRANSITION',
    );
    await v.c.post(`${v.vnd}/inquiries/${q.body.id}/transitions`, {
      to: 'reserved',
      reserved_until: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await app.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
      db
        .updateTable('inventory.stock_inquiries')
        .set({ reserved_until: sql<Date>`now() - interval '1 minute'` })
        .where('id', '=', q.body.id)
        .execute(),
    );
    expect(await media.worker.get(InquiryReservationRule).run()).toBeGreaterThanOrEqual(1);
    expect((await v.c.get(`${v.vnd}/inquiries/${q.body.id}`)).body.inquiry).toMatchObject({ status: 'answered', reserved_until: null });
  });
});

describe('CSV import (S5 acceptance) and bulk updates (W7)', () => {
  it('imports with a formula-injection row and an invalid row: the job succeeds with a formula-safe error report', async () => {
    const v = await vendor({ plan: 'vendor_pro' });
    const existing = (await v.c.post(`${v.vnd}/inventory`, item({ sku: `UPD-${newId().slice(-8)}`, price_public: '100' }))).body;
    const s1 = sku();
    const s2 = sku();
    const csv = [
      'SKU,Name,Category,Price,Currency,Origin,Condition,Stock,OEM',
      `${s1},Oil filter,${n.partCategory},120000,IRR,oem,new,in_stock,90915-YZZE1|90915-10003`,
      `${s2},"=HYPERLINK(""http://evil.example"",""click"")",${n.partCategory},99000,irr,aftermarket,used,low_stock,`,
      `"=cmd|' /C calc'!A0",,${n.partCategory},abc,IRR,oem,new,in_stock,`,
      `${existing.sku},,,,,,,out_of_stock,`,
    ].join('\r\n');
    const file = await media.upload(v.token, {
      owner: { type: 'organization', id: v.org.id },
      purpose: 'inventory_import_csv',
      mime: 'text/csv',
      bytes: Buffer.from(csv),
    });
    expect(file.scan_status).toBe('clean');
    const mapping = [
      { column: 'SKU', field: 'sku' },
      { column: 'Name', field: 'name_translations.en' },
      { column: 'Category', field: 'part_category_node_id' },
      { column: 'Price', field: 'price_public' },
      { column: 'Currency', field: 'currency' },
      { column: 'Origin', field: 'part_origin' },
      { column: 'Condition', field: 'condition' },
      { column: 'Stock', field: 'stock_status' },
      { column: 'OEM', field: 'oem_numbers' },
    ];
    expect(
      (
        await v.c.post(`${v.vnd}/inventory/imports`, {
          source_media_asset_id: file.id,
          column_mapping: [{ column: 'SKU', field: 'secret' }],
          ai_normalization_requested: false,
        })
      ).body.errors,
    ).toEqual([
      { pointer: '/column_mapping/0/field', code: 'enum' },
      { pointer: '/column_mapping', code: 'conditional_required' },
    ]);
    const job = await v.c.post(`${v.vnd}/inventory/imports`, {
      source_media_asset_id: file.id,
      column_mapping: mapping,
      ai_normalization_requested: true,
    });
    expect(job.status).toBe(202);
    expect(job.body).toMatchObject({ kind: 'inventory_import', status: 'queued' });
    await media.drain();
    const done = (await v.c.get(`/v1/jobs/${job.body.id}`)).body;
    expect(done).toMatchObject({ status: 'succeeded', progress: 100, result: { type: 'inventory_import_batch' } });
    const batchId = done.result.id as string;
    const batch = (await v.c.get(`${v.vnd}/inventory/imports/${batchId}`)).body;
    expect(batch).toMatchObject({
      status: 'completed_with_errors',
      total_rows: 4,
      created_count: 2,
      updated_count: 1,
      error_count: 1,
      error_report_available: true,
      source_media_asset_id: file.id,
    });
    expect((await v.c.get(`${v.vnd}/inventory/imports`)).body.items.map((b: Json) => b.id)).toEqual([batchId]);

    // The formula row is stored as plain data; the update row changed only its stock status.
    const items = (await v.c.post(`${v.vnd}/inventory/search`, { text: s2 })).body.items;
    expect(items[0]).toMatchObject({
      name_translations: { en: '=HYPERLINK("http://evil.example","click")' },
      currency: 'IRR',
      condition: 'used',
      import_batch_id: batchId,
      status: 'draft',
    });
    expect((await v.c.post(`${v.vnd}/inventory/search`, { text: s1 })).body.items[0]).toMatchObject({
      oem_numbers: ['90915-YZZE1', '90915-10003'],
      part_origin: 'oem',
    });
    expect((await v.c.get(`${v.vnd}/inventory/${existing.id}`)).body).toMatchObject({
      stock_status: 'out_of_stock',
      price_public: '100.00',
      import_batch_id: batchId,
    });

    // The error report: 5-minute attachment URL, formula cells neutralized (SEC-IN-11).
    const report = await v.c.post(`${v.vnd}/inventory/imports/${batchId}/error-report`);
    expect(report.status).toBe(200);
    const text = await (await fetch(media.local(report.body.url))).text();
    const lines = text.trim().split('\r\n');
    expect(lines[0]).toBe('line,field,code,SKU,Name,Category,Price,Currency,Origin,Condition,Stock,OEM');
    expect(lines.slice(1).every((l) => l.startsWith('4,'))).toBe(true);
    expect(text).toContain(`'=cmd|' /C calc'!A0`);
    expect(text).not.toMatch(/,=cmd/);
    expect(text).toContain('/price_public,pattern');
    expect((await outbox(app, batchId)).map((e) => [e.type, e.payload.created_count, e.payload.error_count])).toEqual([
      ['vendor.inventory.imported', 2, 1],
    ]);

    // A batch without errors has no report.
    const clean = await media.upload(v.token, {
      owner: { type: 'organization', id: v.org.id },
      purpose: 'inventory_import_csv',
      mime: 'text/csv',
      bytes: Buffer.from(`SKU,Stock\r\n${s1},low_stock\r\n`),
    });
    const job2 = await v.c.post(`${v.vnd}/inventory/imports`, {
      source_media_asset_id: clean.id,
      column_mapping: [
        { column: 'SKU', field: 'sku' },
        { column: 'Stock', field: 'stock_status' },
      ],
      ai_normalization_requested: false,
    });
    await media.drain();
    const b2 = (await v.c.get(`/v1/jobs/${job2.body.id}`)).body.result.id;
    expect((await v.c.get(`${v.vnd}/inventory/imports/${b2}`)).body).toMatchObject({
      status: 'completed',
      updated_count: 1,
      error_report_available: false,
    });
    expect((await v.c.post(`${v.vnd}/inventory/imports/${b2}/error-report`)).status).toBe(404);
    // A mapped column missing from the file fails the batch.
    const job3 = await v.c.post(`${v.vnd}/inventory/imports`, {
      source_media_asset_id: clean.id,
      column_mapping: [{ column: 'Code', field: 'sku' }],
      ai_normalization_requested: false,
    });
    await media.drain();
    expect((await v.c.get(`/v1/jobs/${job3.body.id}`)).body).toMatchObject({ status: 'failed', error_code: 'VALIDATION_FAILED' });
  });

  it('needs the bulk-import entitlement and a clean CSV of the vendor', async () => {
    const basic = await vendor({ plan: 'vendor_basic' });
    const file = await media.upload(basic.token, {
      owner: { type: 'organization', id: basic.org.id },
      purpose: 'inventory_import_csv',
      mime: 'text/csv',
      bytes: Buffer.from('SKU\r\nA\r\n'),
    });
    const res = await basic.c.post(`${basic.vnd}/inventory/imports`, {
      source_media_asset_id: file.id,
      column_mapping: [{ column: 'SKU', field: 'sku' }],
      ai_normalization_requested: false,
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'ENTITLEMENT_REQUIRED', entitlement_key: 'inventory_bulk_import_enabled' });
    const pro = await vendor({ plan: 'vendor_pro' });
    expect(
      (
        await pro.c.post(`${pro.vnd}/inventory/imports`, {
          source_media_asset_id: file.id,
          column_mapping: [{ column: 'SKU', field: 'sku' }],
          ai_normalization_requested: false,
        })
      ).body.code,
    ).toBe('REFERENCE_NOT_FOUND');
  });

  it('bulk updates up to 500 items in one background job', async () => {
    const v = await vendor();
    const a = (await v.c.post(`${v.vnd}/inventory`, item())).body;
    const b = (await v.c.post(`${v.vnd}/inventory`, item({ status: 'draft' }))).body;
    const job = await v.c.post(`${v.vnd}/inventory/bulk`, {
      item_ids: [a.id, b.id, newId()],
      patch: { stock_status: 'out_of_stock', visibility: 'hidden' },
    });
    expect(job.status).toBe(202);
    expect(job.body.kind).toBe('bulk_inventory_update');
    await media.drain();
    const finished = (await v.c.get(`/v1/jobs/${job.body.id}`)).body;
    expect(finished).toMatchObject({ status: 'succeeded', progress: 100 });
    expect(finished).not.toHaveProperty('result');
    for (const id of [a.id, b.id])
      expect((await v.c.get(`${v.vnd}/inventory/${id}`)).body).toMatchObject({ stock_status: 'out_of_stock', visibility: 'hidden' });
    expect((await outbox(app, v.org.id)).some((e) => e.type === 'inventory.updated' && e.payload.change === 'bulk_update')).toBe(true);
    expect((await v.c.post(`${v.vnd}/inventory/bulk`, { item_ids: [a.id], patch: {} })).status).toBe(422);
  });
});

describe('record-level BOLA: vendor B records under vendor A paths', () => {
  it('404 for items, fitment, imports, inquiries and trade accounts of another vendor', async () => {
    const a = await vendor();
    const b = await vendor({ publish: true, plan: 'vendor_pro' });
    const bItem = (await b.c.post(`${b.vnd}/inventory`, item())).body;
    const bFit = (await b.c.post(`${b.vnd}/inventory/${bItem.id}/fitment`, { items: [{ brand_node_id: n.brand, confidence: 'likely' }] }))
      .body.created[0];
    const file = await media.upload(b.token, {
      owner: { type: 'organization', id: b.org.id },
      purpose: 'inventory_import_csv',
      mime: 'text/csv',
      bytes: Buffer.from('SKU\r\nZ\r\n'),
    });
    const job = await b.c.post(`${b.vnd}/inventory/imports`, {
      source_media_asset_id: file.id,
      column_mapping: [{ column: 'SKU', field: 'sku' }],
      ai_normalization_requested: false,
    });
    await media.drain();
    const batchId = (await b.c.get(`/v1/jobs/${job.body.id}`)).body.result.id;
    const user = await app.fixtures.user();
    const inquiry = (
      await client(app, await app.fixtures.token(user)).post('/v1/me/inquiries', {
        inventory_item_id: bItem.id,
        message: 'In stock?',
        content_locale: 'en',
      })
    ).body;
    const shop = await app.fixtures.memberOf('provider', 'provider_owner');
    const trade = (await client(app, shop.token).post(`/v1/orgs/${shop.org.id}/trade-accounts`, { vendor_organization_id: b.org.id })).body;
    const base = a.vnd;
    const calls: [keyof Client, string, unknown?][] = [
      ['get', `${base}/inventory/${bItem.id}`],
      ['patch', `${base}/inventory/${bItem.id}`, { brand: 'x' }],
      ['del', `${base}/inventory/${bItem.id}`],
      ['post', `${base}/inventory/${bItem.id}/duplicate`, { duplicate_of_item_id: null }],
      ['get', `${base}/inventory/${bItem.id}/fitment`],
      ['post', `${base}/inventory/${bItem.id}/fitment`, { items: [{ brand_node_id: n.brand, confidence: 'likely' }] }],
      ['patch', `${base}/inventory/${bItem.id}/fitment/${bFit.id}`, { notes: 'x' }],
      ['post', `${base}/inventory/${bItem.id}/fitment/${bFit.id}/decision`, { decision: 'confirm' }],
      ['get', `${base}/inventory/imports/${batchId}`],
      ['post', `${base}/inventory/imports/${batchId}/error-report`],
      ['get', `${base}/inquiries/${inquiry.id}`],
      ['post', `${base}/inquiries/${inquiry.id}/messages`, { body: 'x', content_locale: 'en' }],
      ['post', `${base}/inquiries/${inquiry.id}/transitions`, { to: 'answered' }],
      ['post', `${base}/trade-accounts/${trade.id}/decision`, { decision: 'approve' }],
    ];
    for (const [method, path, body] of calls) {
      const res =
        method === 'patch'
          ? await a.c.patch(path, body, 1)
          : method === 'post'
            ? await a.c.post(path, body)
            : method === 'del'
              ? await a.c.del(path)
              : await a.c.get(path);
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    for (const path of [`${base}/inventory`, `${base}/inventory/imports`, `${base}/inquiries`, `${base}/trade-accounts`])
      expect((await a.c.get(path)).body.items, path).toEqual([]);
    expect((await a.c.post(`${base}/inventory/search`, { text: bItem.sku })).body.items).toEqual([]);
    // A bulk update naming B's items changes nothing of B.
    const job2 = await a.c.post(`${base}/inventory/bulk`, { item_ids: [bItem.id], patch: { stock_status: 'out_of_stock' } });
    await media.drain();
    expect((await a.c.get(`/v1/jobs/${job2.body.id}`)).body.status).toBe('succeeded');
    expect((await b.c.get(`${b.vnd}/inventory/${bItem.id}`)).body.stock_status).toBe('in_stock');
  });
});
