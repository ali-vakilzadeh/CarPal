// Contract sweep resolvers: vendor inventory, fitment, imports, trade accounts
// and stock inquiries (40 §13), public inventory reads (§14.3). Trade prices
// reach only the vendor's members and organizations with an approved trade
// account (SEC-OUT-1, 40 Appendix C.4).
import type { Route } from '#libs/contract/index.js';
import { expect } from 'vitest';
import { vehicleBody } from '../../s5-support.js';
import { ok, type Actor, type Harness, type Json, type Resolvers } from '../harness.js';

const item = (h: Harness, o: Json = {}) => ({
  sku: `SW-${h.newId().slice(-12)}`,
  name_translations: { en: 'Front brake pad set', fa: 'لنت ترمز جلو' },
  part_origin: 'aftermarket',
  condition: 'new',
  part_category_node_id: h.n.partCategory,
  price_public: '450000',
  currency: 'IRR',
  price_on_request: false,
  stock_status: 'in_stock',
  visibility: 'public',
  status: 'active',
  ...o,
});

const inv = (v: Actor) => `/v1/orgs/${v.org!.id}/vendor/inventory`;

/** A vendor owner (or a member with `role`) on a plan, with no published profile. */
async function vendor(h: Harness, o: { plan?: string; role?: string } = {}): Promise<Actor> {
  const owner = await h.member('vendor');
  await h.fx.subscription(owner.org!, o.plan ?? 'vendor_basic');
  return o.role && o.role !== 'vendor_owner' ? h.colleague(owner, o.role) : owner;
}

async function newItem(h: Harness, v: Actor, o: Json = {}): Promise<Json> {
  return ok(await v.c.post(inv(v), item(h, o)), 'inventory item');
}

/** A finished import batch with one invalid row (an error report exists). */
async function importBatch(h: Harness): Promise<{ v: Actor; batchId: string }> {
  const v = await vendor(h, { plan: 'vendor_pro' });
  const csv = [
    'SKU,Name,Category,Price,Currency',
    `SW-${h.newId().slice(-10)},Oil filter,${h.n.partCategory},120000,IRR`,
    `,Missing SKU,${h.n.partCategory},abc,IRR`,
  ].join('\r\n');
  const file = await h.upload(v, 'inventory_import_csv', { mime: 'text/csv', bytes: Buffer.from(csv) });
  const job = ok(await v.c.post(`${inv(v)}/imports`, importBody(file.id as string)), 'import');
  await h.infra.jobs.idle();
  const done = ok(await v.c.get(`/v1/jobs/${job.id}`), 'import job');
  if (done.status !== 'succeeded') throw new Error(`import job ${JSON.stringify(done)}`);
  return { v, batchId: done.result.id as string };
}

const importBody = (fileId: string) => ({
  source_media_asset_id: fileId,
  column_mapping: [
    { column: 'SKU', field: 'sku' },
    { column: 'Name', field: 'name_translations.en' },
    { column: 'Category', field: 'part_category_node_id' },
    { column: 'Price', field: 'price_public' },
    { column: 'Currency', field: 'currency' },
  ],
  ai_normalization_requested: false,
});

/** A requester (route scope: a user, or a provider / fleet member) with a sent inquiry to a published vendor. */
async function requester(h: Harness, route: Route): Promise<Actor> {
  return route.scope === 'org' || route.pathParams.includes('org_id') ? h.member('provider', 'provider_staff') : h.user();
}
const inquiries = (route: Route, as: Actor) =>
  route.pathParams.includes('org_id') ? `/v1/orgs/${as.org!.id}/inquiries` : '/v1/me/inquiries';

