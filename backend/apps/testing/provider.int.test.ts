// S4 provider and vendor profiles (40 §8, §9): the publish flow of the
// acceptance criteria (with the public projection of an approximate
// location), the capability portfolio and its approval gate, work records,
// portfolio consent and publication, vendor profiles, and record-level BOLA
// (a member of A naming B's records under A's path gets 404).
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '#libs/crypto/index.js';
import { jpegWithExif } from '#libs/testing/index.js';
import { OrganizationExtensions } from '#modules/organization/interface/extensions.js';
import { PublicProfiles } from '#modules/organization/interface/public-profiles.js';
import { OutboxRelayService } from '#workers/outbox-relay/outbox-relay.module.js';
import { MediaHarness, idem, mailedToken, taxonomyNodes, type Json, type Nodes } from './s4-support.js';
import { createTestApp, type TestApp } from './test-app.js';

let app: TestApp;
let media: MediaHarness;
let n: Nodes;

/** Appointment visits and their customers (appointment module, S7), registered for the tests; service records and vehicles are real (S5). */
const visits = new Map<string, { provider: string; customer: string; vehicle: string | null }>();

beforeAll(async () => {
  app = await createTestApp({ host: 'api' });
  media = await MediaHarness.start(app);
  n = await taxonomyNodes(app);
  const ext = app.app.get(OrganizationExtensions, { strict: false });
  const resolver = async (_s: unknown, providerOrgId: string, id: string) => {
    const v = visits.get(id);
    return v && v.provider === providerOrgId ? { customerUserId: v.customer, vehicleId: v.vehicle } : null;
  };
  ext.registerVisits('appointment', resolver);
  ext.registerCustomerCheck(async (_s, providerOrgId, userId) =>
    [...visits.values()].some((v) => v.provider === providerOrgId && v.customer === userId),
  );
});
afterAll(async () => {
  await media.close();
  await app.close();
});

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
const profile = (o: Json = {}) => ({
  provider_type: 'mobile_mechanic',
  service_modes: ['mobile'],
  price_tier: 'mid_range',
  warranty_offered: false,
  description_translations: { en: 'Suspension work at your door', fa: 'تعمیر جلوبندی در محل' },
  contact_channels: [{ type: 'whatsapp', value: '+989121234567', preferred: true }],
  languages_spoken: ['fa', 'en'],
  ...o,
});

function api(token: string) {
  return {
    get: (path: string) => app.request<Json>({ path, token }),
    post: (path: string, body?: unknown, headers: Record<string, string> = {}) =>
      app.request<Json>({ method: 'POST', path, token, headers: { ...idem(), ...headers }, ...(body !== undefined ? { body } : {}) }),
    put: (path: string, body: unknown, headers: Record<string, string> = {}) =>
      app.request<Json>({ method: 'PUT', path, token, body, headers }),
    patch: (path: string, body: unknown, etag: string) =>
      app.request<Json>({ method: 'PATCH', path, token, body, headers: { 'if-match': etag } }),
    del: (path: string) => app.request<Json>({ method: 'DELETE', path, token }),
  };
}

