// Contract sweep resolvers: organizations, members, locations, geo,
// verification (40 §7), provider profiles and portfolio (§8), vendor
// profiles (§9), public profiles (§14.3) and organization administration (§23.2).
import { expect } from 'vitest';
import { mailedToken } from '../../s4-support.js';
import { uniquePoint } from '../../s6-support.js';
import { openCase, purpose, REASON } from '../../s8-support.js';
import { sharedProvider, showcase } from '../domain.js';
import { ok, type Actor, type Harness, type Json, type Published, type Resolvers } from '../harness.js';

const location = (o: Json = {}) => ({
  address_line_1: '1200 Valiasr Street',
  city: 'Tehran',
  country: 'IR',
  pin: { lat: 35.757512, lng: 51.410621 },
  public_address_visibility: 'exact',
  timezone: 'Asia/Tehran',
  is_primary: true,
  ...o,
});

const providerProfile = (o: Json = {}) => ({
  provider_type: 'garage',
  service_modes: ['in_shop'],
  price_tier: 'mid_range',
  warranty_offered: false,
  description_translations: { en: 'General repairs and servicing', fa: 'تعمیرات عمومی' },
  contact_channels: [{ type: 'whatsapp', value: '+989121234567', preferred: true }],
  languages_spoken: ['fa', 'en'],
  ...o,
});

const vendorProfile = (o: Json = {}) => ({
  vendor_type: 'parts_retailer',
  delivery_options: ['pickup'],
  trade_customers_supported: true,
  default_price_visibility: 'public',
  ...o,
});

const portfolioItem = (h: Harness) => ({
  title: 'Control arm replacement',
  content_locale: 'en',
  brand_node_id: h.n.brand,
  model_node_id: h.n.model,
  service_system_node_id: h.n.system,
  caption: 'Old vs new arm',
  caption_source: 'manual',
  visibility: 'public',
});

const prv = (a: Actor) => `/v1/orgs/${a.org!.id}/provider`;
const vnd = (a: Actor) => `/v1/orgs/${a.org!.id}/vendor`;
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);

/** A provider member (new organization) with a profile. */
async function withProfile(h: Harness, role = 'provider_owner'): Promise<Actor> {
  const as = await h.member('provider', role);
  if (role !== 'provider_owner' && role !== 'provider_manager') {
    const owner = await h.colleague(as, 'provider_owner');
    ok(await owner.c.put(`${prv(as)}/profile`, providerProfile()), 'provider profile');
  } else ok(await as.c.put(`${prv(as)}/profile`, providerProfile()), 'provider profile');
  return as;
}

/** A provider meeting every publish requirement, not yet published. */
async function readyProvider(h: Harness): Promise<Actor> {
  const as = await withProfile(h);
  ok(await as.c.post(`/v1/orgs/${as.org!.id}/locations`, location({ pin: uniquePoint() })), 'location');
  ok(
    await as.c.post(`${prv(as)}/service-categories`, { taxonomy_node_id: h.n.system, experience_level: 'advanced', visibility: 'public' }),
    'category',
  );
  ok(await as.c.post(`${prv(as)}/coverage`, { items: [{ brand_node_id: h.n.brand, coverage_level: 'specialist' }] }), 'coverage');
  return as;
}

/** A vendor member (basic plan) with a profile. */
async function vendorWithProfile(h: Harness, o: Json = {}): Promise<Actor> {
  const as = await h.member('vendor');
  await h.fx.subscription(as.org!, 'vendor_basic');
  ok(await as.c.put(`${vnd(as)}/profile`, vendorProfile(o)), 'vendor profile');
  return as;
}

/** A customer with a visit at the provider (the relationship customer notes and consent requests need). */
async function customerOf(h: Harness, provider: Actor): Promise<{ customer: Actor; appointmentId: string }> {
  const customer = await h.user();
  const appointmentId = await h.fx.appointment(provider.org!, customer.user, await h.vehicle(customer));
  return { customer, appointmentId };
}

const created = (res: Json) => (res.created as Json[])[0]!.id as string;

