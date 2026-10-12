// S4 organizations (40 §7): creation with the default plan, members and mi
// invitations, locations with the pin-versus-address check and public point,
// the business location editor (geocoder, map links) and verifications.
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '#libs/crypto/index.js';
import { tinyPdf } from '#libs/testing/index.js';
import { MediaHarness, idem, mailedToken, type Json } from './s4-support.js';
import { createTestApp, type TestApp } from './test-app.js';

let app: TestApp;
let media: MediaHarness;

beforeAll(async () => {
  app = await createTestApp({ host: 'api' });
  media = await MediaHarness.start(app);
});
afterAll(async () => {
  await media.close();
  await app.close();
});

const fresh = () => ({ acr: 'aal2' as const, authTime: Math.floor(Date.now() / 1000) });

async function createOrg(token: string, type = 'provider', extra: Json = {}) {
  return app.request<Json>({
    method: 'POST',
    path: '/v1/orgs',
    token,
    headers: idem(),
    body: { name: 'Reza Auto Suspension', organization_type: type, contact_email: 'Shop@Example.com', ...extra },
  });
}

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

describe('org.create / get / update', () => {
  it('creates a draft organization with the caller as owner and the default plan of its audience', async () => {
    const user = await app.fixtures.user();
    const token = await app.fixtures.token(user);
    const r = await createOrg(token, 'provider', { description_translations: { en: 'Suspension specialists' } });
    expect(r.status).toBe(201);
    expect(r.headers.location).toBe(`/v1/orgs/${r.body.id}`);
    expect(r.body).toMatchObject({
      organization_type: 'provider',
      status: 'draft',
      verification_status: 'unverified',
      contact_email: 'shop@example.com',
      my_role: 'provider_owner',
      primary_location_id: null,
    });
    expect(r.headers.etag).toBe('"v1"');
    // The authorization cache was dropped: the new organization is reachable at once.
    const got = await app.request<Json>({ path: `/v1/orgs/${r.body.id}`, token });
    expect(got.status).toBe(200);
    const sub = await app.request<Json>({ path: `/v1/orgs/${r.body.id}/subscription`, token });
    expect(sub.status).toBe(200);
    expect(sub.body.plan.plan_key).toBe('provider_basic');
    for (const [type, plan] of [
      ['vendor', 'vendor_basic'],
      ['fleet', 'fleet_20'],
      ['hybrid_provider_vendor', 'provider_basic'],
    ] as const) {
      const o = await createOrg(token, type);
      expect((await app.request<Json>({ path: `/v1/orgs/${o.body.id}/subscription`, token })).body.plan.plan_key).toBe(plan);
    }
    const audit = await app.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
      db.selectFrom('analytics.audit_logs').select(['action', 'actor_id']).where('entity_id', '=', r.body.id).execute(),
    );
    expect(audit).toEqual([{ action: 'organization.created', actor_id: user.id }]);
  });

  it('requires a verified contact (403 VERIFIED_CONTACT_REQUIRED)', async () => {
    const user = await app.fixtures.user();
    await app.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
      db
        .updateTable('identity.user_accounts')
        .set({ email_verified_at: null, status: 'pending_verification' })
        .where('id', '=', user.id)
        .execute(),
    );
    const r = await createOrg(await app.fixtures.token(user));
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('VERIFIED_CONTACT_REQUIRED');
  });

  it('updates with If-Match, keeps slugs unique and limits slug changes to 2 per 30 days', async () => {
    const token = await app.fixtures.token(await app.fixtures.user());
    const org = (await createOrg(token)).body;
    const patch = (body: Json, etag: string) =>
      app.request<Json>({ method: 'PATCH', path: `/v1/orgs/${org.id}`, token, body, headers: { 'if-match': etag } });
    expect((await app.request<Json>({ method: 'PATCH', path: `/v1/orgs/${org.id}`, token, body: { name: 'X Y' } })).status).toBe(428);
    expect((await patch({ name: 'New Name' }, '"v9"')).status).toBe(412);
    const slug = `reza-${uuidv7().slice(-8)}`;
    const a = await patch({ name: 'New Name', slug, website: 'https://reza.example' }, '"v1"');
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ name: 'New Name', slug, website: 'https://reza.example', version: 2 });
    const other = (await createOrg(token)).body;
    const dup = await app.request<Json>({
      method: 'PATCH',
      path: `/v1/orgs/${other.id}`,
      token,
      body: { slug },
      headers: { 'if-match': '"v1"' },
    });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ code: 'DUPLICATE', errors: [{ pointer: '/slug', code: 'not_unique' }] });
    const b = await patch({ slug: `${slug}-2` }, '"v2"');
    expect(b.status).toBe(200);
    const c = await patch({ slug: `${slug}-3` }, '"v3"');
    expect(c.status).toBe(429);
    expect(c.body.code).toBe('RATE_LIMITED');
  });
});