async function inquiry(h: Harness, route?: Route): Promise<{ v: Actor; as: Actor; id: string; itemId: string }> {
  const pv = await h.vendor();
  const itemId = (await newItem(h, pv.as, { stock_quantity: 3 })).id as string;
  const as = route ? await requester(h, route) : await h.user();
  const q = ok(
    await as.c.post(route ? inquiries(route, as) : '/v1/me/inquiries', {
      inventory_item_id: itemId,
      quantity: 1,
      message: 'Do these fit my car?',
      content_locale: 'en',
    }),
    'inquiry',
  );
  return { v: pv.as, as, id: q.id as string, itemId };
}

/** A published vendor (trade customers supported) with an item that has a trade price, and a provider whose trade account is approved. */
async function tradePair(h: Harness): Promise<{ v: Actor; vendorId: string; shop: Actor; itemId: string; accountId: string }> {
  const pv = await h.vendor();
  const it = await newItem(h, pv.as, { price_public: '100', price_trade: '80' });
  const shop = await h.member('provider');
  const account = ok(
    await shop.c.post(`/v1/orgs/${shop.org!.id}/trade-accounts`, { vendor_organization_id: pv.id, notes: 'Workshop' }),
    'trade request',
  );
  return { v: pv.as, vendorId: pv.id, shop, itemId: it.id as string, accountId: account.id as string };
}