export const resolvers: Resolvers = {
  // ------------------------------------------------------------ §7 organizations
  'org.create': async (h) => ({
    as: await h.user(),
    body: { name: 'Reza Auto Suspension', organization_type: 'provider', contact_email: 'Shop@Example.com' },
  }),
  'org.get': async (h) => ({ as: await h.member('provider', 'provider_staff') }),
  'org.update': async (h) => ({ as: await h.member('provider', 'provider_manager'), version: 1, body: { name: 'New Name' } }),
  'org.members_list': async (h) => ({ as: await h.member('provider', 'provider_manager') }),
  'org.member_invite': async (h) => ({
    as: await h.member('provider'),
    body: { email: (await h.fx.user()).email, role: 'provider_staff' },
  }),
  'org.invitation_accept': async (h) => {
    const owner = await h.member('provider');
    const invitee = await h.user();
    ok(
      await owner.c.post(`/v1/orgs/${owner.org!.id}/members/invitations`, { email: invitee.user.email, role: 'provider_staff' }),
      'invite',
    );
    // Another signed-in user cannot accept a link mailed to someone else.
    return {
      as: invitee,
      body: { token: mailedToken(h.api, invitee.user.email, 'organization.member_invitation') },
      bola: { attackers: [await h.stranger()], expect: [403] },
    };
  },
  'org.member_update': async (h) => {
    const as = await h.member('provider');
    const staff = await h.colleague(as, 'provider_staff');
    const row = (ok(await as.c.get(`/v1/orgs/${as.org!.id}/members?role=provider_staff`), 'members').items as Json[]).find(
      (m) => m.user_id === staff.user.id,
    )!;
    return { as, params: { membership_id: row.membership_id }, version: row.version, body: { role: 'provider_manager' } };
  },
  'org.member_remove': async (h) => {
    const as = await h.member('provider');
    const staff = await h.colleague(as, 'provider_staff');
    const row = (ok(await as.c.get(`/v1/orgs/${as.org!.id}/members?role=provider_staff`), 'members').items as Json[]).find(
      (m) => m.user_id === staff.user.id,
    )!;
    return { as, params: { membership_id: row.membership_id } };
  },
  'org.locations_list': async (h) => {
    const as = await h.member('provider', 'provider_staff');
    return { as };
  },
  'org.location_create': async (h) => ({ as: await h.member('provider', 'provider_manager'), body: location() }),
  'org.location_update': async (h) => {
    const as = await h.member('provider', 'provider_manager');
    const loc = ok(await as.c.post(`/v1/orgs/${as.org!.id}/locations`, location()), 'location');
    return { as, params: { location_id: loc.id as string }, version: loc.version as number, body: { address_line_2: 'Unit 4' } };
  },
  'org.location_delete': async (h) => {
    const as = await h.member('provider', 'provider_manager');
    ok(await as.c.post(`/v1/orgs/${as.org!.id}/locations`, location()), 'primary location');
    const second = ok(await as.c.post(`/v1/orgs/${as.org!.id}/locations`, location({ is_primary: false, pin: uniquePoint() })), 'location');
    return { as, params: { location_id: second.id as string } };
  },
  'org.location_pin_check': async (h) => ({
    as: await h.member('provider', 'provider_manager'),
    body: { address_line_1: '45 Shariati Street', city: 'Tehran', country: 'IR', pin: { lat: 35.7318, lng: 51.4423 } },
  }),
  'geo.geocode': async (h) => ({ as: await h.member('provider', 'provider_manager'), body: { query: 'خیابان آزادی', country: 'IR' } }),
  'geo.reverse': async (h) => ({ as: await h.member('provider', 'provider_manager'), body: { point: { lat: 35.70112, lng: 51.40191 } } }),
  'geo.resolve_map_link': async (h) => ({
    as: await h.member('provider', 'provider_manager'),
    body: { url: 'https://www.google.com/maps/place/Shop/@35.757512,51.410621,17z' },
  }),
  'org.verifications_list': async (h) => {
    const as = await h.member('provider');
    ok(await as.c.post(`/v1/orgs/${as.org!.id}/verifications`, { verification_type: 'business_identity' }), 'verification');
    return { as, check: (res) => expect(res.body.items).toHaveLength(1) };
  },
  'org.verification_submit': async (h) => {
    const as = await h.member('provider');
    const doc = await h.upload(as, 'verification_document', { mime: 'application/pdf' });
    return { as, body: { verification_type: 'business_identity', submitted_document_ids: [doc.id] }, bodyRefs: true };
  },

  // ------------------------------------------------------------ §8 provider profile
  'provider.profile_get': async (h) => ({ as: await withProfile(h, 'provider_staff') }),
  'provider.profile_put': async (h) => ({ as: await h.member('provider'), body: providerProfile() }),
  'provider.publish': async (h) => ({
    as: await readyProvider(h),
    check: (res) => expect(res.body).toEqual({ public_status: 'published', unmet: [] }),
  }),
  'provider.unpublish': async (h) => ({ as: (await h.provider()).as, body: { reason: 'Moving to a new garage' } }),
  'provider.certifications_list': async (h) => ({ as: await h.member('provider', 'provider_staff') }),
  'provider.certification_create': async (h) => {
    const as = await h.member('provider');
    const doc = await h.upload(as, 'certification_document');
    return {
      as,
      body: {
        certification_type: 'ev_high_voltage',
        name: 'EV Level 3',
        issuer: 'IMI',
        issued_at: '2025-01-10',
        document_media_asset_id: doc.id,
      },
      bodyRefs: true,
      // The credential reference of SEC-OUT-1 is never echoed; the credential number is the provider's own data.
      check: (res) => expect(res.body.verification_status).toBe('pending'),
    };
  },
  'provider.certification_update': async (h) => {
    const as = await h.member('provider');
    const cert = ok(await as.c.post(`${prv(as)}/certifications`, { certification_type: 'other', name: 'Cert', issuer: 'Issuer' }), 'cert');
    return { as, params: { certification_id: cert.id as string }, version: cert.version as number, body: { credential_number: 'EV-123' } };
  },
  'provider.certification_delete': async (h) => {
    const as = await h.member('provider');
    const cert = ok(await as.c.post(`${prv(as)}/certifications`, { certification_type: 'other', name: 'Cert', issuer: 'Issuer' }), 'cert');
    return { as, params: { certification_id: cert.id as string } };
  },
  'provider.service_categories_list': async (h) => ({ as: await h.member('provider', 'provider_staff') }),
  'provider.service_category_create': async (h) => ({
    as: await h.member('provider', 'provider_manager'),
    body: { taxonomy_node_id: h.n.system, experience_level: 'advanced', visibility: 'public' },
  }),
  'provider.service_category_update': async (h) => {
    const as = await h.member('provider');
    const cat = ok(
      await as.c.post(`${prv(as)}/service-categories`, {
        taxonomy_node_id: h.n.system,
        experience_level: 'advanced',
        visibility: 'public',
      }),
      'category',
    );
    return { as, params: { category_id: cat.id as string }, version: cat.version as number, body: { experience_level: 'specialist' } };
  },
  'provider.service_category_delete': async (h) => {
    const as = await h.member('provider');
    const cat = ok(
      await as.c.post(`${prv(as)}/service-categories`, {
        taxonomy_node_id: h.n.system,
        experience_level: 'advanced',
        visibility: 'public',
      }),
      'category',
    );
    return { as, params: { category_id: cat.id as string } };
  },
  'provider.coverage_list': async (h) => ({ as: await h.member('provider', 'provider_staff') }),
  'provider.coverage_create': async (h) => ({
    as: await h.member('provider'),
    body: { items: [{ brand_node_id: h.n.brand, model_node_id: h.n.model, series_node_id: h.n.series, coverage_level: 'advanced' }] },
  }),
  'provider.coverage_delete': async (h) => {
    const as = await h.member('provider');
    const cov = ok(await as.c.post(`${prv(as)}/coverage`, { items: [{ brand_node_id: h.n.brand, coverage_level: 'basic' }] }), 'coverage');
    return { as, params: { coverage_id: created(cov) } };
  },
  'provider.capabilities_list': async (h) => ({ as: await h.member('provider', 'provider_staff') }),
  'provider.capability_create': async (h) => ({
    as: await h.member('provider', 'provider_manager'),
    body: {
      brand_node_id: h.n.brand,
      model_node_id: h.n.model,
      service_system_node_id: h.n.system,
      service_task_node_id: h.n.task,
      experience_level: 'specialist',
      public_visibility: true,
    },
  }),
  'provider.capability_update': async (h) => {
    const as = await h.member('provider');
    const cap = ok(
      await as.c.post(`${prv(as)}/capabilities`, {
        service_system_node_id: h.n.system,
        experience_level: 'advanced',
        public_visibility: false,
      }),
      'capability',
    );
    return { as, params: { capability_id: cap.id as string }, version: cap.version as number, body: { experience_level: 'specialist' } };
  },
  'provider.capability_delete': async (h) => {
    const as = await h.member('provider');
    const cap = ok(
      await as.c.post(`${prv(as)}/capabilities`, {
        service_system_node_id: h.n.system,
        experience_level: 'advanced',
        public_visibility: false,
      }),
      'capability',
    );
    return { as, params: { capability_id: cap.id as string } };
  },
  'provider.capability_evidence_list': async (h) => {
    const as = await h.member('provider', 'provider_staff');
    const owner = await h.colleague(as, 'provider_owner');
    const cap = ok(
      await owner.c.post(`${prv(as)}/capabilities`, {
        service_system_node_id: h.n.system,
        experience_level: 'advanced',
        public_visibility: false,
      }),
      'capability',
    );
    await h.sys((db) =>
      db
        .insertInto('organization.provider_capability_evidence')
        .values({
          capability_id: cap.id as string,
          evidence_type: 'verified_review',
          reference_entity_type: 'review',
          reference_entity_id: h.newId(),
          base_weight: 8,
          evidence_date: '2026-09-01',
          linked_by: 'system_rule',
        })
        .execute(),
    );
    return { as, params: { capability_id: cap.id as string }, check: (res) => expect(res.body.items).toHaveLength(1) };
  },
  'provider.gated_decide': async (h) => {
    const as = await h.member('provider');
    const cat = await h.sys((db) =>
      db
        .insertInto('organization.provider_service_categories')
        .values({
          provider_organization_id: as.org!.id,
          taxonomy_node_id: h.n.task,
          experience_level: 'intermediate',
          source: 'ai_suggested',
          ai_insight_id: h.newId(),
          status: 'pending_provider_approval',
        })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    return { as, params: { collection: 'service-categories', record_id: cat.id }, body: { decision: 'approve' } };
  },
  'provider.job_logs_list': async (h) => ({ as: await h.member('provider', 'provider_staff'), query: { from: daysAgo(30), to: today() } }),
  'provider.job_log_create': async (h) => ({
    as: await h.member('provider', 'provider_staff'),
    body: { job_date: daysAgo(1), service_system_node_id: h.n.system, brand_node_id: h.n.brand, model_node_id: h.n.model },
  }),
  'provider.job_log_update': async (h) => {
    const as = await h.member('provider');
    const log = ok(await as.c.post(`${prv(as)}/job-logs`, { job_date: daysAgo(1), service_system_node_id: h.n.system }), 'job log');
    return {
      as,
      params: { job_log_id: log.id as string },
      version: log.version as number,
      body: { description: 'Replaced the front pads' },
    };
  },
  'provider.job_log_delete': async (h) => {
    const as = await h.member('provider');
    const log = ok(await as.c.post(`${prv(as)}/job-logs`, { job_date: daysAgo(1), service_system_node_id: h.n.system }), 'job log');
    return { as, params: { job_log_id: log.id as string } };
  },
  'provider.customer_notes_list': async (h) => {
    const as = await h.member('provider', 'provider_staff');
    const { customer } = await customerOf(h, as);
    ok(await as.c.post(`${prv(as)}/customer-notes`, { customer_user_id: customer.user.id, body: 'Prefers morning slots' }), 'note');
    return { as, query: { customer_user_id: customer.user.id }, check: (res) => expect(res.body.items).toHaveLength(1) };
  },
  'provider.customer_note_create': async (h) => {
    const as = await h.member('provider', 'provider_staff');
    const { customer } = await customerOf(h, as);
    // SEC-AZ-4: a provider without a relationship to the customer gets 422 REFERENCE_NOT_FOUND.
    return { as, body: { customer_user_id: customer.user.id, body: 'Prefers morning slots' }, bodyRefs: true };
  },
  'provider.customer_note_update': async (h) => {
    const as = await h.member('provider', 'provider_staff');
    const { customer } = await customerOf(h, as);
    const note = ok(
      await as.c.post(`${prv(as)}/customer-notes`, { customer_user_id: customer.user.id, body: 'Prefers morning slots' }),
      'note',
    );
    return { as, params: { note_id: note.id as string }, version: note.version as number, body: { body: 'Prefers afternoons' } };
  },
  'provider.customer_note_delete': async (h) => {
    const as = await h.member('provider');
    const { customer } = await customerOf(h, as);
    const note = ok(
      await as.c.post(`${prv(as)}/customer-notes`, { customer_user_id: customer.user.id, body: 'Prefers morning slots' }),
      'note',
    );
    return { as, params: { note_id: note.id as string } };
  },
  'provider.portfolio_list': async (h) => ({ as: await h.member('provider', 'provider_staff') }),
  'provider.portfolio_create': async (h) => ({ as: await h.member('provider', 'provider_staff'), body: portfolioItem(h) }),
  'provider.portfolio_update': async (h) => {
    const as = await h.member('provider', 'provider_staff');
    const item = ok(await as.c.post(`${prv(as)}/portfolio`, portfolioItem(h)), 'portfolio item');
    return { as, params: { item_id: item.id as string }, version: item.version as number, body: { title: 'Control arm and bushings' } };
  },
  'provider.portfolio_consent_request': async (h) => {
    const as = await h.member('provider', 'provider_staff');
    const { appointmentId } = await customerOf(h, as);
    const item = ok(await as.c.post(`${prv(as)}/portfolio`, portfolioItem(h)), 'portfolio item');
    return { as, params: { item_id: item.id as string }, body: { appointment_id: appointmentId } };
  },
  'provider.portfolio_publish': async (h) => {
    const as = await h.member('provider');
    const item = ok(await as.c.post(`${prv(as)}/portfolio`, portfolioItem(h)), 'portfolio item');
    const asset = await h.upload(as, 'portfolio');
    ok(
      await as.c.post('/v1/media/attachments', {
        media_asset_id: asset.id,
        attached_to: { type: 'portfolio_item', id: item.id },
        role: 'gallery',
        display_order: 0,
      }),
      'attachment',
    );
    return { as, params: { item_id: item.id as string }, check: (res) => expect(res.body.status).toBe('pending_review') };
  },
  'provider.portfolio_archive': async (h) => {
    const as = await h.member('provider');
    const item = ok(await as.c.post(`${prv(as)}/portfolio`, portfolioItem(h)), 'portfolio item');
    return { as, params: { item_id: item.id as string } };
  },
  'provider.insights_get': async (h) => ({ as: await h.member('provider', 'provider_manager'), query: { from: daysAgo(30), to: today() } }),

  // ------------------------------------------------------------ §9 vendor profile
  'vendor.profile_get': async (h) => {
    const owner = await vendorWithProfile(h);
    return { as: await h.colleague(owner, 'vendor_staff') };
  },
  'vendor.profile_put': async (h) => ({ as: await h.member('vendor'), body: vendorProfile() }),
  'vendor.publish': async (h) => {
    const as = await vendorWithProfile(h, { catalog_coming_soon: true });
    ok(await as.c.post(`/v1/orgs/${as.org!.id}/locations`, location({ pin: uniquePoint() })), 'location');
    return { as, check: (res) => expect(res.body).toEqual({ public_status: 'published', unmet: [] }) };
  },
  'vendor.unpublish': async (h) => ({ as: (await h.vendor()).as, body: { reason: 'Closing for renovation' } }),
  'vendor.coverage_list': async (h) => ({ as: await h.member('vendor', 'vendor_staff') }),
  'vendor.coverage_create': async (h) => ({
    as: await h.member('vendor'),
    body: { items: [{ taxonomy_node_id: h.n.brand, coverage_type: 'brand' }] },
  }),
  'vendor.coverage_delete': async (h) => {
    const as = await h.member('vendor');
    const cov = ok(
      await as.c.post(`${vnd(as)}/coverage`, { items: [{ taxonomy_node_id: h.n.brand, coverage_type: 'brand' }] }),
      'coverage',
    );
    return { as, params: { coverage_id: created(cov) } };
  },
  'vendor.insights_get': async (h) => ({ as: await h.member('vendor', 'vendor_staff'), query: { from: daysAgo(30), to: today() } }),

  // ------------------------------------------------------------ §14.3 public profiles
  'public.org_get': async (h) => {
    // An approximate location: the public read shows the rounded point and the city, never the street (SEC-OUT-4).
    const p = await h.provider({ location: { public_address_visibility: 'approximate', service_radius_km: 10 } });
    const slug = ok(await p.as.c.get(`/v1/orgs/${p.id}`), 'org').slug as string;
    return {
      as: await h.anonymous(),
      params: { slug },
      check: (res) => {
        expect(res.text).not.toContain('Desert Road');
        expect(res.text).not.toContain(String(p.point.lat));
        expect(res.body.locations[0]).toMatchObject({ visibility: 'approximate', address: { address_line_1: null } });
      },
    };
  },
  'public.org_portfolio': async (h) => {
    const p: Published = await sharedProvider(h);
    await showcase(h, p);
    return { as: await h.anonymous(), params: { org_id: p.id }, check: (res) => expect(res.body.items.length).toBeGreaterThan(0) };
  },

  // ------------------------------------------------------------ §23.2 administration
  'admin.orgs_search': async (h) => {
    const p = await sharedProvider(h);
    return { as: await h.staff('platform_support'), body: { organization_id: p.id } };
  },
  'admin.org_get': async (h) => {
    const p = await sharedProvider(h);
    const caseId = await openCase(h.api, { type: 'organization', targetId: p.id });
    return { as: await h.staff('platform_moderator'), params: { org_id: p.id }, headers: purpose('case', caseId) };
  },
  'admin.org_status': async (h) => {
    const p = await h.provider();
    return { as: await h.staff('platform_moderator'), params: { org_id: p.id }, body: { status: 'suspended', reason: REASON } };
  },
  'admin.org_merge': async (h) => {
    const [x, y] = await Promise.all([h.fx.org('provider'), h.fx.org('provider')]);
    return {
      as: await h.staff('platform_admin'),
      params: { org_id: x.id },
      body: { into_organization_id: y.id, reason: REASON },
      check: (res) => h.rejectChange(res.body.change_id as string),
    };
  },
  'admin.verifications_queue': async (h) => ({ as: await h.staff('platform_moderator'), query: { status: 'pending', limit: 10 } }),
  'admin.verification_decide': async (h) => {
    const as = await h.member('provider');
    const v = ok(await as.c.post(`/v1/orgs/${as.org!.id}/verifications`, { verification_type: 'business_identity' }), 'verification');
    return {
      as: await h.staff('platform_moderator'),
      params: { verification_id: v.id as string },
      headers: purpose('verification', v.id as string),
      body: { decision: 'verified', reason: REASON },
    };
  },
  'admin.location_correct': async (h) => {
    const p = await h.provider();
    return {
      as: await h.staff('platform_moderator'),
      params: { org_id: p.id, location_id: p.locationId },
      body: { pin: { lat: p.point.lat + 0.001, lng: p.point.lng }, reason: REASON },
    };
  },
};
