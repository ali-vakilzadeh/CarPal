// Backend S22 (contract 1.4.0, admin console BR-08, BR-15 rest; backend DI-67):
// organization merge through the OrganizationReferences registry (preview,
// four eyes, the merge job read by admin.job_get, every rule, refusal, a
// failure half-way that leaves nothing re-pointed) and the moderation action
// apply_redaction (the media worker replaces the public copy with boxes).
import { createHash } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { sql } from 'kysely';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '#libs/crypto/index.js';
import { OrganizationReferences } from '#modules/organization/interface/org-references.js';
import { taxonomyNodes, type Json, type Nodes } from './s4-support.js';
import { newId } from './s5-support.js';
import { publishedProvider, publishedVendor, type PublishedOrg } from './s6-support.js';
import { customer } from './s7-support.js';
import { events, openCase, purpose, query, REASON, staff, type StaffApi } from './s8-support.js';
import { createTestApp, createTestWorker, type TestApp } from './test-app.js';

let api: TestApp;
let admin: TestApp;
let worker: INestApplicationContext;
let n: Nodes;
let adm: StaffApi;
let adm2: StaffApi;
let admUserId: string;
let mod: StaffApi;
let support: StaffApi;

const UUID = /^[0-9a-f-]{36}$/;

beforeAll(async () => {
  api = await createTestApp({ host: 'api' });
  admin = await createTestApp({ host: 'admin-api', infra: api.infra });
  worker = await createTestWorker({ infra: api.infra });
  n = await taxonomyNodes(api);
  const a = await staff(admin, 'platform_admin');
  adm = a.c;
  admUserId = a.user.id;
  adm2 = (await staff(admin, 'platform_admin')).c;
  mod = (await staff(admin, 'platform_moderator')).c;
  support = (await staff(admin, 'platform_support')).c;
}, 60_000);

afterAll(async () => {
  await worker?.close();
  await admin?.close();
  await api?.close();
});

const sys = <T>(fn: Parameters<TestApp['fixtures']['worker']['run']>[1]) =>
  api.fixtures.worker.run({ actorType: 'system' }, fn) as Promise<T>;

async function follow(userId: string, orgId: string): Promise<void> {
  await sys(({ db }) => db.insertInto('community.follows').values({ user_id: userId, organization_id: orgId }).execute());
}

async function review(p: PublishedOrg): Promise<string> {
  const cu = await customer(api, n);
  const r = await cu.c.post('/v1/reviews', {
    subject_organization_id: p.id,
    subject_type: 'provider',
    overall_rating: 4,
    body: 'Good work on the brakes, fair price and on time.',
    content_locale: 'en',
  });
  expect(r.status, r.text).toBe(201);
  return r.body.id as string;
}

const preview = (from: string, into: string, as = adm) => as.get(`/v1/admin/orgs/${from}/merge-preview?into_organization_id=${into}`);
const refOf = (body: Json, key: string) => (body.references as Json[]).find((r) => r.reference === key);

async function approve(changeId: string) {
  return adm2.post(`/v1/admin/four-eyes/${changeId}/decision`, { decision: 'approve', reason: REASON });
}

/** Requests, approves and runs a merge; returns the finished job. */
async function merge(fromId: string, intoId: string): Promise<Json> {
  const req = await adm.post(`/v1/admin/orgs/${fromId}/merge`, { into_organization_id: intoId, reason: REASON });
  expect(req.status, req.text).toBe(202);
  const ok = await approve(req.body.change_id as string);
  expect(ok.status, ok.text).toBe(200);
  expect(ok.body.job_id).toMatch(UUID);
  await api.infra.jobs.idle();
  const job = await adm.get(`/v1/admin/jobs/${ok.body.job_id}`);
  expect(job.status, job.text).toBe(200);
  return job.body;
}

const orgRow = async (id: string) =>
  (
    await query<{ status: string; merged_into_organization_id: string | null }>(
      api,
      sql`SELECT status, merged_into_organization_id FROM organization.organizations WHERE id = ${id}::uuid`,
    )
  )[0]!;