export const resolvers: Resolvers = {
  'inventory.list': async (h) => {
    const v = await vendor(h, { role: 'vendor_staff' });
    await newItem(h, v);
    return { as: v, query: { sort: 'sku_asc' } };
  },
  'inventory.search': async (h) => {
    const v = await vendor(h);
    await newItem(h, v);
    return { as: v, body: { text: 'brake pad', limit: 10 } };
  },
  'inventory.create': async (h) => {
    const v = await vendor(h, { role: 'vendor_staff' });
    return { as: v, body: item(h, { price_trade: '400000', notes: 'Shelf B2', oem_numbers: ['04465-02220'] }) };
  },
  'inventory.get': async (h) => {
    const v = await vendor(h);
    return { as: v, params: { item_id: (await newItem(h, v, { price_trade: '400000' })).id as string } };
  },
  'inventory.update': async (h) => {
    const v = await vendor(h);
    const it = await newItem(h, v);
    return {
      as: v,
      params: { item_id: it.id as string },
      version: it.version as number,
      body: { brand: 'Brembo', price_public: '470000' },
    };
  },
  'inventory.delete': async (h) => {
    const v = await vendor(h);
    return { as: v, params: { item_id: (await newItem(h, v)).id as string } };
  },
  'inventory.bulk_update': async (h) => {
    const v = await vendor(h);
    const [a, b] = [await newItem(h, v), await newItem(h, v, { status: 'draft' })];
    // Items of another vendor are skipped by the job (RLS), never touched.
    return {
      as: v,
      body: { item_ids: [a.id, b.id], patch: { stock_status: 'out_of_stock', visibility: 'hidden' } },
      bola: 'ids outside the vendor are skipped by the job (RLS); the request itself carries no record of the caller',
    };
  },
  'inventory.duplicate_mark': async (h) => {
    const v = await vendor(h);
    const [a, b] = [await newItem(h, v), await newItem(h, v)];
    return { as: v, params: { item_id: b.id as string }, body: { duplicate_of_item_id: a.id } };
  },
  'fitment.list': async (h) => {
    const v = await vendor(h, { role: 'vendor_staff' });
    const it = await newItem(h, v);
    ok(
      await v.c.post(`${inv(v)}/${it.id}/fitment`, {
        items: [{ brand_node_id: h.n.brand, model_node_id: h.n.model, confidence: 'confirmed' }],
      }),
      'fitment',
    );
    return { as: v, params: { item_id: it.id as string } };
  },
  'fitment.create': async (h) => {
    const v = await vendor(h);
    const it = await newItem(h, v);
    return {
      as: v,
      params: { item_id: it.id as string },
      body: { items: [{ brand_node_id: h.n.brand, model_node_id: h.n.model, year_start: 2015, year_end: 2020, confidence: 'confirmed' }] },
    };
  },
  'fitment.update': async (h) => {
    const v = await vendor(h);
    const it = await newItem(h, v);
    const f = (
      ok(
        await v.c.post(`${inv(v)}/${it.id}/fitment`, {
          items: [{ brand_node_id: h.n.brand, model_node_id: h.n.model, confidence: 'confirmed' }],
        }),
        'fitment',
      ).created as Json[]
    )[0]!;
    return {
      as: v,
      params: { item_id: it.id as string, fitment_id: f.id as string },
      version: f.version as number,
      body: { confidence: 'likely' },
    };
  },
  'fitment.delete': async (h) => {
    const v = await vendor(h);
    const it = await newItem(h, v);
    const f = (
      ok(await v.c.post(`${inv(v)}/${it.id}/fitment`, { items: [{ brand_node_id: h.n.brand, confidence: 'uncertain' }] }), 'fitment')
        .created as Json[]
    )[0]!;
    return { as: v, params: { item_id: it.id as string, fitment_id: f.id as string } };
  },
  'fitment.decide': async (h) => {
    const v = await vendor(h);
    const it = await newItem(h, v);
    const id = h.newId();
    await h.sys((db) =>
      db
        .insertInto('inventory.inventory_fitment')
        .values({
          id,
          inventory_item_id: it.id as string,
          brand_node_id: h.n.brand,
          model_node_id: h.n.model,
          confidence: 'likely',
          source: 'ai_suggested',
          ai_insight_id: h.newId(),
          status: 'pending_vendor_confirmation',
        })
        .execute(),
    );
    return { as: v, params: { item_id: it.id as string, fitment_id: id }, body: { decision: 'confirm' } };
  },
  'inventory.import_create': async (h) => {
    const v = await vendor(h, { plan: 'vendor_pro' });
    const file = await h.upload(v, 'inventory_import_csv', {
      mime: 'text/csv',
      bytes: Buffer.from(`SKU,Name,Category,Price,Currency\r\nSW-${h.newId().slice(-10)},Oil filter,${h.n.partCategory},120000,IRR\r\n`),
    });
    // SEC-AZ-4: another vendor on the same plan cannot import this vendor's file.
    return { as: v, body: importBody(file.id as string), bola: { attackers: [await vendor(h, { plan: 'vendor_pro' })] } };
  },
  'inventory.imports_list': async (h) => {
    const { v } = await importBatch(h);
    return { as: v };
  },
  'inventory.import_get': async (h) => {
    const { v, batchId } = await importBatch(h);
    return {
      as: v,
      params: { batch_id: batchId },
      check: (res) => expect(res.body).toMatchObject({ status: 'completed_with_errors', error_report_available: true }),
    };
  },
  'inventory.import_error_report': async (h) => {
    const { v, batchId } = await importBatch(h);
    return { as: v, params: { batch_id: batchId } };
  },
  'trade_accounts.vendor_list': async (h) => {
    const t = await tradePair(h);
    return { as: t.v, check: (res) => expect(res.body.items.map((x: Json) => x.id)).toContain(t.accountId) };
  },
  'trade_accounts.vendor_decide': async (h) => {
    const t = await tradePair(h);
    return { as: t.v, params: { trade_account_id: t.accountId }, body: { decision: 'approve' } };
  },
  'inquiries.vendor_list': async (h) => {
    const q = await inquiry(h);
    return { as: q.v, query: { group: 'open' }, check: (res) => expect(res.body.items.map((x: Json) => x.id)).toContain(q.id) };
  },
  'inquiries.vendor_get': async (h) => {
    const q = await inquiry(h);
    return { as: q.v, params: { inquiry_id: q.id } };
  },
  'inquiries.vendor_message': async (h) => {
    const q = await inquiry(h);
    return { as: q.v, params: { inquiry_id: q.id }, body: { body: 'Yes, two sets in stock.', content_locale: 'en' } };
  },
  'inquiries.vendor_transition': async (h) => {
    const q = await inquiry(h);
    return {
      as: q.v,
      params: { inquiry_id: q.id },
      body: { to: 'reserved', reserved_until: new Date(Date.now() + 2 * 86_400_000).toISOString() },
    };
  },
  'inquiries.create': async (h, route) => {
    const pv = await h.vendor();
    const as = await requester(h, route);
    const body: Json = { inventory_item_id: pv.itemId, quantity: 2, message: 'Do these fit my car?', content_locale: 'en' };
    if (!route.pathParams.includes('org_id')) {
      const car = ok(await as.c.post('/v1/me/vehicles', vehicleBody(h.n, { license_plate: '99B999-11' })), 'vehicle');
      body.share_vehicle_context = { vehicle_id: car.id, policy_version: '2026-10' };
    }
    return { as, body, bodyRefs: !route.pathParams.includes('org_id'), check: (res) => expect(res.text).not.toContain('99B999') };
  },
  'inquiries.list': async (h, route) => {
    const q = await inquiry(h, route);
    return { as: q.as, check: (res) => expect(res.body.items.map((x: Json) => x.id)).toContain(q.id) };
  },
  'inquiries.get': async (h, route) => {
    const q = await inquiry(h, route);
    return { as: q.as, params: { inquiry_id: q.id } };
  },
  'inquiries.message': async (h, route) => {
    const q = await inquiry(h, route);
    return { as: q.as, params: { inquiry_id: q.id }, body: { body: 'Can I pick it up today?', content_locale: 'en' } };
  },
  'inquiries.transition': async (h, route) => {
    const q = await inquiry(h, route);
    return { as: q.as, params: { inquiry_id: q.id }, body: { to: 'cancelled' } };
  },
  'trade_accounts.request': async (h) => {
    const pv = await h.vendor();
    return {
      as: await h.member('provider'),
      body: { vendor_organization_id: pv.id, notes: 'Workshop on Valiasr' },
      bola: 'names a published vendor by design; the trade account belongs to the caller organization from the path',
    };
  },
  'trade_accounts.customer_list': async (h) => {
    const t = await tradePair(h);
    return { as: t.shop, check: (res) => expect(res.body.items.map((x: Json) => x.id)).toContain(t.accountId) };
  },
  'public.org_inventory_search': async (h) => {
    const pv = await h.vendor();
    return {
      as: await h.anonymous(),
      params: { org_id: pv.id },
      body: { text: 'brake' },
      check: (res) => expect(res.body.items.length).toBeGreaterThan(0),
    };
  },
  'public.inventory_get': async (h) => {
    const t = await tradePair(h);
    ok(await t.v.c.post(`/v1/orgs/${t.vendorId}/vendor/trade-accounts/${t.accountId}/decision`, { decision: 'approve' }), 'approve');
    const stranger = await h.stranger();
    return {
      as: t.shop,
      params: { item_id: t.itemId },
      query: { as_organization_id: t.shop.org!.id },
      trade: true,
      bola: 'public item: an unrelated caller naming the trade customer is checked in the resolver (public price only)',
      check: async (res) => {
        // Approved trade account: the trade price; anyone else naming that organization: the public price.
        expect(res.body.price).toMatchObject({ amount: '80.00' });
        const other = await h.apiKill.request<Json>({
          path: `/v1/public/inventory/${t.itemId}?as_organization_id=${t.shop.org!.id}`,
          token: stranger.token,
        });
        if (other.status === 200) expect(other.body.price).toMatchObject({ amount: '100.00' });
        else expect([404, 422]).toContain(other.status);
        const anon = await h.apiKill.request<Json>({
          path: `/v1/public/inventory/${t.itemId}`,
          token: ((await h.anonymous()) as { token: string }).token,
        });
        expect(anon.body.price).toMatchObject({ amount: '100.00' });
        expect(anon.text).not.toContain('80.00');
      },
    };
  },
};
