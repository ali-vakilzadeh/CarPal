// S5 vehicles and service history (40 §12): the acceptance criteria (six
// parallel creates at the Individual Free limit; the VIN never readable
// except through vin_reveal and never stored in plain text), VIN rules,
// status history and mileage, documents with the vehicle_data_sharing
// consent, service records (owner and provider paths, evidence, visits for
// job logs), issues with the safety check, reminders and the W15 rule,
// fleet vehicles and drivers, and record-level BOLA.
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jpegWithExif, tinyPdf, EICAR_TEXT } from '#libs/testing/index.js';
import { checkDigit } from '#modules/vehicle/domain/vin.js';
import { VehicleReminderRule } from '#modules/vehicle/vehicle.module.js';
import { MediaHarness, taxonomyNodes, type Json, type Nodes } from './s4-support.js';
import { audits, client, grantConsent, newId, outbox, vehicleBody, type Client } from './s5-support.js';
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

const VIN_CHARS = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';

/** A fresh North American VIN with a valid check digit (the test database is shared across runs, GD-13). */
function uniqueVin(): string {
  const tail = Array.from({ length: 6 }, () => '0123456789'[Math.floor(Math.random() * 10)]).join('');
  const body = `1HGCM826${'X'}3A${tail}`.split('');
  body[3] = VIN_CHARS[Math.floor(Math.random() * VIN_CHARS.length)]!;
  body[4] = VIN_CHARS[Math.floor(Math.random() * VIN_CHARS.length)]!;
  body[8] = checkDigit(body.join(''));
  return body.join('');
}

async function userClient(o: { acr?: 'aal1' | 'aal2'; authTime?: number } = {}) {
  const user = await app.fixtures.user();
  return { user, token: await app.fixtures.token(user, o), c: client(app, await app.fixtures.token(user, o)) };
}

async function rawVehicle(id: string) {
  return app.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
    db.selectFrom('vehicle.vehicles').selectAll().where('id', '=', id).executeTakeFirstOrThrow(),
  );
}

describe('S5 acceptance: vehicle limit and VIN secrecy', () => {
  it('six parallel creates for an Individual Free user with 4 active vehicles: exactly one succeeds', async () => {
    const { user, c } = await userClient();
    for (let i = 0; i < 4; i++) await app.fixtures.vehicle(user, n);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => c.post('/v1/me/vehicles', vehicleBody(n, { nickname: `Car ${i}` }))),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409, 409]);
    for (const r of results.filter((x) => x.status === 409)) expect(r.body.code).toBe('VEHICLE_LIMIT_REACHED');
    const active = await app.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
      db
        .selectFrom('vehicle.vehicles')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('owner_id', '=', user.id)
        .where('status', 'in', ['active', 'in_repair'])
        .executeTakeFirstOrThrow(),
    );
    expect(Number(active.n)).toBe(5);
    // The subscription summary counts them (billing UsageCounters max_vehicles).
    expect((await c.get('/v1/me/subscription')).body.usage).toMatchObject({ active_vehicles: 5 });
  });

  it('returns only vin_present + vin_last4, stores ciphertext + keyed hash, and reveals the VIN only with AAL2 (audited)', async () => {
    const { c, user } = await userClient();
    // One owner per VIN (GD-33) on a shared test database: a fresh VIN per run.
    const VIN = uniqueVin();
    // Lower case and Persian digits are normalized before the check (40 Vin).
    const typed = VIN.toLowerCase().slice(0, -1) + '۰۱۲۳۴۵۶۷۸۹'[Number(VIN.at(-1))]!;
    const created = await c.post('/v1/me/vehicles', vehicleBody(n, { vin: typed, mileage_km: 120_000 }));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      vin_present: true,
      vin_last4: VIN.slice(-4),
      vin_decode_status: 'not_attempted',
      owner_type: 'user',
      owner_id: user.id,
    });
    expect(created.text).not.toContain(VIN);
    expect(created.body).not.toHaveProperty('vin');
    const id = created.body.id as string;
    for (const path of ['/v1/me/vehicles', `/v1/me/vehicles/${id}`]) expect((await c.get(path)).text).not.toContain(VIN);
    // DB check: no plaintext VIN anywhere in the row; the hash is a 32-byte HMAC.
    const raw = await rawVehicle(id);
    expect(raw.vin_hash).toHaveLength(32);
    expect(raw.vin_encrypted!.includes(Buffer.from(VIN))).toBe(false);
    const { rows } = await app.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
      sql<{ t: string }>`SELECT row_to_json(v)::text AS t FROM vehicle.vehicles v WHERE v.id = ${id}::uuid`.execute(db),
    );
    expect(rows[0]!.t).not.toContain(VIN);
    expect(rows[0]!.t.toLowerCase()).not.toContain(VIN.toLowerCase());

    // AAL2: a session older than 10 minutes must step up; a fresh one gets the VIN, and the reveal is audited.
    const stale = client(app, await app.fixtures.token(user, { authTime: Math.floor(Date.now() / 1000) - 3600 }));
    const denied = await stale.post(`/v1/me/vehicles/${id}/vin-reveal`);
    expect(denied.status).toBe(401);
    expect(denied.body.code).toBe('STEP_UP_REQUIRED');
    const fresh = client(app, await app.fixtures.token(user, { acr: 'aal2' }));
    const revealed = await fresh.post(`/v1/me/vehicles/${id}/vin-reveal`);
    expect(revealed.status).toBe(200);
    expect(revealed.body).toEqual({ vin: VIN });
    expect(revealed.headers['cache-control']).toBe('no-store');
    expect(await audits(app, id)).toContain('vehicle.vin_revealed');
    // Events carry no VIN either.
    const events = await outbox(app, id);
    expect(events.map((e) => e.type)).toEqual(['vehicle.created']);
    expect(JSON.stringify(events)).not.toContain(VIN);
  });
});

