// E2E seed of public businesses (P5.T8, recommendations P5_P6): a published provider and a published vendor with one
// part, created through the API as a business user — never through SQL. The user signs up on the auth host and gets
// a cp-web-consumer token by the real code flow (PKCE, no client authentication in lite mode); the API's audience is
// the same for every web client, so the token may call the organization routes the BFF never forwards. New vendor
// organizations get the vendor_basic plan automatically. Every run uses fresh names at a fresh point in Tehran.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { expect, type APIRequestContext } from '@playwright/test';
import { API, AUTH, mailedLinkToken, newEmail, now, readMail } from './accounts';

const CLIENT = 'cp-web-consumer/0.1.0 (web 1.0)';
const PORT = Number(process.env.CARPAL_E2E_PORT ?? 3100);
const b64 = (bytes: Buffer) => bytes.toString('base64url');

type Json = Record<string, unknown>;

export interface BusinessApi {
  call: (
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) => Promise<{ status: number; body: Json; etag: string | null }>;
}

/** A verified user with a password and an API access token (through the hosted sign-in endpoints). */
export async function businessUser(request: APIRequestContext): Promise<BusinessApi> {
  const email = newEmail('p5');
  const password = `winter tyres ${randomBytes(4).toString('hex')}`;
  const verifier = b64(randomBytes(32));
  const redirect = `https://localhost:${PORT}/bff/oauth/callback`;
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: 'cp-web-consumer',
    redirect_uri: redirect,
    scope: 'openid offline_access',
    state: b64(randomBytes(24)),
    nonce: b64(randomBytes(24)),
    code_challenge: b64(createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
  });
  const start = await request.get(`${AUTH}/oauth/authorize?${q}`, { maxRedirects: 0, headers: { 'carpal-client': CLIENT } });
  expect(start.status(), await start.text()).toBe(302);
  const interaction = new URL(start.headers().location!).searchParams.get('interaction_id')!;
  const cookie = start.headers()['set-cookie']!.split(';')[0]!;
  const post = (path: string, data: unknown) =>
    request.post(`${AUTH}${path}`, { data, headers: { cookie, 'carpal-client': CLIENT, 'idempotency-key': randomUUID() } });

  const since = now();
  const signup = await post('/v1/auth/signup', {
    interaction_id: interaction,
    full_name: 'Reza Example',
    email,
    password,
    locale: 'en',
    terms_version: '2026-10',
    privacy_policy_version: '2026-10',
  });
  expect(signup.status(), await signup.text()).toBe(202);
  expect(
    (await post('/v1/auth/email/verify', { token: await mailedLinkToken(email, 'identity.email_verification', since) })).status(),
  ).toBe(200);
  const signin = await post('/v1/auth/signin', { interaction_id: interaction, email, password });
  expect(signin.status(), await signin.text()).toBe(200);
  const back = await request.get(`${AUTH}/oauth/authorize?${q}`, { maxRedirects: 0, headers: { cookie, 'carpal-client': CLIENT } });
  const code = new URL(back.headers().location!).searchParams.get('code')!;
  const token = await request.post(`${AUTH}/oauth/token`, {
    form: { grant_type: 'authorization_code', client_id: 'cp-web-consumer', code, redirect_uri: redirect, code_verifier: verifier },
    headers: { 'carpal-client': CLIENT },
  });
  expect(token.status(), await token.text()).toBe(200);
  const { access_token, token_type } = (await token.json()) as { access_token: string; token_type: string };

  return {
    async call(method, path, body, headers = {}) {
      const res = await request.fetch(`${API}${path}`, {
        method,
        headers: {
          authorization: `${token_type} ${access_token}`,
          'carpal-client': CLIENT,
          'accept-language': 'en',
          'idempotency-key': randomUUID(),
          ...headers,
        },
        ...(body === undefined ? {} : { data: body }),
      });
      const text = await res.text();
      return { status: res.status(), body: text ? (JSON.parse(text) as Json) : {}, etag: res.headers().etag ?? null };
    },
  };
}