describe('members and invitations', () => {
  it('invites by mi link; only the invited, verified email accepts it, once', async () => {
    const owner = await app.fixtures.user();
    const token = await app.fixtures.token(owner);
    const org = (await createOrg(token)).body;
    const invitee = await app.fixtures.user();
    const inv = await app.request<Json>({
      method: 'POST',
      path: `/v1/orgs/${org.id}/members/invitations`,
      token,
      headers: idem(),
      body: { email: invitee.email.toUpperCase(), role: 'provider_staff' },
    });
    expect(inv.status).toBe(201);
    expect(inv.body).toMatchObject({ invitation_id: expect.any(String), expires_at: expect.any(String) });
    // The same address again: 409 DUPLICATE.
    expect(
      (
        await app.request({
          method: 'POST',
          path: `/v1/orgs/${org.id}/members/invitations`,
          token,
          headers: idem(),
          body: { email: invitee.email, role: 'provider_staff' },
        })
      ).status,
    ).toBe(409);
    const list = await app.request<Json>({ path: `/v1/orgs/${org.id}/members?status=invited`, token });
    expect(list.body.items).toEqual([
      expect.objectContaining({
        membership_id: inv.body.invitation_id,
        user_id: null,
        full_name: null,
        email: invitee.email,
        role: 'provider_staff',
        status: 'invited',
      }),
    ]);
    const link = mailedToken(app, invitee.email, 'organization.member_invitation');
    expect(link).toMatch(/^cp_mi_/);

    // Someone else signed in: 403 LINK_RECIPIENT_MISMATCH; the link stays usable.
    const stranger = await app.fixtures.token(await app.fixtures.user());
    const wrong = await app.request<Json>({
      method: 'POST',
      path: '/v1/invitations/accept',
      token: stranger,
      headers: idem(),
      body: { token: link },
    });
    expect(wrong.status).toBe(403);
    expect(wrong.body.code).toBe('LINK_RECIPIENT_MISMATCH');

    const inviteeToken = await app.fixtures.token(invitee);
    const ok = await app.request<Json>({
      method: 'POST',
      path: '/v1/invitations/accept',
      token: inviteeToken,
      headers: idem(),
      body: { token: link },
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ role: 'provider_staff', status: 'active', organization: { id: org.id, name: 'Reza Auto Suspension' } });
    // The new member reaches the organization at once (authorization cache dropped, SEC-AU-3).
    expect((await app.request({ path: `/v1/orgs/${org.id}`, token: inviteeToken })).status).toBe(200);
    const again = await app.request<Json>({
      method: 'POST',
      path: '/v1/invitations/accept',
      token: inviteeToken,
      headers: idem(),
      body: { token: link },
    });
    expect(again.body.code).toBe('LINK_USED');
    const garbage = await app.request<Json>({
      method: 'POST',
      path: '/v1/invitations/accept',
      token: inviteeToken,
      headers: idem(),
      body: { token: `cp_mi_${'A'.repeat(43)}` },
    });
    expect(garbage.body.code).toBe('LINK_EXPIRED');
  });

  it('keeps one owner, lets only owners grant manager roles, and removes members at once', async () => {
    const owner = await app.fixtures.user();
    const token = await app.fixtures.token(owner, fresh());
    const org = (await createOrg(token)).body;
    const members = (await app.request<Json>({ path: `/v1/orgs/${org.id}/members`, token })).body.items;
    const self = members.find((m: Json) => m.user_id === owner.id);
    expect(self).toMatchObject({ role: 'provider_owner', status: 'active', version: 1 });
    const demote = await app.request<Json>({
      method: 'PATCH',
      path: `/v1/orgs/${org.id}/members/${self.membership_id}`,
      token,
      body: { role: 'provider_manager' },
      headers: { 'if-match': `"v${self.version}"` },
    });
    expect(demote.status).toBe(409);
    expect(demote.body.code).toBe('INVALID_TRANSITION');
    // AAL2 is required (stale session: 401).
    const stale = await app.fixtures.token(owner, { acr: 'aal1', authTime: Math.floor(Date.now() / 1000) - 3600 });
    expect(
      (
        await app.request({
          method: 'PATCH',
          path: `/v1/orgs/${org.id}/members/${self.membership_id}`,
          token: stale,
          body: { status: 'active' },
          headers: { 'if-match': '"v1"' },
        })
      ).status,
    ).toBe(401);

    const staff = await app.fixtures.user();
    await app.fixtures.member(staff, { id: org.id, type: 'provider' }, 'provider_staff');
    const staffToken = await app.fixtures.token(staff);
    expect((await app.request({ path: `/v1/orgs/${org.id}`, token: staffToken })).status).toBe(200);
    const row = (await app.request<Json>({ path: `/v1/orgs/${org.id}/members?role=provider_staff`, token })).body.items[0];
    const promote = await app.request<Json>({
      method: 'PATCH',
      path: `/v1/orgs/${org.id}/members/${row.membership_id}`,
      token,
      body: { role: 'provider_manager' },
      headers: { 'if-match': `"v${row.version}"` },
    });
    expect(promote.status).toBe(200);
    expect(promote.body).toMatchObject({ role: 'provider_manager', version: row.version + 1 });
    expect(promote.headers.etag).toBe(`"v${row.version + 1}"`);
    // A manager cannot remove an owner (lower roles only): 404.
    const mgrToken = await app.fixtures.token(staff);
    expect(
      (await app.request({ method: 'DELETE', path: `/v1/orgs/${org.id}/members/${self.membership_id}`, token: mgrToken })).status,
    ).toBe(404);
    const removed = await app.request({ method: 'DELETE', path: `/v1/orgs/${org.id}/members/${row.membership_id}`, token });
    expect(removed.status).toBe(200);
    // SEC-AU-3: the removed member loses the organization on the next request.
    expect((await app.request({ path: `/v1/orgs/${org.id}`, token: mgrToken })).status).toBe(404);
  });

  it('limits fleet seats (403 ENTITLEMENT_REQUIRED naming max_fleet_users) and lets coordinators invite drivers only', async () => {
    const owner = await app.fixtures.user();
    const token = await app.fixtures.token(owner);
    const fleet = await app.fixtures.org('fleet');
    await app.fixtures.member(owner, fleet, 'fleet_owner');
    await app.fixtures.subscription(fleet, 'fleet_20');
    await app.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
      db.updateTable('billing.subscriptions').set({ user_limit_override: 2 }).where('subscriber_id', '=', fleet.id).execute(),
    );
    const invite = (t: string, role: string, orgId = fleet.id) =>
      app.request<Json>({
        method: 'POST',
        path: `/v1/orgs/${orgId}/members/invitations`,
        token: t,
        headers: idem(),
        body: { email: `i-${uuidv7()}@test.carpal.app`, role },
      });
    expect((await invite(token, 'fleet_driver')).status).toBe(201);
    const full = await invite(token, 'fleet_driver');
    expect(full.status).toBe(403);
    expect(full.body).toMatchObject({ code: 'ENTITLEMENT_REQUIRED', entitlement_key: 'max_fleet_users' });

    const coord = await app.fixtures.memberOf('fleet', 'fleet_maintenance_coordinator');
    await app.fixtures.subscription(coord.org, 'fleet_20');
    const viewer = await invite(coord.token, 'fleet_viewer', coord.org.id);
    expect(viewer.body.errors, viewer.text).toEqual([{ pointer: '/role', code: 'enum' }]);
    expect((await invite(coord.token, 'fleet_driver', coord.org.id)).status).toBe(201);
  });
});