describe('S4 acceptance: create, locate by pin, complete, publish', () => {
  it('a user creates a provider, adds a location by pin, completes the profile and publishes; the public read hides the street of an approximate location', async () => {
    const user = await app.fixtures.user();
    const c = api(await app.fixtures.token(user));
    const org = (await c.post('/v1/orgs', { name: 'Mobile Fix', organization_type: 'provider', contact_email: 'fix@example.com' })).body;
    const prv = `/v1/orgs/${org.id}/provider`;

    // Nothing yet: the problem names every missing requirement (DI-10).
    const early = await c.post(`${prv}/publish`);
    expect(early.status).toBe(409);
    expect(early.body).toMatchObject({
      code: 'PUBLISH_REQUIREMENTS_UNMET',
      requirements: ['provider_profile', 'active_location', 'service_category', 'supported_brand'],
    });

    const loc = await c.post(
      `/v1/orgs/${org.id}/locations`,
      location({ public_address_visibility: 'approximate', service_radius_km: 12, access_instructions_translations: { en: 'Ring twice' } }),
    );
    expect(loc.status).toBe(201);
    // PUT creates (Idempotency-Key, no If-Match) and later replaces (If-Match).
    const created = await c.put(`${prv}/profile`, profile(), idem());
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ public_status: 'draft', organization_id: org.id, version: 1, languages_spoken: ['fa', 'en'] });
    expect(created.body.completeness_gaps).toContain('service_categories');
    expect((await c.put(`${prv}/profile`, profile())).status).toBe(428);
    expect((await c.put(`${prv}/profile`, profile({ warranty_offered: true }), { 'if-match': '"v1"' })).body.errors).toEqual([
      { pointer: '/warranty_policy_translations', code: 'conditional_required' },
    ]);
    expect(
      (
        await c.put(`${prv}/profile`, profile({ contact_channels: [{ type: 'email', value: 'not-an-email', preferred: false }] }), {
          'if-match': '"v1"',
        })
      ).body.errors,
    ).toEqual([{ pointer: '/contact_channels/0/value', code: 'pattern' }]);
    expect(
      (await c.post(`${prv}/service-categories`, { taxonomy_node_id: n.system, experience_level: 'advanced', visibility: 'public' }))
        .status,
    ).toBe(201);
    const still = await c.post(`${prv}/publish`);
    expect(still.body.requirements).toEqual(['supported_brand']);
    expect(
      (await c.post(`${prv}/coverage`, { items: [{ brand_node_id: n.brand, coverage_level: 'specialist' }] })).body.created,
    ).toHaveLength(1);

    const pub = await c.post(`${prv}/publish`);
    expect(pub.status).toBe(200);
    expect(pub.body).toEqual({ public_status: 'published', unmet: [] });
    // The draft organization went live with its profile (DI-18), and the event is in the outbox.
    expect((await c.get(`/v1/orgs/${org.id}`)).body.status).toBe('active');
    const events = await app.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
      db.selectFrom('core.domain_event_outbox').select('event_type').where('aggregate_id', '=', org.id).execute(),
    );
    // S6: profile and location edits publish organization.profile.updated for the search indexer (DI-45).
    expect(events.map((e) => e.event_type).filter((t) => t !== 'organization.profile.updated')).toEqual(['provider.profile.published']);

    // Public read (anonymous RLS context): public point only, no street line, no access instructions.
    const pp = app.app.get(PublicProfiles, { strict: false });
    const anon = { actorType: 'anonymous' as const };
    const tx = app.app.get((await import('#libs/tenancy/index.js')).TxRunner, { strict: false });
    const pub2 = await tx.run(anon, (s) => pp.profile(s, org.id, 'en'));
    expect(pub2).toMatchObject({
      name: 'Mobile Fix',
      roles: ['provider'],
      verified: false,
      description: { text: 'Suspension work at your door', locale: 'en' },
    });
    expect(pub2!.locations).toEqual([
      expect.objectContaining({
        visibility: 'approximate',
        point: { lat: 35.76, lng: 51.41 },
        address: { address_line_1: null, city: 'Tehran', region: null, country: 'IR' },
        access_instructions: null,
        service_radius_km: 12,
      }),
    ]);
    expect(JSON.stringify(pub2)).not.toContain('Valiasr');
    expect(JSON.stringify(pub2)).not.toContain('35.757512');
    expect(pub2!.provider).toMatchObject({
      provider_type: 'mobile_mechanic',
      capabilities: [],
      service_categories: [expect.objectContaining({ node_id: n.system })],
    });
    const pins = await tx.run(anon, (s) => pp.pins(s, [org.id]));
    expect(pins.get(org.id)).toEqual([
      { location_id: loc.body.id, point: { lat: 35.76, lng: 51.41 }, visibility: 'approximate', service_radius_km: 12, city: 'Tehran' },
    ]);

    // Unpublishing takes it off public reads (owner only) and is audited with the reason.
    expect((await c.post(`${prv}/unpublish`, { reason: 'Moving to a new garage' })).body).toEqual({ public_status: 'draft', unmet: [] });
    expect(await tx.run(anon, (s) => pp.profile(s, org.id, 'en'))).toBeNull();
    const audit = await app.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
      db
        .selectFrom('analytics.audit_logs')
        .select(['action', 'reason'])
        .where('entity_id', '=', created.body.id)
        .orderBy('created_at')
        .execute(),
    );
    expect(audit).toEqual([
      { action: 'provider.published', reason: null },
      { action: 'provider.unpublished', reason: 'Moving to a new garage' },
    ]);
  });
});