describe('vehicles (40 §12.2)', () => {
  it('checks the VIN format and the check digit where it is mandatory; one owner per VIN, another owner may ask for a transfer (GD-33)', async () => {
    const a = await userClient();
    const b = await userClient();
    expect((await a.c.post('/v1/me/vehicles', vehicleBody(n, { vin: '1HGCM82643A004352' }))).body).toMatchObject({
      code: 'VIN_INVALID',
      errors: [{ pointer: '/vin', code: 'pattern' }],
    });
    expect((await a.c.post('/v1/me/vehicles', vehicleBody(n, { vin: 'IHGCM82633A004352' }))).body.code).toBe('VIN_INVALID');
    // The pilot region's VINs (WMI N*) carry no mandatory check digit.
    const regional = `NAAN01CA9EK${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
    expect((await a.c.post('/v1/me/vehicles', vehicleBody(n, { vin: regional }))).status).toBe(201);
    const vin = uniqueVin();
    const first = await a.c.post('/v1/me/vehicles', vehicleBody(n, { vin }));
    expect(first.body.duplicate_vin_warning).toBe(false);
    const dup = await a.c.post('/v1/me/vehicles', vehicleBody(n, { vin }));
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ code: 'DUPLICATE', errors: [{ pointer: '/vin', code: 'not_unique' }] });
    expect(dup.body.vin_transfer_available).toBeUndefined();
    const other = await b.c.post('/v1/me/vehicles', vehicleBody(n, { vin }));
    expect(other.status).toBe(409);
    expect(other.body).toMatchObject({
      code: 'DUPLICATE',
      vin_transfer_available: true,
      errors: [{ pointer: '/vin', code: 'not_unique' }],
    });
    expect((await a.c.get(`/v1/me/vehicles/${first.body.id}`)).body.duplicate_vin_warning).toBe(false);
  });

  it('updates with If-Match, checks the taxonomy chain and the year, decodes the VIN as suggestions and marks manual overrides', async () => {
    const { c, user } = await userClient();
    const v = (await c.post('/v1/me/vehicles', vehicleBody(n, { vin: uniqueVin(), series_node_id: n.series }))).body;
    expect((await c.patch(`/v1/me/vehicles/${v.id}`, { nickname: 'Daily' }, 9)).status).toBe(412);
    expect((await c.patch(`/v1/me/vehicles/${v.id}`, { model_node_id: n.otherModel }, v.version)).body.code).toBe('TAXONOMY_MISMATCH');
    expect((await c.patch(`/v1/me/vehicles/${v.id}`, { year: 2100 }, v.version)).body.errors).toEqual([
      { pointer: '/year', code: 'out_of_range', limit: String(new Date().getUTCFullYear() + 2) },
    ]);
    const decoded = await c.post(`/v1/me/vehicles/${v.id}/vin-decode`);
    expect(decoded.body).toEqual({ decode_status: 'partial', suggested: { year: 2003 }, decoder_source: 'carpal-local' });
    const after = (await c.get(`/v1/me/vehicles/${v.id}`)).body;
    expect(after).toMatchObject({ vin_decode_status: 'partial', year: 2019 });
    expect(after.vin_decoded_at).not.toBeNull();
    const upd = await c.patch(`/v1/me/vehicles/${v.id}`, { nickname: 'Daily', color: 'Blue' }, after.version);
    expect(upd.status).toBe(200);
    expect(upd.body).toMatchObject({ nickname: 'Daily', color: 'Blue', vin_decode_status: 'manual', version: after.version + 1 });
    expect(upd.body.profile_completeness).toBeGreaterThan(v.profile_completeness);
    const plain = (await c.post('/v1/me/vehicles', vehicleBody(n))).body;
    expect((await c.post(`/v1/me/vehicles/${plain.id}/vin-decode`)).body).toMatchObject({ code: 'INVALID_TRANSITION' });
    const fresh = client(app, await app.fixtures.token(user, { acr: 'aal2' }));
    expect((await fresh.post(`/v1/me/vehicles/${plain.id}/vin-reveal`)).status).toBe(404);
    expect((await outbox(app, v.id)).map((e) => e.type)).toEqual(['vehicle.created', 'vehicle.updated']);
  });

  it('records status history with reasons, applies the limit when a vehicle returns to active, and filters lists', async () => {
    const { user, c } = await userClient();
    for (let i = 0; i < 4; i++) await app.fixtures.vehicle(user, n);
    const v = (await c.post('/v1/me/vehicles', vehicleBody(n))).body;
    const sold = await c.post(`/v1/me/vehicles/${v.id}/status`, { status: 'sold', reason: 'Sold to a neighbour' });
    expect(sold.body.status).toBe('sold');
    await app.fixtures.vehicle(user, n); // the fifth active vehicle takes the free slot
    const back = await c.post(`/v1/me/vehicles/${v.id}/status`, { status: 'active' });
    expect(back.status).toBe(409);
    expect(back.body.code).toBe('VEHICLE_LIMIT_REACHED');
    // Moves between non-counting statuses need no slot.
    expect((await c.post(`/v1/me/vehicles/${v.id}/status`, { status: 'archived' })).body.status).toBe('archived');
    const history = (await c.get(`/v1/me/vehicles/${v.id}/status-history`)).body.items;
    expect(history.map((h: Json) => [h.old_status, h.new_status, h.reason])).toEqual([
      ['sold', 'archived', null],
      ['active', 'sold', 'Sold to a neighbour'],
      [null, 'active', null],
    ]);
    expect(typeof history[0].changed_by_display).toBe('string');
    expect((await c.get('/v1/me/vehicles?status=archived')).body.items.map((x: Json) => x.id)).toEqual([v.id]);
    const page = await c.get('/v1/me/vehicles?limit=2');
    expect(page.body.items).toHaveLength(2);
    const next = await c.get(`/v1/me/vehicles?limit=2&cursor=${page.body.next_cursor}`);
    expect(next.body.items).toHaveLength(2);
    expect(next.body.items[0].id).not.toBe(page.body.items[0].id);
    expect((await c.get(`/v1/me/vehicles?limit=3&cursor=${page.body.next_cursor}`)).status).toBe(200);
    expect((await c.get(`/v1/me/vehicles?status=active&cursor=${page.body.next_cursor}`)).body.code).toBe('CURSOR_MISMATCH');
  });

  it('logs mileage, mirrors the latest reading and flags a lower one without blocking it', async () => {
    const { c } = await userClient();
    const v = (await c.post('/v1/me/vehicles', vehicleBody(n))).body;
    const t = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    expect((await c.post(`/v1/me/vehicles/${v.id}/mileage`, { mileage_km: 50_000, recorded_at: t(48) })).body).toMatchObject({
      mileage_km: 50_000,
      source: 'user',
      lower_than_previous: false,
    });
    const lower = await c.post(`/v1/me/vehicles/${v.id}/mileage`, { mileage_km: 49_000, recorded_at: t(1) });
    expect(lower.status).toBe(201);
    expect(lower.body.lower_than_previous).toBe(true);
    expect(
      (await c.post(`/v1/me/vehicles/${v.id}/mileage`, { mileage_km: 1, recorded_at: new Date(Date.now() + 86_400_000).toISOString() }))
        .body.errors,
    ).toEqual([{ pointer: '/recorded_at', code: 'in_future' }]);
    const after = (await c.get(`/v1/me/vehicles/${v.id}`)).body;
    expect(after.mileage_km).toBe(49_000);
    expect(after.profile_completeness).toBeGreaterThan(v.profile_completeness);
    expect((await c.get(`/v1/me/vehicles/${v.id}/mileage`)).body.items.map((m: Json) => m.mileage_km)).toEqual([49_000, 50_000]);
  });

  it('attaches a clean photo as the primary photo (media target "vehicle") and serves it to the owner only', async () => {
    const { c, token, user } = await userClient();
    const photo = await media.upload(token, {
      owner: { type: 'user', id: user.id },
      purpose: 'vehicle_photo',
      mime: 'image/jpeg',
      bytes: await jpegWithExif(),
    });
    const v = (await c.post('/v1/me/vehicles', vehicleBody(n, { primary_photo_media_id: photo.id }))).body;
    expect(v.primary_photo_url).toMatch(/^http/);
    const attach = await c.post('/v1/media/attachments', {
      media_asset_id: photo.id,
      attached_to: { type: 'vehicle', id: v.id },
      role: 'gallery',
      display_order: 0,
    });
    expect(attach.status).toBe(201);
    // Another user cannot attach to this vehicle (the target resolver finds nothing in their context).
    const other = await userClient();
    const theirs = await media.upload(other.token, {
      owner: { type: 'user', id: other.user.id },
      purpose: 'vehicle_photo',
      mime: 'image/jpeg',
      bytes: await jpegWithExif(),
    });
    expect(
      (
        await other.c.post('/v1/media/attachments', {
          media_asset_id: theirs.id,
          attached_to: { type: 'vehicle', id: v.id },
          role: 'gallery',
          display_order: 0,
        })
      ).body.code,
    ).toBe('REFERENCE_NOT_FOUND');
  });
});

describe('vehicle documents (encrypted media, consent to share)', () => {
  it('stores private documents and shares one with a provider only under the owner vehicle_data_sharing consent', async () => {
    const { c, token, user } = await userClient();
    const v = (await c.post('/v1/me/vehicles', vehicleBody(n))).body;
    const docs = `/v1/me/vehicles/${v.id}/documents`;
    const pdf = await media.upload(token, {
      owner: { type: 'user', id: user.id },
      purpose: 'vehicle_document',
      mime: 'application/pdf',
      bytes: tinyPdf(),
    });
    const doc = await c.post(docs, {
      document_type: 'insurance',
      title: 'Insurance 2026',
      media_asset_id: pdf.id,
      visibility: 'private',
      issued_at: '2026-01-01',
      expires_at: '2026-12-31',
    });
    expect(doc.status).toBe(201);
    expect(doc.body).toMatchObject({ document_type: 'insurance', visibility: 'private', status: 'active', version: 1 });
    expect(doc.body).not.toHaveProperty('shared_with_organization_id');
    // An infected upload is never ready; a photo is the wrong purpose; another user's asset is unknown.
    const infected = await media.upload(token, {
      owner: { type: 'user', id: user.id },
      purpose: 'vehicle_document',
      mime: 'application/pdf',
      bytes: Buffer.from(`%PDF-1.4\n${EICAR_TEXT}\n`),
    });
    expect(
      (await c.post(docs, { document_type: 'other', title: 'Bad', media_asset_id: infected.id, visibility: 'private' })).body.code,
    ).toBe('MEDIA_NOT_READY');
    expect(
      (
        await c.post(docs, {
          document_type: 'other',
          title: 'Order',
          media_asset_id: pdf.id,
          visibility: 'private',
          issued_at: '2026-05-01',
          expires_at: '2026-01-01',
        })
      ).body.errors,
    ).toEqual([{ pointer: '/expires_at', code: 'order' }]);
    expect(
      (await c.post(docs, { document_type: 'other', title: 'Fleet', media_asset_id: pdf.id, visibility: 'fleet' })).body.errors,
    ).toEqual([{ pointer: '/visibility', code: 'conditional_forbidden' }]);

    const provider = await app.fixtures.memberOf('provider', 'provider_owner');
    const share = { visibility: 'shared_with_provider', shared_with_organization_id: provider.org.id };
    const noConsent = await c.patch(`${docs}/${doc.body.id}`, share, 1);
    expect(noConsent.status).toBe(403);
    expect(noConsent.body).toMatchObject({ code: 'CONSENT_REQUIRED', consent_type: 'vehicle_data_sharing' });
    // The vehicle consent scope is registered (S5): only the owner can grant it for their vehicle.
    const stranger = await userClient();
    expect(
      (
        await stranger.c.post('/v1/me/consents', {
          consent_type: 'vehicle_data_sharing',
          policy_version: '2026-10',
          scope: { type: 'vehicle', id: v.id },
          granted_to: { type: 'organization', id: provider.org.id },
        })
      ).body.code,
    ).toBe('REFERENCE_NOT_FOUND');
    await grantConsent(c, 'vehicle_data_sharing', { type: 'vehicle', id: v.id }, provider.org.id);
    const shared = await c.patch(`${docs}/${doc.body.id}`, share, 1);
    expect(shared.status).toBe(200);
    expect(shared.body).toMatchObject({ visibility: 'shared_with_provider', shared_with_organization_id: provider.org.id, version: 2 });
    // The provider reads it under RLS shared_read (the pre-visit report, S7, uses this).
    const seen = await app.fixtures.worker.run({ actorType: 'user', userId: provider.user.id, orgId: provider.org.id }, ({ db }) =>
      db.selectFrom('vehicle.vehicle_documents').select('id').where('id', '=', doc.body.id).execute(),
    );
    expect(seen).toHaveLength(1);
    expect((await c.del(`${docs}/${doc.body.id}`)).status).toBe(200);
    expect((await c.get(docs)).body.items).toEqual([]);
    expect(await audits(app, doc.body.id)).toContain('vehicle.document_removed');
  });
});

describe('service history (owner and provider paths)', () => {
  it('owner records with evidence, provider names, issue resolution, filters and the not_editable rule', async () => {
    const { c, token, user } = await userClient();
    const v = (await c.post('/v1/me/vehicles', vehicleBody(n))).body;
    const recs = `/v1/me/vehicles/${v.id}/service-records`;
    const provider = await app.fixtures.memberOf('provider', 'provider_owner');
    const issue = (
      await c.post(`/v1/me/vehicles/${v.id}/issues`, {
        title: 'Squeak',
        description: 'Squeaks when turning left',
        content_locale: 'en',
        urgency_level: 'low',
      })
    ).body;
    const r = await c.post(recs, {
      service_date: '2026-09-01',
      provider_organization_id: provider.org.id,
      service_system_node_id: n.system,
      service_task_node_id: n.task,
      parts_used: [{ name: 'Control arm', quantity: 2 }],
      cost: { amount: '1250000', currency: 'IRR' },
      cost_breakdown: { labor: '250000', parts: '1000000' },
      mileage_km: 81_000,
      resolves_issue_id: issue.id,
      source_type: 'user_manual',
      visibility: 'private',
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      verification_status: 'self_reported',
      created_by_type: 'user',
      provider: { id: provider.org.id, organization_type: 'provider' },
      cost: { amount: '1250000.00', currency: 'IRR' },
      parts_used: [{ name: 'Control arm', quantity: 2 }],
      evidence: [],
    });
    expect((await c.get(`/v1/me/vehicles/${v.id}/issues/${issue.id}`)).body).toMatchObject({ status: 'resolved' });
    expect((await c.get(`/v1/me/vehicles/${v.id}`)).body.mileage_km).toBe(81_000);
    expect(
      (
        await c.post(recs, {
          service_date: '2999-01-01',
          service_system_node_id: n.system,
          source_type: 'user_manual',
          visibility: 'private',
        })
      ).body.errors,
    ).toEqual([{ pointer: '/service_date', code: 'in_future' }]);
    expect(
      (
        await c.post(recs, {
          service_date: '2026-09-01',
          service_system_node_id: n.system,
          service_task_node_id: n.otherTask,
          source_type: 'user_manual',
          visibility: 'private',
        })
      ).body.code,
    ).toBe('TAXONOMY_MISMATCH');
    expect(
      (
        await c.post(recs, {
          service_date: '2026-09-01',
          service_system_node_id: n.system,
          provider_organization_id: newId(),
          source_type: 'user_manual',
          visibility: 'private',
        })
      ).body.code,
    ).toBe('REFERENCE_NOT_FOUND');
    expect(
      (
        await c.post(recs, {
          service_date: '2026-09-01',
          service_system_node_id: n.system,
          parts_used: [{ name: 'X', quantity: 1, inventory_item_id: newId() }],
          source_type: 'user_manual',
          visibility: 'private',
        })
      ).body.errors,
    ).toEqual([{ pointer: '/parts_used/0/inventory_item_id', code: 'reference_not_found' }]);

    // Evidence: an invoice scan of the owner.
    const invoice = await media.upload(token, {
      owner: { type: 'user', id: user.id },
      purpose: 'service_evidence',
      mime: 'application/pdf',
      bytes: tinyPdf(),
    });
    const ev = await c.post(`${recs}/${r.body.id}/evidence`, { evidence_type: 'invoice', media_asset_id: invoice.id });
    expect(ev.status).toBe(201);
    expect(ev.body).toMatchObject({ evidence_type: 'invoice', media_asset_id: invoice.id, reference: null, status: 'active' });
    expect((await c.get(`${recs}/${r.body.id}`)).body.evidence).toHaveLength(1);
    expect((await c.del(`${recs}/${r.body.id}/evidence/${ev.body.id}`)).status).toBe(200);
    expect((await c.get(`${recs}/${r.body.id}`)).body.evidence).toEqual([]);

    const edited = await c.patch(`${recs}/${r.body.id}`, { description: 'Both control arms replaced' }, r.body.version);
    expect(edited.body.description).toBe('Both control arms replaced');
    expect((await c.get(`${recs}?verification=verified`)).body.items).toEqual([]);
    expect((await c.get(`${recs}?from=2026-09-01&to=2026-09-01`)).body.items.map((x: Json) => x.id)).toEqual([r.body.id]);
    expect((await outbox(app, r.body.id)).map((e) => e.type)).toEqual(['service_record.created']);

    // The provider named on the record sees it as a visit of its customer: a linked job log is customer_confirmed (54 §1.1).
    const p = client(app, provider.token);
    const log = await p.post(`/v1/orgs/${provider.org.id}/provider/job-logs`, {
      job_date: '2026-09-01',
      service_system_node_id: n.system,
      service_record_id: r.body.id,
    });
    expect(log.status).toBe(201);
    expect(log.body.verification_status).toBe('customer_confirmed');
    // ... and may keep notes about the customer (52 ProviderCustomerNote: a service record with the provider).
    expect(
      (await p.post(`/v1/orgs/${provider.org.id}/provider/customer-notes`, { customer_user_id: user.id, body: 'Regular customer' })).status,
    ).toBe(201);
    const otherProvider = await app.fixtures.memberOf('provider', 'provider_owner');
    expect(
      (
        await client(app, otherProvider.token).post(`/v1/orgs/${otherProvider.org.id}/provider/job-logs`, {
          job_date: '2026-09-01',
          service_system_node_id: n.system,
          service_record_id: r.body.id,
        })
      ).body.code,
    ).toBe('REFERENCE_NOT_FOUND');

    expect((await c.del(`${recs}/${r.body.id}`)).status).toBe(200);
    expect((await c.get(recs)).body.items).toEqual([]);
    expect(await audits(app, r.body.id)).toContain('vehicle.service_record_removed');
  });

  it('a provider enters a provider_confirmed record only with the owner consent; the owner cannot edit it', async () => {
    const { c } = await userClient();
    const v = (await c.post('/v1/me/vehicles', vehicleBody(n))).body;
    const provider = await app.fixtures.memberOf('provider', 'provider_staff');
    const p = client(app, provider.token);
    const path = `/v1/orgs/${provider.org.id}/provider/service-records`;
    const body = { vehicle_id: v.id, service_date: '2026-09-15', service_system_node_id: n.system, description: 'Brake pads' };
    const denied = await p.post(path, body);
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ code: 'CONSENT_REQUIRED', consent_type: 'vehicle_data_sharing' });
    expect((await p.post(path, { ...body, vehicle_id: undefined })).body.errors).toEqual([
      { pointer: '/vehicle_id', code: 'conditional_required' },
    ]);
    expect((await p.post(path, { ...body, appointment_id: newId() })).body.errors).toEqual([
      { pointer: '/appointment_id', code: 'conditional_forbidden' },
    ]);
    // Unknown vehicles (and fleet vehicles) fail closed like a missing consent.
    expect((await p.post(path, { ...body, vehicle_id: newId() })).body.code).toBe('CONSENT_REQUIRED');
    await grantConsent(c, 'vehicle_data_sharing', { type: 'vehicle', id: v.id }, provider.org.id);
    const ok = await p.post(path, body);
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({
      vehicle_id: v.id,
      source_type: 'provider_logged',
      verification_status: 'provider_confirmed',
      created_by_type: 'organization',
      provider: { id: provider.org.id },
    });
    expect((await outbox(app, ok.body.id)).map((e) => e.type)).toEqual(['service_record.created']);
    // The owner sees it, marked as confirmed, and cannot edit or delete it (disputes come with S7).
    const recs = `/v1/me/vehicles/${v.id}/service-records`;
    expect((await c.get(`${recs}?verification=verified`)).body.items.map((x: Json) => x.id)).toEqual([ok.body.id]);
    expect((await c.patch(`${recs}/${ok.body.id}`, { description: 'x' }, 1)).body).toMatchObject({ code: 'INVALID_TRANSITION' });
    expect((await c.del(`${recs}/${ok.body.id}`)).body.code).toBe('INVALID_TRANSITION');
    // A withdrawn consent stops further entries at once (SEC-AZ-8).
    const consent = (await c.get('/v1/me/consents?consent_type=vehicle_data_sharing')).body.items[0];
    expect((await c.post(`/v1/me/consents/${consent.id}/withdraw`)).status).toBe(200);
    expect((await p.post(path, body)).status).toBe(403);
  });
});

describe('issues (safety check) and reminders (W15)', () => {
  it('flags safety words on the server, raises the urgency and never lets it drop below the check', async () => {
    const { c, token, user } = await userClient();
    const v = (await c.post('/v1/me/vehicles', vehicleBody(n))).body;
    const issues = `/v1/me/vehicles/${v.id}/issues`;
    const photo = await media.upload(token, {
      owner: { type: 'user', id: user.id },
      purpose: 'issue_photo',
      mime: 'image/jpeg',
      bytes: await jpegWithExif(),
    });
    const i = await c.post(issues, {
      title: 'Brake failure on the highway',
      description: 'The pedal went soft twice today.',
      content_locale: 'en',
      urgency_level: 'low',
      media_ids: [photo.id],
    });
    expect(i.status).toBe(201);
    expect(i.body).toMatchObject({
      safety_flag: true,
      urgency_level: 'safety_critical',
      source: 'user',
      status: 'open',
      media_ids: [photo.id],
      fleet_approval_status: null,
    });
    expect((await c.post(issues, { title: 'Short', description: 'tiny', content_locale: 'en', urgency_level: 'low' })).body.errors).toEqual(
      [{ pointer: '/description', code: 'too_short', limit: '10' }],
    );
    const low = await c.patch(`${issues}/${i.body.id}`, { urgency_level: 'low', media_ids: [] }, i.body.version);
    expect(low.body).toMatchObject({ urgency_level: 'safety_critical' });
    expect(low.body).not.toHaveProperty('media_ids');
    const quiet = (
      await c.post(issues, {
        title: 'Rattle in the trunk',
        description: 'Something rattles over bumps.',
        content_locale: 'en',
        urgency_level: 'medium',
      })
    ).body;
    expect(quiet).toMatchObject({ safety_flag: false, urgency_level: 'medium' });
    expect((await c.post(`${issues}/${quiet.id}/status`, { status: 'investigating' })).body.status).toBe('investigating');
    expect((await c.post(`${issues}/${quiet.id}/status`, { status: 'investigating' })).body.code).toBe('INVALID_TRANSITION');
    const rec = (
      await c.post(`/v1/me/vehicles/${v.id}/service-records`, {
        service_date: '2026-09-01',
        service_system_node_id: n.system,
        source_type: 'user_manual',
        visibility: 'private',
      })
    ).body;
    const resolved = await c.post(`${issues}/${quiet.id}/status`, { status: 'resolved', resolved_by_service_record_id: rec.id });
    expect(resolved.body.status).toBe('resolved');
    expect(resolved.body.resolved_at).not.toBeNull();
    expect((await c.get(`/v1/me/vehicles/${v.id}/service-records/${rec.id}`)).body.resolves_issue_id).toBe(quiet.id);
    expect((await c.get(`${issues}?status=open`)).body.items.map((x: Json) => x.id)).toEqual([i.body.id]);
    expect((await c.get(`/v1/me/vehicles/${v.id}`)).body.open_issue_count).toBe(1);
    expect((await outbox(app, i.body.id)).map((e) => [e.type, e.payload.safety_flag])).toEqual([['vehicle.issue.reported', true]]);
  });

  it('manual reminders by date or mileage; snooze, complete, dismiss; rule reminders are not edited; the hourly rule moves statuses and adds document expiry reminders', async () => {
    const { c, token, user } = await userClient();
    const v = (await c.post('/v1/me/vehicles', vehicleBody(n, { mileage_km: 59_700 }))).body;
    const rem = `/v1/me/vehicles/${v.id}/reminders`;
    const day = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
    expect((await c.post(rem, { reminder_type: 'oil', title: 'Oil change', priority: 'high' })).body.errors).toEqual([
      { pointer: '/due_by_date', code: 'conditional_required' },
    ]);
    expect((await c.post(rem, { reminder_type: 'oil', title: 'Oil change', priority: 'high', due_by_date: day(-1) })).body.errors).toEqual([
      { pointer: '/due_by_date', code: 'in_past' },
    ]);
    const byKm = await c.post(rem, { reminder_type: 'oil', title: 'Oil change', priority: 'high', due_by_mileage_km: 60_000 });
    expect(byKm.body).toMatchObject({ status: 'due', source: 'manual', due_by_mileage_km: 60_000 });
    const later = (await c.post(rem, { reminder_type: 'tires', title: 'Winter tires', priority: 'low', due_by_date: day(60) })).body;
    expect(later.status).toBe('upcoming');
    expect((await c.get(`/v1/me/vehicles/${v.id}`)).body.next_reminder_due).toBe(later.due_by_date);
    const snoozed = await c.patch(`${rem}/${byKm.body.id}`, { snoozed_until: day(7) }, byKm.body.version);
    expect(snoozed.body).toMatchObject({ status: 'upcoming', snoozed_until: day(7) });
    expect((await c.patch(`${rem}/${later.id}`, { status: 'dismissed' }, later.version)).body.status).toBe('dismissed');
    expect((await c.patch(`${rem}/${later.id}`, { title: 'Again' }, later.version + 1)).body.code).toBe('INVALID_TRANSITION');

    // The hourly rule: a reading past the target makes a manual reminder overdue; an expiring document gets a rule reminder.
    const due = (await c.post(rem, { reminder_type: 'brakes', title: 'Brake check', priority: 'medium', due_by_mileage_km: 61_000 })).body;
    expect(due.status).toBe('upcoming');
    await c.post(`/v1/me/vehicles/${v.id}/mileage`, { mileage_km: 61_500, recorded_at: new Date().toISOString() });
    const pdf = await media.upload(token, {
      owner: { type: 'user', id: user.id },
      purpose: 'vehicle_document',
      mime: 'application/pdf',
      bytes: tinyPdf(),
    });
    await c.post(`/v1/me/vehicles/${v.id}/documents`, {
      document_type: 'registration',
      title: 'Registration card',
      media_asset_id: pdf.id,
      visibility: 'private',
      expires_at: day(10),
    });
    const worker = media.worker.get(VehicleReminderRule);
    const summary = await worker.run();
    expect(summary.created).toBeGreaterThanOrEqual(1);
    const list = (await c.get(rem)).body.items as Json[];
    expect(list.find((r) => r.id === due.id)!.status).toBe('overdue');
    const expiry = list.find((r) => r.reminder_type === 'document_expiry')!;
    expect(expiry).toMatchObject({
      source: 'rule',
      title: 'Renew Registration card',
      due_by_date: day(10),
      priority: 'high',
      status: 'due',
    });
    expect((await c.patch(`${rem}/${expiry.id}`, { title: 'Mine' }, expiry.version)).body.code).toBe('INVALID_TRANSITION');
    expect((await c.del(`${rem}/${expiry.id}`)).body.code).toBe('INVALID_TRANSITION');
    expect((await outbox(app, due.id)).map((e) => [e.type, e.payload.status])).toEqual([['vehicle.reminder.due', 'overdue']]);
    // Running again creates nothing new for the same document.
    expect((await worker.run()).created).toBe(0);
    expect((await c.del(`${rem}/${due.id}`)).status).toBe(200);
    expect((await c.get(rem)).body.items.map((r: Json) => r.id)).not.toContain(due.id);
  });
});

describe('fleet vehicles and drivers (SEC-AZ-7)', () => {
  it('fleet coordinators manage fleet vehicles against the fleet plan; drivers see only assigned vehicles (none before S8)', async () => {
    const fleet = await app.fixtures.org('fleet');
    await app.fixtures.subscription(fleet, 'fleet_20', { vehicleLimit: 1 });
    const manager = await app.fixtures.user();
    const driver = await app.fixtures.user();
    await app.fixtures.member(manager, fleet, 'fleet_manager');
    await app.fixtures.member(driver, fleet, 'fleet_driver');
    const m = client(app, await app.fixtures.token(manager));
    const d = client(app, await app.fixtures.token(driver));
    const base = `/v1/orgs/${fleet.id}/fleet/vehicles`;
    const v = await m.post(base, vehicleBody(n, { license_plate: '12A345-67' }));
    expect(v.status).toBe(201);
    expect(v.body).toMatchObject({ owner_type: 'organization', owner_id: fleet.id, assigned_driver: null });
    expect((await m.post(base, vehicleBody(n))).body.code).toBe('VEHICLE_LIMIT_REACHED');
    const rec = await m.post(`${base}/${v.body.id}/service-records`, {
      service_date: '2026-09-01',
      service_system_node_id: n.system,
      source_type: 'user_manual',
      visibility: 'fleet',
    });
    expect(rec.body).toMatchObject({ created_by_type: 'organization', visibility: 'fleet' });
    expect((await d.get(base)).body.items).toEqual([]);
    expect((await d.get(`${base}/${v.body.id}`)).status).toBe(404);
    expect(
      (
        await d.post(`${base}/${v.body.id}/issues`, {
          title: 'Flat tyre',
          description: 'Rear left tyre is flat.',
          content_locale: 'en',
          urgency_level: 'high',
        })
      ).status,
    ).toBe(404);
    // A personal vehicle of the manager is not on the fleet path, and fleet vehicles are not on {me}.
    const own = (await m.post('/v1/me/vehicles', vehicleBody(n))).body;
    expect((await m.get(`${base}/${own.id}`)).status).toBe(404);
    expect((await m.get(`/v1/me/vehicles/${v.body.id}`)).status).toBe(404);
  });
});

describe("record-level BOLA: another owner's vehicle records", () => {
  it('404 for every vehicle record of user A named under user B or under another fleet', async () => {
    const a = await userClient();
    const b = await userClient();
    const v = (await a.c.post('/v1/me/vehicles', vehicleBody(n))).body;
    const issue = (
      await a.c.post(`/v1/me/vehicles/${v.id}/issues`, {
        title: 'Noise',
        description: 'Clicking noise at idle.',
        content_locale: 'en',
        urgency_level: 'low',
      })
    ).body;
    const rec = (
      await a.c.post(`/v1/me/vehicles/${v.id}/service-records`, {
        service_date: '2026-09-01',
        service_system_node_id: n.system,
        source_type: 'user_manual',
        visibility: 'private',
      })
    ).body;
    const rem = (
      await a.c.post(`/v1/me/vehicles/${v.id}/reminders`, {
        reminder_type: 'oil',
        title: 'Oil change',
        priority: 'low',
        due_by_mileage_km: 90_000,
      })
    ).body;
    const base = `/v1/me/vehicles/${v.id}`;
    const calls: [keyof Client, string, unknown?][] = [
      ['get', base],
      ['patch', base, { nickname: 'x' }],
      ['post', `${base}/status`, { status: 'sold' }],
      ['post', `${base}/vin-decode`],
      ['get', `${base}/status-history`],
      ['get', `${base}/mileage`],
      ['post', `${base}/mileage`, { mileage_km: 1, recorded_at: new Date().toISOString() }],
      ['get', `${base}/documents`],
      ['get', `${base}/service-records`],
      ['get', `${base}/service-records/${rec.id}`],
      ['del', `${base}/service-records/${rec.id}`],
      ['get', `${base}/issues/${issue.id}`],
      ['post', `${base}/issues/${issue.id}/status`, { status: 'cancelled' }],
      ['get', `${base}/reminders`],
      ['del', `${base}/reminders/${rem.id}`],
    ];
    for (const [method, path, body] of calls) {
      const res =
        method === 'patch'
          ? await b.c.patch(path, body, 1)
          : method === 'post'
            ? await b.c.post(path, body)
            : method === 'del'
              ? await b.c.del(path)
              : await b.c.get(path);
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    const fleetA = await app.fixtures.memberOf('fleet', 'fleet_owner');
    const fleetB = await app.fixtures.memberOf('fleet', 'fleet_owner');
    await app.fixtures.subscription(fleetA.org, 'fleet_20');
    const fv = (await client(app, fleetA.token).post(`/v1/orgs/${fleetA.org.id}/fleet/vehicles`, vehicleBody(n))).body;
    expect((await client(app, fleetB.token).get(`/v1/orgs/${fleetB.org.id}/fleet/vehicles/${fv.id}`)).status).toBe(404);
    expect((await client(app, fleetB.token).get(`/v1/orgs/${fleetB.org.id}/fleet/vehicles`)).body.items).toEqual([]);
    expect((await b.c.get('/v1/me/vehicles')).body.items).toEqual([]);
  });
});