async function ok(r: Promise<{ status: number; body: Json }>, what: string): Promise<Json> {
  const res = await r;
  expect(res.status, `${what}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  return res.body;
}

/** First active taxonomy nodes: a brand with a model, a service system and a part category (public read). */
export async function taxonomy(
  request: APIRequestContext,
): Promise<{ brand: string; brandName: string; model: string; system: string; partCategory: string }> {
  const list = async (type: string, parent?: string) => {
    const tok = await request.post(`${AUTH}/oauth/token`, {
      form: { grant_type: 'client_credentials', client_id: 'cp-ssr', scope: 'public.read' },
      headers: { 'carpal-client': 'cp-ssr/0.1.0 (web 1.0)' },
    });
    const { access_token, token_type } = (await tok.json()) as { access_token: string; token_type: string };
    const res = await request.get(`${API}/v1/taxonomy/nodes?type=${type}&limit=50${parent ? `&parent_id=${parent}` : ''}`, {
      headers: { authorization: `${token_type} ${access_token}`, 'carpal-client': 'cp-ssr/0.1.0 (web 1.0)', 'accept-language': 'en' },
    });
    expect(res.status(), await res.text()).toBe(200);
    return ((await res.json()) as { items: { id: string; name: { text: string } }[] }).items;
  };
  const brands = await list('vehicle_brand');
  for (const b of brands) {
    const models = await list('vehicle_model', b.id);
    if (models.length) {
      const [systems, parts] = await Promise.all([list('service_system'), list('part_category')]);
      return { brand: b.id, brandName: b.name.text, model: models[0]!.id, system: systems[0]!.id, partCategory: parts[0]!.id };
    }
  }
  throw new Error('no brand with a model in the taxonomy');
}

/** A random point in central Tehran (inside the pilot city radius). */
export function tehranPoint(): { lat: number; lng: number } {
  return { lat: Math.round((35.66 + Math.random() * 0.08) * 1e6) / 1e6, lng: Math.round((51.33 + Math.random() * 0.1) * 1e6) / 1e6 };
}

const week = [6, 0, 1, 2, 3, 4].map((d) => ({ day_of_week: d, open: '08:00', close: d === 4 ? '14:00' : '18:00' }));

function location(point: { lat: number; lng: number }): Json {
  return {
    name: 'Main workshop',
    address_line_1: '14 Sattarkhan Street',
    city: 'Tehran',
    country: 'IR',
    pin: point,
    public_address_visibility: 'exact',
    timezone: 'Asia/Tehran',
    is_primary: true,
    hours: { weekly: week },
  };
}

export interface SeededOrg {
  id: string;
  name: string;
  slug: string;
}

export interface SeededProvider extends SeededOrg {
  locationId: string;
  /** The business user's API (P10: confirms and completes appointments). */
  api: BusinessApi;
}

/**
 * A published provider in Tehran with hours and (unless rules: false) an availability rule for every open weekday; at a
 * given point when asked (P10 places the shop where the E2E browser is). A shop without rules publishes no slots but
 * can still confirm requests at any time (BA-19).
 */
export async function seedProvider(
  request: APIRequestContext,
  n: Awaited<ReturnType<typeof taxonomy>>,
  o: { name?: string; point?: { lat: number; lng: number }; rules?: boolean } = {},
): Promise<SeededProvider> {
  const api = await businessUser(request);
  const name = o.name ?? `P5 Suspension ${randomBytes(3).toString('hex')}`;
  const org = await ok(api.call('POST', '/v1/orgs', { name, organization_type: 'provider', contact_email: 'shop@example.com' }), 'org');
  const id = org.id as string;
  const loc = await ok(api.call('POST', `/v1/orgs/${id}/locations`, location(o.point ?? tehranPoint())), 'location');
  const prv = `/v1/orgs/${id}/provider`;
  await ok(
    api.call('PUT', `${prv}/profile`, {
      provider_type: 'garage',
      service_modes: ['in_shop'],
      price_tier: 'mid_range',
      warranty_offered: true,
      warranty_policy_translations: { en: '6 months on parts and labour', fa: '۶ ماه روی قطعه و دستمزد' },
      description_translations: { en: 'Suspension and steering for European cars.', fa: 'جلوبندی و فرمان خودروهای اروپایی.' },
      contact_channels: [{ type: 'phone', value: '+982166001122', preferred: true }],
      languages_spoken: ['fa', 'en'],
      response_time_target: 'same_day',
    }),
    'profile',
  );
  await ok(
    api.call('POST', `${prv}/service-categories`, { taxonomy_node_id: n.system, experience_level: 'specialist', visibility: 'public' }),
    'category',
  );
  await ok(api.call('POST', `${prv}/coverage`, { items: [{ brand_node_id: n.brand, coverage_level: 'specialist' }] }), 'coverage');
  for (const d of o.rules === false ? [] : week)
    await ok(
      api.call('POST', `${prv}/availability-rules`, {
        location_id: loc.id,
        day_of_week: d.day_of_week,
        start_time: d.open,
        end_time: d.close,
        slot_duration_minutes: 60,
        max_concurrent_appointments: 1,
      }),
      'availability',
    );
  await ok(api.call('POST', `${prv}/publish`), 'publish');
  const published = await ok(api.call('GET', `/v1/orgs/${id}`), 'org get');
  return { id, name, slug: published.slug as string, locationId: loc.id as string, api };
}

/** A published vendor in Tehran with one public part in stock (fitment confirmed for the brand) and its category. */
export async function seedVendor(
  request: APIRequestContext,
  n: Awaited<ReturnType<typeof taxonomy>>,
): Promise<SeededOrg & { itemId: string; itemName: string }> {
  const api = await businessUser(request);
  const name = `P5 Parts ${randomBytes(3).toString('hex')}`;
  const org = await ok(api.call('POST', '/v1/orgs', { name, organization_type: 'vendor', contact_email: 'parts@example.com' }), 'org');
  const id = org.id as string;
  const vnd = `/v1/orgs/${id}/vendor`;
  const current = await api.call('GET', `${vnd}/profile`);
  await ok(
    api.call(
      'PUT',
      `${vnd}/profile`,
      {
        vendor_type: 'parts_retailer',
        delivery_options: ['pickup', 'local_delivery'],
        trade_customers_supported: true,
        default_price_visibility: 'public',
      },
      current.etag ? { 'if-match': current.etag } : {},
    ),
    'vendor profile',
  );
  const loc = await ok(api.call('POST', `/v1/orgs/${id}/locations`, location(tehranPoint())), 'location');
  await ok(
    api.call('POST', `${vnd}/coverage`, {
      items: [
        { taxonomy_node_id: n.partCategory, coverage_type: 'part_category' },
        { taxonomy_node_id: n.brand, coverage_type: 'brand' },
      ],
    }),
    'coverage',
  );
  const itemName = `Front control arm ${randomBytes(2).toString('hex')}`;
  const item = await ok(
    api.call('POST', `${vnd}/inventory`, {
      sku: `P5-${randomBytes(4).toString('hex')}`,
      name_translations: { en: itemName, fa: `طبق جلو ${itemName.slice(-4)}` },
      part_origin: 'aftermarket',
      condition: 'new',
      part_category_node_id: n.partCategory,
      brand: 'Lemförder',
      oem_numbers: ['31126769717'],
      price_public: '45',
      price_trade: '30',
      currency: 'USD',
      price_on_request: false,
      stock_status: 'in_stock',
      location_id: loc.id,
      warranty_note: '6 months',
      visibility: 'public',
      status: 'active',
    }),
    'item',
  );
  await ok(
    api.call('POST', `${vnd}/inventory/${item.id as string}/fitment`, {
      items: [{ brand_node_id: n.brand, model_node_id: n.model, confidence: 'confirmed' }],
    }),
    'fitment',
  );
  await ok(api.call('POST', `${vnd}/publish`), 'publish');
  const published = await ok(api.call('GET', `/v1/orgs/${id}`), 'org get');
  return { id, name, slug: published.slug as string, itemId: item.id as string, itemName };
}

export interface SeededFleet {
  orgId: string;
  name: string;
  vehicleId: string;
  /** The owner's API (fleet_owner: assigns vehicles, reads the driver's reports). */
  owner: BusinessApi;
  /** The single-use `mi` invitation token mailed to the driver. */
  inviteToken: string;
  /** Assigns the vehicle to the member with this email once they accepted the invitation. */
  assignTo: (email: string) => Promise<void>;
}

/**
 * P12.T5: a fleet created through the API (never SQL): a fleet owner, the organization, one fleet vehicle and an
 * invitation of `driverEmail` as fleet_driver (the `mi` link mailed to them). The driver accepts in the browser
 * (/l/mi), then assignTo() gives them the vehicle (fleet.assignment_set, the owner holds FC).
 */
export async function seedFleet(request: APIRequestContext, driverEmail: string): Promise<SeededFleet> {
  const owner = await businessUser(request);
  const n = await taxonomy(request);
  const tag = randomBytes(3).toString('hex');
  const name = `Fleet ${tag}`;
  const org = await ok(
    owner.call('POST', '/v1/orgs', { name, organization_type: 'fleet', contact_email: `fleet-${tag}@example.com` }),
    'org.create (fleet)',
  );
  const orgId = org.id as string;
  const flt = `/v1/orgs/${orgId}/fleet`;
  const vehicle = await ok(
    owner.call('POST', `${flt}/vehicles`, {
      brand_node_id: n.brand,
      model_node_id: n.model,
      year: 2019,
      nickname: `Van ${tag}`,
      license_plate: `12 B ${tag.slice(0, 3)}`,
      mileage_km: 81000,
    }),
    'vehicles.create (fleet)',
  );
  const since = now();
  await ok(owner.call('POST', `/v1/orgs/${orgId}/members/invitations`, { email: driverEmail, role: 'fleet_driver' }), 'org.member_invite');
  const mail = await readMail(driverEmail, 'organization.member_invitation', since);
  const inviteToken = mail.variables.link!.split('#')[1]!;
  return {
    orgId,
    name,
    vehicleId: vehicle.id as string,
    owner,
    inviteToken,
    async assignTo(email) {
      const members = await ok(owner.call('GET', `/v1/orgs/${orgId}/members?role=fleet_driver`), 'org.members_list');
      const member = (members.items as { email: string; user_id: string | null; status: string }[]).find(
        (x) => x.email.toLowerCase() === email.toLowerCase() && x.status === 'active',
      );
      expect(member?.user_id, 'the driver accepted the invitation').toBeTruthy();
      await ok(
        owner.call('PUT', `${flt}/vehicles/${vehicle.id as string}/assignment`, { driver_user_id: member!.user_id }),
        'fleet.assignment_set',
      );
    },
  };
}