describe('organization merge (BR-08)', () => {
  let x: PublishedOrg;
  let y: PublishedOrg;
  let reviewId: string;
  let both: { id: string };
  let only: { id: string };

  beforeAll(async () => {
    x = await publishedProvider(api, n, { name: `Dup ${newId().slice(-6)}` });
    y = await publishedProvider(api, n, { name: `Keep ${newId().slice(-6)}` });
    reviewId = await review(x);
    [both, only] = await Promise.all([api.fixtures.user(), api.fixtures.user()]);
    await follow(both.id, x.id);
    await follow(both.id, y.id);
    await follow(only.id, x.id);
  }, 60_000);

  it('the preview counts every reference with its rule and conflicts, for administrators only, and changes nothing', async () => {
    const res = await preview(x.id, y.id);
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ organization: { id: x.id }, into: { id: y.id }, blocked_by: [] });
    expect(refOf(res.body, 'identity.memberships')).toEqual({
      module: 'identity',
      reference: 'identity.memberships',
      rule: 'retire',
      count: 1,
      conflicts: 0,
    });
    // Both are published providers at their own location with the same service and brand.
    expect(refOf(res.body, 'organization.locations')).toMatchObject({ rule: 'merge', count: 1, conflicts: 1 });
    expect(refOf(res.body, 'organization.provider_profile')).toMatchObject({ rule: 'keep_target', count: 1, conflicts: 1 });
    expect(refOf(res.body, 'organization.service_categories')).toMatchObject({ rule: 'keep_target', count: 1, conflicts: 1 });
    expect(refOf(res.body, 'organization.vehicle_coverage')).toMatchObject({ rule: 'keep_target', count: 1, conflicts: 1 });
    expect(refOf(res.body, 'community.follows')).toMatchObject({ rule: 'keep_target', count: 2, conflicts: 1 });
    expect(refOf(res.body, 'trust.reviews')).toMatchObject({ module: 'trust', rule: 'move', count: 1, conflicts: 0 });
    expect(refOf(res.body, 'admin.assist_sessions')).toMatchObject({ rule: 'refuse', count: 0, conflicts: 0 });
    expect(refOf(res.body, 'organization.profile_changes')).toMatchObject({ rule: 'history' });
    // Every module that keeps organization references is listed (the job refuses to run otherwise).
    expect(new Set((res.body.references as Json[]).map((r) => r.module))).toEqual(
      new Set([
        'admin',
        'ai_mcp',
        'appointment',
        'billing',
        'community',
        'discovery',
        'fleet',
        'identity',
        'inventory',
        'media',
        'organization',
        'trust',
        'vehicle',
      ]),
    );
    expect(res.text).not.toContain('shop@example.com');
    // STF(ADM): other staff roles do not see the operation.
    expect((await preview(x.id, y.id, mod)).status).toBe(404);
    expect((await preview(x.id, y.id, support)).status).toBe(404);
    expect((await preview(x.id, x.id)).status).toBe(422);
    expect((await preview(x.id, uuidv7())).status).toBe(422);
    expect((await orgRow(x.id)).status).toBe('active');
  });

  it('an approved merge runs as a job that applies every rule; nothing live points at the merged organization', async () => {
    const job = await merge(x.id, y.id);
    expect(job).toMatchObject({ kind: 'organization_merge', status: 'succeeded', result: { type: 'organization', id: y.id } });
    expect(await orgRow(x.id)).toEqual({ status: 'merged', merged_into_organization_id: y.id });

    // Acceptance: no live reference of a non-history rule names the merged organization.
    const refs = admin.app.get(OrganizationReferences);
    const left = await sys<string[]>(async (scope) => {
      const out: string[] = [];
      for (const { ref } of refs.entries())
        if (ref.rule !== 'history' && ref.rule !== 'refuse' && (await ref.count(scope, x.id, y.id)).rows > 0) out.push(ref.key);
      return out;
    });
    expect(left).toEqual([]);

    // move: the review now belongs to the surviving organization.
    expect(await query(api, sql`SELECT subject_organization_id FROM trust.reviews WHERE id = ${reviewId}::uuid`)).toEqual([
      { subject_organization_id: y.id },
    ]);
    // keep_target: the follower of both keeps one live follow; the other follower moved.
    const follows = await query<{ user_id: string; organization_id: string; status: string; live: boolean }>(
      api,
      sql`SELECT user_id, organization_id, status, deleted_at IS NULL AS live FROM community.follows
           WHERE user_id IN (${both.id}::uuid, ${only.id}::uuid) ORDER BY user_id, live DESC`,
    );
    expect(follows.filter((f) => f.live)).toEqual(
      expect.arrayContaining([
        { user_id: both.id, organization_id: y.id, status: 'active', live: true },
        { user_id: only.id, organization_id: y.id, status: 'active', live: true },
      ]),
    );
    expect(follows.filter((f) => f.live)).toHaveLength(2);
    expect(follows.find((f) => !f.live)).toEqual({ user_id: both.id, organization_id: x.id, status: 'unfollowed', live: false });
    // merge: the duplicate's location arrives inactive and not primary; the target keeps its primary.
    const locs = await query<{ id: string; organization_id: string; status: string; is_primary: boolean }>(
      api,
      sql`SELECT id, organization_id, status, is_primary FROM organization.organization_locations
           WHERE id IN (${x.locationId}::uuid, ${y.locationId}::uuid) ORDER BY is_primary DESC`,
    );
    expect(locs).toEqual([
      { id: y.locationId, organization_id: y.id, status: 'active', is_primary: true },
      { id: x.locationId, organization_id: y.id, status: 'inactive', is_primary: false },
    ]);
    // keep_target on a one-per-organization profile: the target's stays published, the duplicate's is retired.
    const profiles = await query<{ organization_id: string; public_status: string; live: boolean }>(
      api,
      sql`SELECT organization_id, public_status, deleted_at IS NULL AS live FROM organization.provider_profiles
           WHERE organization_id IN (${x.id}::uuid, ${y.id}::uuid) ORDER BY live DESC`,
    );
    expect(profiles).toEqual([
      { organization_id: y.id, public_status: 'published', live: true },
      { organization_id: x.id, public_status: 'draft', live: false },
    ]);
    // retire: the duplicate's owner can act for neither organization.
    const m = await query<{ status: string }>(
      api,
      sql`SELECT status FROM identity.role_memberships WHERE user_id = ${x.userId}::uuid AND organization_id IS NOT NULL`,
    );
    expect(m).toEqual([{ status: 'removed' }]);
    expect([403, 404]).toContain((await x.c.get(`/v1/orgs/${x.id}`)).status);
    expect([403, 404]).toContain((await x.c.get(`/v1/orgs/${y.id}`)).status);
    expect((await y.c.get(`/v1/orgs/${y.id}`)).status).toBe(200);

    expect(await events(api, { aggregateId: y.id, type: 'organization.merged' })).toEqual([
      { type: 'organization.merged', payload: { organization_id: y.id, merged_organization_id: x.id } },
    ]);
    const audit = await query<{ next: string }>(
      api,
      sql`SELECT new_state_summary AS next FROM analytics.audit_logs WHERE entity_id = ${x.id}::uuid AND action = 'organization.merged'`,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.next).toContain('trust.reviews');
    // A merged organization cannot be merged or previewed again.
    expect((await adm.post(`/v1/admin/orgs/${x.id}/merge`, { into_organization_id: y.id, reason: REASON })).status).toBe(409);
    expect((await preview(x.id, y.id)).status).toBe(409);
  });

  it('an open assist session refuses the request, the approval and the job until it ends', async () => {
    const [a, b] = await Promise.all([api.fixtures.org('provider'), api.fixtures.org('provider')]);
    const req = await adm.post(`/v1/admin/orgs/${a.id}/merge`, { into_organization_id: b.id, reason: REASON });
    expect(req.status, req.text).toBe(202);
    const session = uuidv7();
    await sys(({ db }) =>
      db
        .insertInto('admin.assist_sessions')
        .values({ id: session, organization_id: a.id, flow_type: 'provider', staff_user_id: admUserId, reason: REASON })
        .execute(),
    );
    const p = await preview(a.id, b.id);
    expect(p.status, p.text).toBe(200);
    expect(p.body.blocked_by).toEqual(['admin.assist_sessions']);
    expect(refOf(p.body, 'admin.assist_sessions')).toMatchObject({ count: 1, conflicts: 1 });
    expect((await adm2.post(`/v1/admin/orgs/${a.id}/merge`, { into_organization_id: b.id, reason: REASON })).status).toBe(409);
    const refused = await approve(req.body.change_id as string);
    expect(refused.status, refused.text).toBe(409);
    expect(refused.body.code).toBe('INVALID_TRANSITION');
    expect((await orgRow(a.id)).status).not.toBe('merged');

    await sys(({ db }) =>
      db
        .updateTable('admin.assist_sessions')
        .set({ status: 'ended', ended_at: new Date(), end_reason: REASON })
        .where('id', '=', session)
        .execute(),
    );
    const ok = await approve(req.body.change_id as string);
    expect(ok.status, ok.text).toBe(200);
    await api.infra.jobs.idle();
    expect((await adm.get(`/v1/admin/jobs/${ok.body.job_id}`)).body).toMatchObject({ status: 'succeeded' });
    expect((await orgRow(a.id)).status).toBe('merged');
  });

  it('vendors: a duplicate SKU and a trade account between the two are retired; a provider profile moved to a vendor makes it hybrid', async () => {
    const sku = `S22-${newId().slice(-10)}`;
    const v1 = await publishedVendor(api, n, { name: `V dup ${newId().slice(-6)}`, item: { sku } });
    const v2 = await publishedVendor(api, n, { name: `V keep ${newId().slice(-6)}`, item: { sku } });
    const other = await publishedVendor(api, n, { name: `V other ${newId().slice(-6)}` });
    await sys(({ db }) =>
      db
        .insertInto('inventory.vendor_trade_accounts')
        .values([
          { vendor_organization_id: v2.id, trade_customer_organization_id: v1.id },
          { vendor_organization_id: other.id, trade_customer_organization_id: v1.id },
        ])
        .execute(),
    );
    const p = await preview(v1.id, v2.id);
    expect(p.status, p.text).toBe(200);
    expect(refOf(p.body, 'inventory.items')).toMatchObject({ rule: 'keep_target', count: 1, conflicts: 1 });
    expect(refOf(p.body, 'inventory.trade_accounts')).toMatchObject({ rule: 'keep_target', count: 2, conflicts: 1 });
    expect(refOf(p.body, 'organization.vendor_profile')).toMatchObject({ count: 1, conflicts: 1 });
    expect(await merge(v1.id, v2.id)).toMatchObject({ status: 'succeeded' });
    expect(
      await query(
        api,
        sql`SELECT id, vendor_organization_id, deleted_at IS NULL AS live FROM inventory.inventory_items
             WHERE id IN (${v1.itemId}::uuid, ${v2.itemId}::uuid) ORDER BY live DESC`,
      ),
    ).toEqual([
      { id: v2.itemId, vendor_organization_id: v2.id, live: true },
      { id: v1.itemId, vendor_organization_id: v1.id, live: false },
    ]);
    expect(
      await query(
        api,
        sql`SELECT vendor_organization_id, trade_customer_organization_id, deleted_at IS NULL AS live FROM inventory.vendor_trade_accounts
             WHERE vendor_organization_id IN (${v2.id}::uuid, ${other.id}::uuid) ORDER BY live`,
      ),
    ).toEqual([
      { vendor_organization_id: v2.id, trade_customer_organization_id: v1.id, live: false },
      { vendor_organization_id: other.id, trade_customer_organization_id: v2.id, live: true },
    ]);

    // A provider merged into the vendor brings its provider profile (the vendor has none): the organization becomes hybrid.
    const prov = await publishedProvider(api, n, { name: `P into V ${newId().slice(-6)}` });
    const q = await preview(prov.id, v2.id);
    expect(refOf(q.body, 'organization.provider_profile')).toMatchObject({ count: 1, conflicts: 0 });
    expect(await merge(prov.id, v2.id)).toMatchObject({ status: 'succeeded' });
    expect(
      await query(
        api,
        sql`SELECT organization_id, public_status FROM organization.provider_profiles WHERE organization_id = ${v2.id}::uuid`,
      ),
    ).toEqual([{ organization_id: v2.id, public_status: 'published' }]);
    expect(await query(api, sql`SELECT organization_type FROM organization.organizations WHERE id = ${v2.id}::uuid`)).toEqual([
      { organization_type: 'hybrid_provider_vendor' },
    ]);
  });

  it('a merge failing half-way leaves no partial re-pointing', async () => {
    const from = await publishedProvider(api, n, { name: `Half ${newId().slice(-6)}` });
    const into = await publishedProvider(api, n, { name: `Whole ${newId().slice(-6)}` });
    const r = await review(from);
    const fan = await api.fixtures.user();
    await follow(fan.id, from.id);
    // A reference applied after every module's own (registry order: module, then key) fails for this pair only.
    worker.get(OrganizationReferences).register('zz_s22', [
      {
        key: 'zz_s22.failing',
        rule: 'move',
        count: async () => ({ rows: 0, conflicts: 0 }),
        apply: async (_scope, f) => {
          if (f === from.id) throw new Error('S22 test: failing half-way');
          return { moved: 0, retired: 0 };
        },
      },
    ]);
    const job = await merge(from.id, into.id);
    expect(job).toMatchObject({ kind: 'organization_merge', status: 'failed', error_code: 'INTERNAL' });
    expect(await orgRow(from.id)).toEqual({ status: 'active', merged_into_organization_id: null });
    expect(await query(api, sql`SELECT subject_organization_id FROM trust.reviews WHERE id = ${r}::uuid`)).toEqual([
      { subject_organization_id: from.id },
    ]);
    expect(
      await query(api, sql`SELECT organization_id, status FROM community.follows WHERE user_id = ${fan.id}::uuid AND deleted_at IS NULL`),
    ).toEqual([{ organization_id: from.id, status: 'active' }]);
    expect(
      await query(api, sql`SELECT organization_id, status FROM organization.organization_locations WHERE id = ${from.locationId}::uuid`),
    ).toEqual([{ organization_id: from.id, status: 'active' }]);
    expect((await from.c.get(`/v1/orgs/${from.id}`)).status).toBe(200);
    const p = await query<{ public_status: string }>(
      api,
      sql`SELECT public_status FROM organization.provider_profiles WHERE organization_id = ${from.id}::uuid AND deleted_at IS NULL`,
    );
    expect(p).toEqual([{ public_status: 'published' }]);
  });
});

