// Shared helpers of the S6 integration tests (discovery, community,
// notifications): publishing providers and vendors through the API at a
// unique point, draining the outbox relay and the consumers (W2, W5), and a
// flag service with the Should-have community flags switched on.
import type { INestApplicationContext } from '@nestjs/common';
import { FlagService, type FlagContext } from '#libs/flags/index.js';
import { TxRunner } from '#libs/tenancy/index.js';
import { OutboxRelayService } from '#workers/outbox-relay/outbox-relay.module.js';
import type { Json, Nodes } from './s4-support.js';
import { client, newId, type Client } from './s5-support.js';
import type { TestApp } from './test-app.js';

/** A random point in the Lut desert (inside the pilot region, far from the other tests' locations). */
export function uniquePoint(): { lat: number; lng: number } {
  return { lat: Math.round((29.5 + Math.random() * 2) * 1e6) / 1e6, lng: Math.round((57.5 + Math.random() * 2) * 1e6) / 1e6 };
}

export const near = (p: { lat: number; lng: number }, dLat = 0.01, dLng = 0.01) => ({
  lat: Math.round((p.lat + dLat) * 1e6) / 1e6,
  lng: Math.round((p.lng + dLng) * 1e6) / 1e6,
});

export interface PublishedOrg {
  id: string;
  userId: string;
  token: string;
  c: Client;
  point: { lat: number; lng: number };
  locationId: string;
}

const location = (point: { lat: number; lng: number }, o: Json = {}) => ({
  address_line_1: '7 Desert Road',
  city: 'Kerman',
  country: 'IR',
  pin: point,
  public_address_visibility: 'exact',
  timezone: 'Asia/Tehran',
  is_primary: true,
  ...o,
});

async function created(res: { status: number; text: string; body: Json }, what: string): Promise<Json> {
  if (res.status !== 200 && res.status !== 201) throw new Error(`${what}: ${res.status} ${res.text}`);
  return res.body;
}

/** A published provider (owner token) offering `services` for `brands`, at `point`. */
export async function publishedProvider(
  app: TestApp,
  n: Nodes,
  o: {
    name: string;
    point?: { lat: number; lng: number };
    services?: string[];
    brands?: string[];
    description?: Record<string, string>;
    responseTarget?: string;
    location?: Json;
    /** ProviderProfileWrite members over the defaults (service_modes, price_tier, …). */
    profile?: Json;
  },
): Promise<PublishedOrg> {
  const user = await app.fixtures.user();
  const token = await app.fixtures.token(user);
  const c = client(app, token);
  const org = await created(
    await c.post('/v1/orgs', { name: o.name, organization_type: 'provider', contact_email: 'shop@example.com' }),
    'org',
  );
  const point = o.point ?? uniquePoint();
  const loc = await created(await c.post(`/v1/orgs/${org.id}/locations`, location(point, o.location)), 'location');
  const prv = `/v1/orgs/${org.id}/provider`;
  await created(
    await c.put(
      `${prv}/profile`,
      {
        provider_type: 'garage',
        service_modes: ['in_shop'],
        price_tier: 'mid_range',
        warranty_offered: false,
        description_translations: o.description ?? { en: 'General repairs and servicing', fa: 'تعمیرات عمومی' },
        contact_channels: [{ type: 'whatsapp', value: '+989121234567', preferred: true }],
        languages_spoken: ['fa', 'en'],
        ...(o.responseTarget ? { response_time_target: o.responseTarget } : {}),
        ...o.profile,
      },
      { 'idempotency-key': newId() },
    ),
    'profile',
  );
  for (const s of o.services ?? [n.system])
    await created(
      await c.post(`${prv}/service-categories`, { taxonomy_node_id: s, experience_level: 'advanced', visibility: 'public' }),
      'category',
    );
  await created(
    await c.post(`${prv}/coverage`, { items: (o.brands ?? [n.brand]).map((b) => ({ brand_node_id: b, coverage_level: 'specialist' })) }),
    'coverage',
  );
  await created(await c.post(`${prv}/publish`), 'publish');
  return { id: org.id, userId: user.id, token, c, point, locationId: loc.id };
}

export const item = (n: Nodes, o: Json = {}) => ({
  sku: `S6-${newId().slice(-12)}`,
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

/** A published vendor with one active public item (returned), at `point`. */
export async function publishedVendor(
  app: TestApp,
  n: Nodes,
  o: { name: string; point?: { lat: number; lng: number }; item?: Json; trade?: boolean },
): Promise<PublishedOrg & { itemId: string; vnd: string }> {
  const { user, org, token } = await app.fixtures.memberOf('vendor', 'vendor_owner');
  await app.fixtures.subscription(org, 'vendor_basic');
  const c = client(app, token);
  const vnd = `/v1/orgs/${org.id}/vendor`;
  await app.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
    db.updateTable('organization.organizations').set({ name: o.name }).where('id', '=', org.id).execute(),
  );
  await created(
    await c.put(
      `${vnd}/profile`,
      {
        vendor_type: 'parts_retailer',
        delivery_options: ['pickup'],
        trade_customers_supported: o.trade ?? true,
        default_price_visibility: 'public',
      },
      { 'idempotency-key': newId() },
    ),
    'vendor profile',
  );
  const point = o.point ?? uniquePoint();
  const loc = await created(await c.post(`/v1/orgs/${org.id}/locations`, location(point)), 'location');
  const it = await created(await c.post(`${vnd}/inventory`, item(n, o.item)), 'item');
  await created(await c.post(`${vnd}/publish`), 'vendor publish');
  return { id: org.id, userId: user.id, token, c, point, locationId: loc.id, itemId: it.id, vnd };
}

/** Relays every pending outbox row and waits for the consumers (W2, W5, …), twice for follow-up events. */
export async function flush(app: TestApp, worker: INestApplicationContext): Promise<void> {
  const relay = worker.get(OutboxRelayService).relay;
  for (let round = 0; round < 3; round++) {
    await relay.settle();
    while ((await relay.drainOnce()) > 0);
    await app.infra.bus.idle();
  }
}

/** Feature flags as seeded, with the given keys switched on (the Should-have community flags are off by default). */
export function flagsOn(...keys: string[]) {
  return {
    provide: FlagService,
    useFactory: (tx: TxRunner) =>
      new (class extends FlagService {
        override async isEnabled(key: string, ctx?: FlagContext): Promise<boolean> {
          return keys.includes(key) || super.isEnabled(key, ctx);
        }
      })(tx, 'dev', 0),
    inject: [TxRunner],
  };
}