describe('capability portfolio (54 §2)', () => {
  it('validates parent chains, skips duplicates per row and starts self-declared claims at level 0', async () => {
    const { org, token } = await app.fixtures.memberOf('provider', 'provider_manager');
    const c = api(token);
    const prv = `/v1/orgs/${org.id}/provider`;
    const cov = await c.post(`${prv}/coverage`, {
      items: [
        { brand_node_id: n.brand, model_node_id: n.model, series_node_id: n.series, coverage_level: 'advanced' },
        { brand_node_id: n.brand, model_node_id: n.otherModel, coverage_level: 'basic' },
        { brand_node_id: n.brand, series_node_id: n.series, coverage_level: 'basic' },
        { brand_node_id: n.brand, model_node_id: n.model, series_node_id: n.series, coverage_level: 'basic' },
      ],
    });
    expect(cov.status).toBe(200);
    expect(cov.body.created).toHaveLength(1);
    expect(cov.body.skipped).toEqual([
      { index: 1, code: 'reference_not_found' },
      { index: 2, code: 'conditional_required' },
      { index: 3, code: 'not_unique' },
    ]);
    // A node of the wrong type fails the whole request (NodeId<type>, GD-17).
    expect((await c.post(`${prv}/coverage`, { items: [{ brand_node_id: n.model, coverage_level: 'basic' }] })).body.code).toBe(
      'TAXONOMY_MISMATCH',
    );

    const cap = await c.post(`${prv}/capabilities`, {
      brand_node_id: n.brand,
      model_node_id: n.model,
      service_system_node_id: n.system,
      service_task_node_id: n.task,
      experience_level: 'specialist',
      public_visibility: true,
    });
    expect(cap.status).toBe(201);
    expect(cap.body).toMatchObject({
      confidence_level: 'self_declared',
      confidence_score: '0.00',
      evidence_count: 0,
      badge_eligible: false,
      source: 'self_declared',
      status: 'active',
    });
    const dup = await c.post(`${prv}/capabilities`, {
      brand_node_id: n.brand,
      model_node_id: n.model,
      service_system_node_id: n.system,
      service_task_node_id: n.task,
      experience_level: 'beginner',
      public_visibility: false,
    });
    expect(dup.status).toBe(409);
    const mismatch = await c.post(`${prv}/capabilities`, {
      service_system_node_id: n.system,
      service_task_node_id: n.otherTask,
      experience_level: 'beginner',
      public_visibility: false,
    });
    expect(mismatch.body).toMatchObject({ code: 'TAXONOMY_MISMATCH' });
    const upd = await c.patch(`${prv}/capabilities/${cap.body.id}`, { experience_level: 'advanced' }, `"v${cap.body.version}"`);
    expect(upd.body).toMatchObject({ experience_level: 'advanced', version: 2 });
    // Deactivated rows can be declared again.
    expect((await c.del(`${prv}/capabilities/${cap.body.id}`)).status).toBe(200);
    expect((await c.get(`${prv}/capabilities?status=inactive`)).body.items.map((x: Json) => x.id)).toEqual([cap.body.id]);
    expect(
      (
        await c.post(`${prv}/capabilities`, {
          brand_node_id: n.brand,
          model_node_id: n.model,
          service_system_node_id: n.system,
          service_task_node_id: n.task,
          experience_level: 'beginner',
          public_visibility: false,
        })
      ).status,
    ).toBe(201);
    // Staff of the provider read but do not write the catalog (P* vs P+).
    const staff = await app.fixtures.user();
    await app.fixtures.member(staff, org, 'provider_staff');
    const s = api(await app.fixtures.token(staff));
    expect((await s.get(`${prv}/capabilities`)).status).toBe(200);
    expect(
      (await s.post(`${prv}/capabilities`, { service_system_node_id: n.system, experience_level: 'beginner', public_visibility: false }))
        .status,
    ).toBe(404);
  });

  it('nothing AI-suggested counts or shows before the provider decides (gated_decide)', async () => {
    const { org, token } = await app.fixtures.memberOf('provider', 'provider_owner');
    const c = api(token);
    const prv = `/v1/orgs/${org.id}/provider`;
    const insight = uuidv7();
    const ids = await app.fixtures.worker.run({ actorType: 'system' }, async ({ db }) => {
      const cat = await db
        .insertInto('organization.provider_service_categories')
        .values({
          provider_organization_id: org.id,
          taxonomy_node_id: n.task,
          experience_level: 'intermediate',
          source: 'ai_suggested',
          ai_insight_id: insight,
          status: 'pending_provider_approval',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const cap = await db
        .insertInto('organization.provider_capabilities')
        .values({ provider_organization_id: org.id, service_system_node_id: n.system, experience_level: 'beginner' })
        .returning('id')
        .executeTakeFirstOrThrow();
      const ev = await db
        .insertInto('organization.provider_capability_evidence')
        .values({
          capability_id: cap.id,
          evidence_type: 'verified_review',
          reference_entity_type: 'review',
          reference_entity_id: uuidv7(),
          base_weight: 8,
          evidence_date: '2026-09-01',
          linked_by: 'ai_mapping',
          ai_insight_id: insight,
          status: 'pending_approval',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return { cat: cat.id, cap: cap.id, ev: ev.id };
    });
    const pending = await c.get(`${prv}/service-categories?status=pending_provider_approval`);
    expect(pending.body.items).toEqual([expect.objectContaining({ id: ids.cat, source: 'ai_suggested', ai_insight_id: insight })]);
    const ok = await c.post(`${prv}/service-categories/${ids.cat}/decision`, { decision: 'approve' });
    expect(ok.body).toMatchObject({ id: ids.cat, status: 'active' });
    const again = await c.post(`${prv}/service-categories/${ids.cat}/decision`, { decision: 'reject' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INVALID_TRANSITION');
    const ev = await c.post(`${prv}/evidence/${ids.ev}/decision`, { decision: 'reject' });
    expect(ev.body).toMatchObject({ id: ids.ev, status: 'revoked', reference: { type: 'review' }, linked_by: 'ai_mapping' });
    expect((await c.get(`${prv}/capabilities/${ids.cap}/evidence`)).body.items.map((e: Json) => e.status)).toEqual(['revoked']);
    // Self-declared rows are not gated.
    expect((await c.post(`${prv}/capabilities/${ids.cap}/decision`, { decision: 'approve' })).status).toBe(409);
  });
});

describe('certifications and work records', () => {
  it('certifications: a clean private document enters verification; changing it resets; removal revokes evidence', async () => {
    const { org, token } = await app.fixtures.memberOf('provider', 'provider_owner');
    const c = api(token);
    const prv = `/v1/orgs/${org.id}/provider`;
    const doc = await media.upload(token, {
      owner: { type: 'organization', id: org.id },
      purpose: 'certification_document',
      mime: 'image/jpeg',
      bytes: await jpegWithExif(64, 64),
    });
    const cert = await c.post(`${prv}/certifications`, {
      certification_type: 'ev_high_voltage',
      name: 'EV Level 3',
      issuer: 'IMI',
      scope_node_ids: [n.brand, n.system],
      issued_at: '2025-01-10',
      document_media_asset_id: doc.id,
    });
    expect(cert.status).toBe(201);
    expect(cert.body).toMatchObject({ verification_status: 'pending', status: 'active', scope_node_ids: [n.brand, n.system] });
    expect(
      (await c.post(`${prv}/certifications`, { certification_type: 'other', name: 'X1', issuer: 'Y1', issued_at: '2999-01-01' })).body
        .errors,
    ).toEqual([{ pointer: '/issued_at', code: 'in_future' }]);
    expect(
      (await c.post(`${prv}/certifications`, { certification_type: 'other', name: 'X1', issuer: 'Y1', scope_node_ids: [n.task] })).body
        .code,
    ).toBe('TAXONOMY_MISMATCH');
    await app.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
      db
        .updateTable('organization.provider_certifications')
        .set({ verification_status: 'verified' })
        .where('id', '=', cert.body.id)
        .execute(),
    );
    const upd = await c.patch(`${prv}/certifications/${cert.body.id}`, { credential_number: 'EV-123' }, '"v2"');
    expect(upd.body).toMatchObject({ verification_status: 'pending', credential_number: 'EV-123' });
    const cap = await c.post(`${prv}/capabilities`, {
      service_system_node_id: n.system,
      experience_level: 'advanced',
      public_visibility: true,
    });
    const evId = await app.fixtures.worker.run(
      { actorType: 'system' },
      async ({ db }) =>
        (
          await db
            .insertInto('organization.provider_capability_evidence')
            .values({
              capability_id: cap.body.id,
              evidence_type: 'certification',
              reference_entity_type: 'certification',
              reference_entity_id: cert.body.id,
              base_weight: 15,
              evidence_date: '2025-01-10',
              linked_by: 'system_rule',
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id,
    );
    expect((await c.del(`${prv}/certifications/${cert.body.id}`)).status).toBe(200);
    expect((await c.get(`${prv}/certifications`)).body.items).toEqual([]);
    const ev = await app.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
      db.selectFrom('organization.provider_capability_evidence').select('status').where('id', '=', evId).executeTakeFirstOrThrow(),
    );
    expect(ev.status).toBe('revoked');
  });

  it("job logs link a customer vehicle only with the owner's vehicle_data_sharing consent (CNS)", async () => {
    const { org, user, token } = await app.fixtures.memberOf('provider', 'provider_staff');
    const c = api(token);
    const prv = `/v1/orgs/${org.id}/provider`;
    const customer = await app.fixtures.user();
    const vehicle = await app.fixtures.vehicle(customer, n);
    const base = { job_date: '2026-09-30', service_system_node_id: n.system, brand_node_id: n.brand, model_node_id: n.model };
    const plain = await c.post(`${prv}/job-logs`, base);
    expect(plain.body).toMatchObject({ logged_by_user_id: user.id, verification_status: 'self_reported', status: 'active' });
    const denied = await c.post(`${prv}/job-logs`, { ...base, vehicle_id: vehicle });
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ code: 'CONSENT_REQUIRED', consent_type: 'vehicle_data_sharing' });
    // The customer grants vehicle data sharing to this provider (the owner comes from vehicle.vehicle_owner, S5).
    await app.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
      db
        .insertInto('identity.consent_records')
        .values({
          subject_type: 'user',
          subject_id: customer.id,
          consent_type: 'vehicle_data_sharing',
          scope_entity_type: 'vehicle',
          scope_entity_id: vehicle,
          granted_to_type: 'organization',
          granted_to_id: org.id,
          policy_version: '2026-10',
          granted: true,
          granted_at: sql`now()`,
          source: 'ui',
        })
        .execute(),
    );
    const linked = await c.post(`${prv}/job-logs`, { ...base, vehicle_id: vehicle });
    expect(linked.status).toBe(201);
    expect(linked.body.vehicle_id).toBe(vehicle);
    expect((await c.post(`${prv}/job-logs`, { ...base, job_date: '2999-01-01' })).body.errors).toEqual([
      { pointer: '/job_date', code: 'in_future' },
    ]);
    expect((await c.post(`${prv}/job-logs`, { ...base, appointment_id: uuidv7() })).body.code).toBe('REFERENCE_NOT_FOUND');
    // Corrections need P+ (staff: 404); listing filters by date.
    expect((await c.patch(`${prv}/job-logs/${plain.body.id}`, { description: 'x' }, '"v1"')).status).toBe(404);
    expect((await c.get(`${prv}/job-logs?from=2026-09-30&to=2026-09-30`)).body.items).toHaveLength(2);
    expect((await c.get(`${prv}/job-logs?from=2026-10-01`)).body.items).toHaveLength(0);
  });

  it('customer notes are private to the provider and need a customer relationship', async () => {
    const { org, token } = await app.fixtures.memberOf('provider', 'provider_owner');
    const c = api(token);
    const prv = `/v1/orgs/${org.id}/provider`;
    const customer = await app.fixtures.user();
    const stranger = await app.fixtures.user();
    visits.set(uuidv7(), { provider: org.id, customer: customer.id, vehicle: null });
    const note = await c.post(`${prv}/customer-notes`, { customer_user_id: customer.id, body: 'Prefers morning slots' });
    expect(note.status).toBe(201);
    expect((await c.post(`${prv}/customer-notes`, { customer_user_id: stranger.id, body: 'x' })).body).toMatchObject({
      code: 'REFERENCE_NOT_FOUND',
      errors: [{ pointer: '/customer_user_id', code: 'reference_not_found' }],
    });
    const list = await c.get(`${prv}/customer-notes?customer_user_id=${customer.id}`);
    expect(list.headers['cache-control']).toBe('no-store');
    expect(list.body.items.map((x: Json) => x.body)).toEqual(['Prefers morning slots']);
    const upd = await c.patch(`${prv}/customer-notes/${note.body.id}`, { body: 'Prefers afternoons' }, '"v1"');
    expect(upd.body.body).toBe('Prefers afternoons');
    // Another provider sees nothing.
    const other = await app.fixtures.memberOf('provider', 'provider_owner');
    expect(
      (await api(other.token).get(`/v1/orgs/${other.org.id}/provider/customer-notes?customer_user_id=${customer.id}`)).body.items,
    ).toEqual([]);
  });
});

describe('portfolio: consent request → grant → publish → withdrawal', () => {
  it("publishes only with a clean attachment and the customer's showcase consent; withdrawal takes it down", async () => {
    const { org, token } = await app.fixtures.memberOf('provider', 'provider_owner');
    const c = api(token);
    const prv = `/v1/orgs/${org.id}/provider`;
    const customer = await app.fixtures.user();
    const appointment = uuidv7();
    visits.set(appointment, { provider: org.id, customer: customer.id, vehicle: null });
    const item = await c.post(`${prv}/portfolio`, {
      title: 'Control arm replacement',
      content_locale: 'en',
      brand_node_id: n.brand,
      model_node_id: n.model,
      service_system_node_id: n.system,
      tag_node_ids: [n.brand],
      caption: 'Old vs new arm',
      caption_source: 'manual',
      visibility: 'public',
    });
    expect(item.status).toBe(201);
    expect(item.body).toMatchObject({ status: 'draft', customer_consent_status: 'not_required', moderation_status: 'pending', media: [] });
    expect(
      (
        await c.post(`${prv}/portfolio`, {
          title: 'X1x',
          content_locale: 'en',
          service_system_node_id: n.system,
          caption: 'c',
          visibility: 'public',
        })
      ).body.errors,
    ).toEqual([{ pointer: '/caption_source', code: 'conditional_required' }]);
    const unmet = await c.post(`${prv}/portfolio/${item.body.id}/publish`);
    expect(unmet.body).toMatchObject({ code: 'PUBLISH_REQUIREMENTS_UNMET', requirements: ['media'] });
    const asset = await media.upload(token, {
      owner: { type: 'organization', id: org.id },
      purpose: 'portfolio',
      mime: 'image/jpeg',
      bytes: await jpegWithExif(64, 64),
    });
    expect(
      (
        await app.request({
          method: 'POST',
          path: '/v1/media/attachments',
          token,
          headers: idem(),
          body: { media_asset_id: asset.id, attached_to: { type: 'portfolio_item', id: item.body.id }, role: 'gallery', display_order: 0 },
        })
      ).status,
    ).toBe(201);

    // Linking the customer's visit makes consent necessary; exactly one visit is named.
    expect((await c.post(`${prv}/portfolio/${item.body.id}/consent-request`, {})).body.errors).toEqual([
      { pointer: '/appointment_id', code: 'conditional_required' },
    ]);
    expect((await c.post(`${prv}/portfolio/${item.body.id}/consent-request`, { appointment_id: uuidv7() })).body.code).toBe(
      'REFERENCE_NOT_FOUND',
    );
    const req = await c.post(`${prv}/portfolio/${item.body.id}/consent-request`, { appointment_id: appointment });
    expect(req.status).toBe(202);
    expect((await c.post(`${prv}/portfolio/${item.body.id}/consent-request`, { appointment_id: appointment })).status).toBe(409);
    const blocked = await c.post(`${prv}/portfolio/${item.body.id}/publish`);
    expect(blocked.status).toBe(403);
    expect(blocked.body).toMatchObject({ code: 'CONSENT_REQUIRED', consent_type: 'showcase_publishing' });

    // The customer opens the cn link from their mail (the provider never saw their address) and grants.
    const link = mailedToken(app, customer.email, 'identity.consent_request');
    const customerToken = await app.fixtures.token(customer, { acr: 'aal2', authTime: Math.floor(Date.now() / 1000) });
    const view = await app.request<Json>({
      method: 'POST',
      path: '/v1/consent-requests/view',
      token: customerToken,
      body: { token: link },
    });
    expect(view.body).toMatchObject({
      consent_type: 'showcase_publishing',
      scope: { type: 'portfolio_item', id: item.body.id },
      requested_by: { id: org.id },
    });
    const grant = await app.request<Json>({
      method: 'POST',
      path: '/v1/consent-requests/respond',
      token: customerToken,
      headers: idem(),
      body: { token: link, decision: 'grant', policy_version: '2026-10' },
    });
    expect(grant.status).toBe(200);

    const sent = await c.post(`${prv}/portfolio/${item.body.id}/publish`);
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({
      status: 'pending_review',
      moderation_status: 'pending',
      customer_consent_status: 'granted',
      consent_reference_id: grant.body.consent.id,
      appointment_id: appointment,
    });
    expect(sent.body.media).toHaveLength(1);
    // Editing an item under review keeps it in review; archive is final.
    expect((await c.post(`${prv}/portfolio/${item.body.id}/publish`)).body.code).toBe('INVALID_TRANSITION');

    // Withdrawal (consents.withdraw → consent.withdrawn → organization consumer) takes it off review/publication.
    const w = await app.request<Json>({
      method: 'POST',
      path: `/v1/me/consents/${grant.body.consent.id}/withdraw`,
      token: customerToken,
      headers: idem(),
    });
    expect(w.status).toBe(200);
    const relay = media.worker.get(OutboxRelayService).relay;
    await relay.settle();
    await relay.drainOnce();
    await app.infra.bus.idle();
    const after = (await c.get(`${prv}/portfolio`)).body.items.find((x: Json) => x.id === item.body.id);
    expect(after).toMatchObject({ status: 'draft', customer_consent_status: 'withdrawn', consent_reference_id: null });
    const archived = await c.post(`${prv}/portfolio/${item.body.id}/archive`);
    expect(archived.body.status).toBe('archived');
    expect((await c.patch(`${prv}/portfolio/${item.body.id}`, { title: 'New title' }, `"v${archived.body.version}"`)).body.code).toBe(
      'INVALID_TRANSITION',
    );
  });
});

describe('vendor profile (40 §9)', () => {
  it('publishes with "catalog coming soon", keeps coverage types consistent and refuses shipping_future', async () => {
    const user = await app.fixtures.user();
    const c = api(await app.fixtures.token(user));
    const org = (await c.post('/v1/orgs', { name: 'Mina Parts', organization_type: 'vendor', contact_email: 'mina@example.com' })).body;
    const vnd = `/v1/orgs/${org.id}/vendor`;
    const write = {
      vendor_type: 'parts_retailer',
      delivery_options: ['pickup'],
      trade_customers_supported: true,
      default_price_visibility: 'public',
    };
    expect((await c.put(`${vnd}/profile`, { ...write, delivery_options: ['shipping_future'] }, idem())).status).toBe(422);
    const p = await c.put(`${vnd}/profile`, write, idem());
    expect(p.body).toMatchObject({ public_status: 'draft', catalog_quality_score: 0, catalog_coming_soon: false });
    await c.post(`/v1/orgs/${org.id}/locations`, location());
    expect((await c.post(`${vnd}/publish`)).body.requirements).toEqual(['active_item_or_coming_soon']);
    expect((await c.put(`${vnd}/profile`, { ...write, catalog_coming_soon: true }, { 'if-match': '"v1"' })).status).toBe(200);
    expect((await c.post(`${vnd}/publish`)).body).toEqual({ public_status: 'published', unmet: [] });
    const cov = await c.post(`${vnd}/coverage`, {
      items: [
        { taxonomy_node_id: n.brand, coverage_type: 'brand' },
        { taxonomy_node_id: n.partCategory, coverage_type: 'part_category' },
        { taxonomy_node_id: n.model, coverage_type: 'brand' },
        { taxonomy_node_id: n.brand, coverage_type: 'brand' },
      ],
    });
    expect(cov.body.created).toHaveLength(2);
    expect(cov.body.skipped).toEqual([
      { index: 2, code: 'enum' },
      { index: 3, code: 'not_unique' },
    ]);
    expect((await c.del(`${vnd}/coverage/${cov.body.created[0].id}`)).status).toBe(200);
    expect((await c.get(`${vnd}/coverage`)).body.items.map((x: Json) => x.status)).toEqual(['inactive', 'active']);
    const ins = await c.get(`${vnd}/insights?from=2026-01-01&to=2026-10-01`);
    expect(ins.body).toMatchObject({ period: { from: '2026-01-01', to: '2026-10-01' }, inquiries_received: 0, catalog_quality_score: 0 });
    expect((await c.get(`${vnd}/insights?from=2024-01-01&to=2026-10-01`)).status).toBe(422);
    // A provider organization has no vendor routes ({vnd}: 404).
    const prov = await app.fixtures.memberOf('provider', 'provider_owner');
    expect((await api(prov.token).get(`/v1/orgs/${prov.org.id}/vendor/profile`)).status).toBe(404);
  });
});

describe('record-level BOLA: org B records under org A paths', () => {
  it('a member of org A gets 404 for every §7-§9 record of org B', async () => {
    const a = await app.fixtures.memberOf('provider', 'provider_owner');
    const b = await app.fixtures.memberOf('provider', 'provider_owner');
    const va = await app.fixtures.memberOf('vendor', 'vendor_owner');
    const vb = await app.fixtures.memberOf('vendor', 'vendor_owner');
    const cb = api(b.token);
    const pb = `/v1/orgs/${b.org.id}/provider`;
    const customer = await app.fixtures.user();
    visits.set(uuidv7(), { provider: b.org.id, customer: customer.id, vehicle: null });
    const ids = {
      location_id: (await cb.post(`/v1/orgs/${b.org.id}/locations`, location())).body.id,
      membership_id: (await cb.get(`/v1/orgs/${b.org.id}/members`)).body.items[0].membership_id,
      certification_id: (await cb.post(`${pb}/certifications`, { certification_type: 'other', name: 'Cert', issuer: 'Issuer' })).body.id,
      category_id: (
        await cb.post(`${pb}/service-categories`, { taxonomy_node_id: n.system, experience_level: 'advanced', visibility: 'public' })
      ).body.id,
      coverage_id: (await cb.post(`${pb}/coverage`, { items: [{ brand_node_id: n.brand, coverage_level: 'basic' }] })).body.created[0].id,
      capability_id: (
        await cb.post(`${pb}/capabilities`, { service_system_node_id: n.system, experience_level: 'advanced', public_visibility: false })
      ).body.id,
      job_log_id: (await cb.post(`${pb}/job-logs`, { job_date: '2026-09-01', service_system_node_id: n.system })).body.id,
      note_id: (await cb.post(`${pb}/customer-notes`, { customer_user_id: customer.id, body: 'Note' })).body.id,
      item_id: (
        await cb.post(`${pb}/portfolio`, { title: 'Item B', content_locale: 'en', service_system_node_id: n.system, visibility: 'public' })
      ).body.id,
    };
    const vendorCoverage = (
      await api(vb.token).post(`/v1/orgs/${vb.org.id}/vendor/coverage`, { items: [{ taxonomy_node_id: n.brand, coverage_type: 'brand' }] })
    ).body.created[0].id;
    const token = await app.fixtures.token(a.user, { acr: 'aal2', authTime: Math.floor(Date.now() / 1000) });
    const A = `/v1/orgs/${a.org.id}`;
    const calls: [string, string, unknown?][] = [
      ['PATCH', `${A}/locations/${ids.location_id}`, {}],
      ['DELETE', `${A}/locations/${ids.location_id}`],
      ['PATCH', `${A}/members/${ids.membership_id}`, {}],
      ['DELETE', `${A}/members/${ids.membership_id}`],
      ['PATCH', `${A}/provider/certifications/${ids.certification_id}`, {}],
      ['DELETE', `${A}/provider/certifications/${ids.certification_id}`],
      ['PATCH', `${A}/provider/service-categories/${ids.category_id}`, {}],
      ['DELETE', `${A}/provider/service-categories/${ids.category_id}`],
      ['DELETE', `${A}/provider/coverage/${ids.coverage_id}`],
      ['PATCH', `${A}/provider/capabilities/${ids.capability_id}`, {}],
      ['DELETE', `${A}/provider/capabilities/${ids.capability_id}`],
      ['GET', `${A}/provider/capabilities/${ids.capability_id}/evidence`],
      ['POST', `${A}/provider/service-categories/${ids.category_id}/decision`, { decision: 'approve' }],
      ['POST', `${A}/provider/coverage/${ids.coverage_id}/decision`, { decision: 'approve' }],
      ['POST', `${A}/provider/capabilities/${ids.capability_id}/decision`, { decision: 'approve' }],
      ['PATCH', `${A}/provider/job-logs/${ids.job_log_id}`, {}],
      ['DELETE', `${A}/provider/job-logs/${ids.job_log_id}`],
      ['PATCH', `${A}/provider/customer-notes/${ids.note_id}`, { body: 'mine now' }],
      ['DELETE', `${A}/provider/customer-notes/${ids.note_id}`],
      ['PATCH', `${A}/provider/portfolio/${ids.item_id}`, {}],
      ['POST', `${A}/provider/portfolio/${ids.item_id}/consent-request`, { appointment_id: uuidv7() }],
      ['POST', `${A}/provider/portfolio/${ids.item_id}/publish`],
      ['POST', `${A}/provider/portfolio/${ids.item_id}/archive`],
      ['DELETE', `/v1/orgs/${va.org.id}/vendor/coverage/${vendorCoverage}`],
    ];
    const problems: string[] = [];
    for (const [method, path, body] of calls) {
      const tk = path.includes(va.org.id) ? va.token : token;
      const r = await app.request<Json>({
        method,
        path,
        token: tk,
        headers: { ...idem(), 'if-match': '"v1"' },
        ...(body !== undefined ? { body } : {}),
      });
      if (r.status !== 404) problems.push(`${method} ${path}: ${r.status} ${r.body?.code}`);
    }
    expect(problems).toEqual([]);
    // B's own records are untouched and still readable by B.
    expect((await cb.get(`${pb}/portfolio`)).body.items.map((x: Json) => x.status)).toEqual(['draft']);
    // Lists under A's path never contain B's rows.
    const ca = api(token);
    for (const p of [
      'locations',
      'provider/certifications',
      'provider/service-categories',
      'provider/coverage',
      'provider/capabilities',
      'provider/job-logs',
      'provider/portfolio',
    ])
      expect((await ca.get(`${A}/${p}`)).body.items).toEqual([]);
  });
});