describe('locations and the location editor', () => {
  it('saves the exact pin, checks it against the geocoded address and makes the first location primary', async () => {
    const { org, token } = await app.fixtures.memberOf('provider', 'provider_owner');
    const near = await app.request<Json>({
      method: 'POST',
      path: `/v1/orgs/${org.id}/locations`,
      token,
      headers: idem(),
      body: location({ is_primary: false, hours: { weekly: [{ day_of_week: 1, open: '09:00', close: '18:00' }] } }),
    });
    expect(near.status).toBe(201);
    expect(near.body).toMatchObject({
      is_primary: true,
      geo_source: 'user_pin',
      location_check_status: 'consistent',
      geo_address_distance_m: 0,
      latitude: 35.757512,
      public_point: { lat: 35.757512, lng: 51.410621 },
      location_verified_at: null,
    });
    expect((await app.request<Json>({ path: `/v1/orgs/${org.id}`, token })).body.primary_location_id).toBe(near.body.id);

    // A far pin warns (far_apart) but is saved; approximate visibility rounds the public point to 0.01°.
    const far = await app.request<Json>({
      method: 'POST',
      path: `/v1/orgs/${org.id}/locations`,
      token,
      headers: idem(),
      body: location({
        is_primary: false,
        pin: { lat: 35.7712, lng: 51.4277 },
        public_address_visibility: 'approximate',
        service_radius_km: 15,
      }),
    });
    expect(far.status).toBe(201);
    expect(far.body).toMatchObject({
      is_primary: false,
      location_check_status: 'far_apart',
      public_point: { lat: 35.77, lng: 51.43 },
      latitude: 35.7712,
    });
    expect(far.body.geo_address_distance_m).toBeGreaterThan(300);

    // A second primary: 422 VALIDATION_FAILED(primary_conflict).
    const conflict = await app.request<Json>({
      method: 'POST',
      path: `/v1/orgs/${org.id}/locations`,
      token,
      headers: idem(),
      body: location(),
    });
    expect(conflict.body.errors).toEqual([{ pointer: '/is_primary', code: 'not_unique' }]);
    // Field rules the schema cannot express.
    const bad = await app.request<Json>({
      method: 'POST',
      path: `/v1/orgs/${org.id}/locations`,
      token,
      headers: idem(),
      body: location({
        is_primary: false,
        timezone: 'Mars/Olympus',
        hours: { weekly: [{ day_of_week: 1, open: '18:00', close: '09:00' }] },
        primary_contact_user_id: uuidv7(),
      }),
    });
    expect(bad.body.errors).toEqual([
      { pointer: '/timezone', code: 'enum' },
      { pointer: '/hours/weekly/0/close', code: 'order' },
    ]);

    // Moving the pin re-runs the check; the only active primary cannot be deactivated (409), a moved primary passes on.
    const moved = await app.request<Json>({
      method: 'PATCH',
      path: `/v1/orgs/${org.id}/locations/${far.body.id}`,
      token,
      body: { pin: { lat: 35.7576, lng: 51.4107 } },
      headers: { 'if-match': `"v${far.body.version}"` },
    });
    expect(moved.body).toMatchObject({ location_check_status: 'consistent', public_point: { lat: 35.76, lng: 51.41 } });
    expect((await app.request({ method: 'DELETE', path: `/v1/orgs/${org.id}/locations/${near.body.id}`, token })).status).toBe(200);
    const after = (await app.request<Json>({ path: `/v1/orgs/${org.id}/locations`, token })).body.items;
    expect(after.find((l: Json) => l.id === near.body.id)).toMatchObject({ status: 'inactive', is_primary: false });
    expect(after.find((l: Json) => l.id === far.body.id)).toMatchObject({ is_primary: true });
    expect((await app.request<Json>({ path: `/v1/orgs/${org.id}`, token })).body.primary_location_id).toBe(far.body.id);
    const only = await app.request<Json>({ method: 'DELETE', path: `/v1/orgs/${org.id}/locations/${far.body.id}`, token });
    expect(only.status).toBe(409);
    expect(only.body.code).toBe('INVALID_TRANSITION');
  });

  it('pin-check, geocode, reverse and resolve-map-link for the business editor', async () => {
    const { org, token } = await app.fixtures.memberOf('provider', 'provider_manager');
    const pc = await app.request<Json>({
      method: 'POST',
      path: `/v1/orgs/${org.id}/locations/pin-check`,
      token,
      body: { address_line_1: '45 Shariati Street', city: 'Tehran', country: 'IR', pin: { lat: 35.7318, lng: 51.4423 } },
    });
    expect(pc.body).toEqual({
      geocoded_point: { lat: 35.731842, lng: 51.442317 },
      distance_m: expect.any(Number),
      location_check_status: 'consistent',
      threshold_m: 300,
    });
    const unknown = await app.request<Json>({
      method: 'POST',
      path: `/v1/orgs/${org.id}/locations/pin-check`,
      token,
      body: { address_line_1: '99 Nowhere Alley', city: 'Tehran', country: 'IR', pin: { lat: 35.7, lng: 51.4 } },
    });
    expect(unknown.body).toMatchObject({ geocoded_point: null, distance_m: null, location_check_status: 'not_checked' });
    const geo = await app.request<Json>({
      method: 'POST',
      path: `/v1/orgs/${org.id}/geo/geocode`,
      token,
      body: { query: 'خیابان آزادی', country: 'IR' },
    });
    expect(geo.body.candidates[0]).toMatchObject({ address_line_1: '18 Azadi Street', city: 'Tehran', country: 'IR' });
    const rev = await app.request<Json>({
      method: 'POST',
      path: `/v1/orgs/${org.id}/geo/reverse`,
      token,
      body: { point: { lat: 35.70112, lng: 51.40191 } },
    });
    expect(rev.body.candidate).toMatchObject({ address_line_1: '7 Enghelab Street' });
    const link = await app.request<Json>({
      method: 'POST',
      path: `/v1/orgs/${org.id}/geo/resolve-map-link`,
      token,
      body: { url: 'https://www.google.com/maps/place/Shop/@35.757512,51.410621,17z' },
    });
    expect(link.body).toEqual({ point: { lat: 35.757512, lng: 51.410621 }, provider_key: 'google', label: '1200 Valiasr Street, Tehran' });
    const unsupported = await app.request<Json>({
      method: 'POST',
      path: `/v1/orgs/${org.id}/geo/resolve-map-link`,
      token,
      body: { url: 'https://maps.example.com/@35.7,51.4' },
    });
    expect(unsupported.body.code).toBe('MAP_LINK_UNSUPPORTED');
    // Staff members cannot use the editor (ORG(M+)): 404.
    const staff = await app.fixtures.memberOf('provider', 'provider_staff');
    expect(
      (
        await app.request({
          method: 'POST',
          path: `/v1/orgs/${staff.org.id}/geo/reverse`,
          token: staff.token,
          body: { point: { lat: 35.7, lng: 51.4 } },
        })
      ).status,
    ).toBe(404);
  });
});