// ---------------------------------------------------------------- apply_redaction (BR-15)

const W = 200;
const H = 100;

async function image(o: { display?: boolean; type?: 'image' | 'document' } = {}): Promise<{ id: string; orgId: string }> {
  const org = await api.fixtures.org('provider');
  const uploader = await api.fixtures.user();
  const id = uuidv7();
  const doc = o.type === 'document';
  const png = doc
    ? Buffer.from('%PDF-1.4 test document')
    : await sharp({ create: { width: W, height: H, channels: 3, background: { r: 255, g: 255, b: 255 } } })
        .png()
        .toBuffer();
  await api.infra.storage.put(`media/${id}/original`, png, doc ? 'application/pdf' : 'image/png', { encrypt: doc });
  if (!doc && o.display !== false) {
    await api.infra.storage.put(`media/${id}/display`, await sharp(png).webp().toBuffer(), 'image/webp');
    await api.infra.storage.put(`media/${id}/thumb`, await sharp(png).webp().toBuffer(), 'image/webp');
  }
  await sys(({ db }) =>
    db
      .insertInto('media.media_assets')
      .values({
        id,
        owner_type: 'organization',
        owner_id: org.id,
        purpose: doc ? 'verification_document' : 'post',
        media_type: doc ? 'document' : 'image',
        mime_type: doc ? 'application/pdf' : 'image/png',
        file_size_bytes: String(png.length),
        checksum_sha256: createHash('sha256').update(png).digest('base64'),
        storage_reference: `media/${id}/original`,
        thumbnail_reference: doc ? null : `media/${id}/thumb`,
        width: doc ? null : W,
        height: doc ? null : H,
        privacy_level: doc ? 'private' : 'public',
        encrypted_at_rest: doc,
        scan_status: 'clean',
        exif_stripped: !doc,
        moderation_status: 'approved',
        uploaded_by: uploader.id,
        status: 'active',
      })
      .execute(),
  );
  return { id, orgId: org.id };
}

const asset = async (id: string) =>
  (
    await query<{ redaction_status: string; publicly_servable: boolean }>(
      api,
      sql`SELECT redaction_status, publicly_servable FROM media.media_assets WHERE id = ${id}::uuid`,
    )
  )[0]!;

/** The red channel of a pixel of a stored variant (0 black, 255 white). */
async function pixel(key: string, x: number, y: number): Promise<number> {
  const obj = await api.infra.storage.get(key);
  const { data, info } = await sharp(obj!.body).raw().toBuffer({ resolveWithObject: true });
  return data[(Math.floor(y * info.height) * info.width + Math.floor(x * info.width)) * info.channels]!;
}

describe('apply_redaction (BR-15, Docs/23 A-CON-02)', () => {
  const box = [{ x: '0.25', y: '0.25', w: '0.5', h: '0.5' }];
  const act = (caseId: string, params?: Json, target?: Json) =>
    mod.post(
      `/v1/admin/moderation/cases/${caseId}/actions`,
      { action_type: 'apply_redaction', reason: REASON, ...(params ? { params } : {}), ...(target ? { target } : {}) },
      purpose('case', caseId),
    );

  it('boxes the public copy in the worker; the original keeps its pixels; the file is public again once completed', async () => {
    const a = await image();
    expect(await asset(a.id)).toEqual({ redaction_status: 'not_needed', publicly_servable: true });
    const caseId = await openCase(api, { type: 'media_asset', targetId: a.id });
    const missing = await act(caseId);
    expect(missing.status).toBe(422);
    expect(missing.body.errors).toEqual([{ pointer: '/params/redaction_regions', code: 'conditional_required' }]);
    const outside = await act(caseId, { redaction_regions: [{ x: '0.75', y: '0.1', w: '0.5', h: '0.2' }] });
    expect(outside.status).toBe(422);
    expect(outside.body.errors).toEqual([{ pointer: '/params/redaction_regions/0', code: 'out_of_range' }]);

    const res = await act(caseId, { redaction_regions: box });
    expect(res.status, res.text).toBe(201);
    expect(res.body).toMatchObject({ action_type: 'apply_redaction', target: { type: 'media_asset', id: a.id } });
    const logged = await query<{ params: Json }>(api, sql`SELECT params FROM admin.moderation_actions WHERE id = ${res.body.id}::uuid`);
    expect(logged[0]!.params).toMatchObject({ regions: 1, previous_redaction_status: 'not_needed', job_id: expect.stringMatching(UUID) });
    await api.infra.jobs.idle();

    expect(await asset(a.id)).toEqual({ redaction_status: 'completed', publicly_servable: true });
    expect(await pixel(`media/${a.id}/display`, 0.5, 0.5)).toBeLessThan(10);
    expect(await pixel(`media/${a.id}/display`, 0.05, 0.05)).toBeGreaterThan(245);
    expect(await pixel(`media/${a.id}/thumb`, 0.5, 0.5)).toBeLessThan(10);
    expect(await pixel(`media/${a.id}/original`, 0.5, 0.5)).toBeGreaterThan(245);
    const view = await mod.get(`/v1/admin/moderation/cases/${caseId}`, purpose('case', caseId));
    expect(view.status, view.text).toBe(200);
    expect(view.body.target_snapshot).toMatchObject({ type: 'media_asset', id: a.id, redaction_status: 'completed' });
  });

  it('a redaction that cannot be written keeps the file off public serving; documents are refused', async () => {
    const a = await image({ display: false });
    const caseId = await openCase(api, { type: 'media_asset', targetId: a.id });
    expect((await act(caseId, { redaction_regions: box })).status).toBe(201);
    await api.infra.jobs.idle();
    expect(await asset(a.id)).toEqual({ redaction_status: 'failed', publicly_servable: false });

    const d = await image({ type: 'document' });
    const docCase = await openCase(api, { type: 'media_asset', targetId: d.id });
    const refused = await act(docCase, { redaction_regions: box });
    expect(refused.status, refused.text).toBe(409);
    // Other targets do not take the action.
    const orgCase = await openCase(api, { type: 'organization', targetId: d.orgId });
    expect((await act(orgCase, { redaction_regions: box })).status).toBe(409);
  });
});