describe('verifications', () => {
  it('submits checks with clean private documents; pending duplicates and unscanned files are refused', async () => {
    const { org, token } = await app.fixtures.memberOf('provider', 'provider_owner');
    const owner = { type: 'organization' as const, id: org.id };
    const doc = await media.upload(token, { owner, purpose: 'verification_document', mime: 'application/pdf', bytes: tinyPdf() });
    const submit = (body: Json) =>
      app.request<Json>({ method: 'POST', path: `/v1/orgs/${org.id}/verifications`, token, headers: idem(), body });
    const v = await submit({ verification_type: 'business_identity', submitted_document_ids: [doc.id] });
    expect(v.status).toBe(201);
    expect(v.body).toMatchObject({
      verification_type: 'business_identity',
      status: 'pending',
      submitted_document_ids: [doc.id],
      reviewed_at: null,
    });
    expect((await app.request<Json>({ path: `/v1/orgs/${org.id}`, token })).body.verification_status).toBe('pending');
    const dup = await submit({ verification_type: 'business_identity' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('DUPLICATE');
    // A file still waiting for its scan: 409 MEDIA_NOT_READY; another purpose: 422.
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } })
      .png()
      .toBuffer();
    const t = await media.init(token, { owner, purpose: 'verification_document', mime: 'image/png', bytes: png });
    await media.put(t.body, png);
    await app.request({ method: 'POST', path: `/v1/media/uploads/${t.body.upload_id}/complete`, token, headers: idem() });
    const early = await submit({ verification_type: 'address', submitted_document_ids: [t.body.upload_id] });
    expect(early.body.code).toBe('MEDIA_NOT_READY');
    await media.drain();
    const logo = await media.upload(token, { owner, purpose: 'org_logo', mime: 'image/png', bytes: png });
    const wrongPurpose = await submit({ verification_type: 'address', submitted_document_ids: [t.body.upload_id, logo.id] });
    expect(wrongPurpose.body).toMatchObject({
      code: 'REFERENCE_NOT_FOUND',
      errors: [{ pointer: '/submitted_document_ids/1', code: 'reference_not_found' }],
    });
    const list = await app.request<Json>({ path: `/v1/orgs/${org.id}/verifications`, token });
    expect(list.body.items.map((x: Json) => x.id)).toEqual([v.body.id]);
  });
});
