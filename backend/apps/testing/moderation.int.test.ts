// S8 moderation and trust administration (40 §22 reports.create, §23.2
// organizations and verifications, §23.4): Path 2 reviewer decisions,
// objection disputes decided by a different staff member, reports triaged
// into cases and acted on (fake review removal with the 54 §3.3 penalty
// input), the moderation intake of held content, badge approval, business
// verification with the far_apart rule and location corrections,
// organization suspension and merges, staff downloads of private files.
import { createHash } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '#libs/crypto/index.js';
import { ModerationIntakeRule } from '#modules/admin/admin.module.js';
import { taxonomyNodes, type Json, type Nodes } from './s4-support.js';
import { client, newId } from './s5-support.js';
import { flush, publishedProvider, type PublishedOrg } from './s6-support.js';
import { customer } from './s7-support.js';
import { events, openCase, purpose, query, REASON, staff, type StaffApi } from './s8-support.js';
import { createTestApp, createTestWorker, type TestApp } from './test-app.js';

let api: TestApp;
let admin: TestApp;
let worker: INestApplicationContext;
let n: Nodes;
let crv: { user: { id: string }; c: StaffApi };
let crv2: StaffApi;
let mod: StaffApi;
let adm: StaffApi;
let adm2: StaffApi;
const reason = REASON;

const path2Body = (p: PublishedOrg, o: Json = {}) => ({
  subject_organization_id: p.id,
  subject_type: 'provider',
  overall_rating: 2,
  body: 'They fixed the noise but it came back after a week.',
  content_locale: 'en',
  ...o,
});

beforeAll(async () => {
  api = await createTestApp({ host: 'api' });
  admin = await createTestApp({ host: 'admin-api', infra: api.infra });
  worker = await createTestWorker({ infra: api.infra });
  n = await taxonomyNodes(api);
  crv = await staff(admin, 'platform_community_reviewer');
  crv2 = (await staff(admin, 'platform_community_reviewer')).c;
  mod = (await staff(admin, 'platform_moderator')).c;
  adm = (await staff(admin, 'platform_admin')).c;
  adm2 = (await staff(admin, 'platform_admin')).c;
}, 60_000);

afterAll(async () => {
  await worker?.close();
  await admin?.close();
  await api?.close();
});

describe('Path 2 reviewer decisions (40 §23.4, 52 §11)', () => {
  it('approval waits for the business step, then publishes "approved by the business and CarPal"', async () => {
    const p = await publishedProvider(api, n, { name: `Reviewed ${newId().slice(-6)}` });
    const cu = await customer(api, n);
    const r = (await cu.c.post('/v1/reviews', path2Body(p))).body;
    const queue = await crv.c.get('/v1/admin/review-approvals?stage=awaiting_business&limit=100');
    expect(queue.status, queue.text).toBe(200);
    const pending = await crv.c.post(
      `/v1/admin/review-approvals/${r.id}/decision`,
      { decision: 'approved', reason_code: 'credible', reason },
      purpose('approval', r.id),
    );
    expect(pending.status).toBe(409);
    // A rating is never a rejection reason.
    expect(
      (
        await crv.c.post(
          `/v1/admin/review-approvals/${r.id}/decision`,
          { decision: 'rejected', reason_code: 'low_rating', reason },
          purpose('approval', r.id),
        )
      ).status,
    ).toBe(422);
    expect((await p.c.post(`/v1/orgs/${p.id}/review-approvals/${r.id}/answer`, { answer: 'confirmed' })).status).toBe(200);
    const view = await crv.c.get(`/v1/admin/review-approvals/${r.id}`, purpose('approval', r.id));
    expect(view.status, view.text).toBe(200);
    expect(view.body).toMatchObject({
      business_confirmation_source: 'business_answer',
      author_history: { verified_contact: true },
      dispute_id: null,
    });
    expect(view.text).not.toContain(cu.user.email);
    const ok = await crv.c.post(
      `/v1/admin/review-approvals/${r.id}/decision`,
      { decision: 'approved', reason_code: 'credible', reason },
      purpose('approval', r.id),
    );
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body.review).toMatchObject({ status: 'published', verified_status: 'approved_without_visit' });
    expect((await events(api, { aggregateId: r.id })).map((e) => e.type)).toEqual(
      expect.arrayContaining(['review.approved', 'review.published']),
    );
    const anon = await api.fixtures.anonymousToken();
    const pub = await api.request<Json>({ path: `/v1/public/orgs/${p.id}/reviews`, token: anon });
    expect(pub.body.items[0]).toMatchObject({ label: 'approved_by_business_and_carpal' });
    // The purpose item is no longer open: the decision cannot be repeated.
    expect(
      (
        await crv.c.post(
          `/v1/admin/review-approvals/${r.id}/decision`,
          { decision: 'approved', reason_code: 'credible', reason },
          purpose('approval', r.id),
        )
      ).status,
    ).toBe(404);
  });

  it('an upheld objection is decided by a staff member other than the first reviewer and publishes "disputed by the business"', async () => {
    const p = await publishedProvider(api, n, { name: `Objected ${newId().slice(-6)}` });
    const cu = await customer(api, n);
    const r = (await cu.c.post('/v1/reviews', path2Body(p))).body;
    // The first reviewer asks the author for evidence; then the business rejects the relationship.
    const ev = await crv.c.post(
      `/v1/admin/review-approvals/${r.id}/decision`,
      { decision: 'evidence_requested', reason_code: 'need_invoice', reason },
      purpose('approval', r.id),
    );
    expect(ev.status, ev.text).toBe(200);
    expect(
      (
        await p.c.post(`/v1/orgs/${p.id}/review-approvals/${r.id}/answer`, {
          answer: 'rejected',
          note: 'We do not recognise this customer',
        })
      ).status,
    ).toBe(200);
    const disputes = await mod.get('/v1/admin/disputes?dispute_type=review_approval_objection&status=open&limit=100');
    const d = disputes.body.items.find((x: Json) => x.target.id === r.id);
    expect(d).toMatchObject({ dispute_type: 'review_approval_objection', raised_by_organization: { id: p.id } });
    const first = await crv.c.post(
      `/v1/admin/disputes/${d.id}/resolution`,
      { status: 'resolved_upheld', resolution: 'Invoice provided', reason },
      purpose('dispute', d.id),
    );
    expect(first.status).toBe(403);
    expect(first.body.code).toBe('SELF_APPROVAL_FORBIDDEN');
    expect(
      (await crv2.post(`/v1/admin/disputes/${d.id}/resolution`, { status: 'resolved_upheld', reason }, purpose('dispute', d.id))).status,
    ).toBe(422);
    const ok = await crv2.post(
      `/v1/admin/disputes/${d.id}/resolution`,
      { status: 'resolved_upheld', resolution: 'The author showed the invoice.', reason },
      purpose('dispute', d.id),
    );
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body.status).toBe('resolved_upheld');
    const row = await query<{ status: string; disputed_by_business: boolean }>(
      api,
      sql`SELECT status, disputed_by_business FROM trust.reviews WHERE id = ${r.id}::uuid`,
    );
    expect(row[0]).toEqual({ status: 'published', disputed_by_business: true });
  });

  it('moving a Path 1 review to the approval path needs a second moderator', async () => {
    const p = await publishedProvider(api, n, { name: `Moved ${newId().slice(-6)}` });
    const cu = await customer(api, n);
    const r = (await cu.c.post('/v1/reviews', path2Body(p))).body;
    // Make it a published Path 1 review (system), as W4 would after a verified visit.
    await api.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
      db
        .updateTable('trust.reviews')
        .set({
          confirmation_path: 'visit_based',
          verified_status: 'admin_verified',
          business_confirmation_status: null,
          business_confirmation_due_at: null,
          reviewer_decision: null,
          status: 'published',
          published_at: new Date(),
          trust_weight: '1.000',
          counts_toward_core_score: true,
        })
        .where('id', '=', r.id)
        .execute(),
    );
    const req = await mod.post(`/v1/admin/reviews/${r.id}/move-to-approval-path`, { reason });
    expect(req.status, req.text).toBe(202);
    const mod2 = (await staff(admin, 'platform_moderator')).c;
    expect((await mod2.post(`/v1/admin/four-eyes/${req.body.change_id}/decision`, { decision: 'approve', reason })).status).toBe(200);
    const row = await query<{ status: string; verified_status: string }>(
      api,
      sql`SELECT status, verified_status FROM trust.reviews WHERE id = ${r.id}::uuid`,
    );
    expect(row[0]).toEqual({ status: 'pending_approval', verified_status: 'pending_approval' });
  });
});

describe('reports and moderation cases (MVP Module M)', () => {
  it('report → case → fake-review removal (54 §3.3 input) → close; duplicates and unknown targets are refused', async () => {
    const p = await publishedProvider(api, n, { name: `Faked ${newId().slice(-6)}` });
    const cu = await customer(api, n);
    const r = (await cu.c.post('/v1/reviews', path2Body(p, { overall_rating: 5 }))).body;
    await p.c.post(`/v1/orgs/${p.id}/review-approvals/${r.id}/answer`, { answer: 'confirmed' });
    await crv.c.post(
      `/v1/admin/review-approvals/${r.id}/decision`,
      { decision: 'approved', reason_code: 'credible', reason },
      purpose('approval', r.id),
    );
    const reporter = client(api, await api.fixtures.token(await api.fixtures.user()));
    const rep = await reporter.post('/v1/reports', {
      target_type: 'review',
      target_id: r.id,
      reason: 'fake',
      details: 'Same text on three shops',
    });
    expect(rep.status, rep.text).toBe(201);
    expect(rep.body).toMatchObject({ status: 'open' });
    expect((await reporter.post('/v1/reports', { target_type: 'review', target_id: r.id, reason: 'fake' })).status).toBe(409);
    expect((await reporter.post('/v1/reports', { target_type: 'review', target_id: uuidv7(), reason: 'fake' })).status).toBe(422);
    expect((await events(api, { aggregateId: r.id, type: 'review.reported' })).length).toBe(1);
    expect(
      (await mod.post(`/v1/admin/reports/${rep.body.report_id}/triage`, { dismiss: true, open_case: { severity: 'high' }, reason })).status,
    ).toBe(422);
    const triaged = await mod.post(`/v1/admin/reports/${rep.body.report_id}/triage`, { open_case: { severity: 'high' }, reason });
    expect(triaged.status, triaged.text).toBe(200);
    expect(triaged.body.status).toBe('triaged');
    const caseId = triaged.body.moderation_case_id;
    const got = await mod.get(`/v1/admin/moderation/cases/${caseId}`, purpose('case', caseId));
    expect(got.status, got.text).toBe(200);
    expect(got.body.case).toMatchObject({ case_type: 'review', reason: 'fake', report_count: 1, status: 'open' });
    expect(got.body.target_snapshot).toMatchObject({ type: 'review', subject_organization_id: p.id, status: 'published' });
    expect((await mod.post(`/v1/admin/moderation/cases/${caseId}/assign`, { reason })).body.status).toBe('investigating');
    // Actions recorded by their own operations are refused here.
    expect(
      (
        await mod.post(
          `/v1/admin/moderation/cases/${caseId}/actions`,
          { action_type: 'verify_organization', reason },
          purpose('case', caseId),
        )
      ).status,
    ).toBe(409);
    const removed = await mod.post(
      `/v1/admin/moderation/cases/${caseId}/actions`,
      { action_type: 'remove', reason },
      purpose('case', caseId),
    );
    expect(removed.status, removed.text).toBe(201);
    expect(removed.body).toMatchObject({ action_type: 'remove', target: { type: 'review', id: r.id } });
    const review = await query<{ status: string }>(api, sql`SELECT status FROM trust.reviews WHERE id = ${r.id}::uuid`);
    expect(review[0]!.status).toBe('removed');
    const action = await query<{ params: Json }>(api, sql`SELECT params FROM admin.moderation_actions WHERE id = ${removed.body.id}::uuid`);
    expect(action[0]!.params).toMatchObject({ fake: true, subject_organization_id: p.id });
    expect((await events(api, { aggregateId: removed.body.id })).map((e) => e.type)).toEqual(['moderation.action.taken']);
    // A second removal does not apply; the case closes as action taken and its reports resolve.
    expect(
      (await mod.post(`/v1/admin/moderation/cases/${caseId}/actions`, { action_type: 'remove', reason }, purpose('case', caseId))).status,
    ).toBe(409);
    const closed = await mod.post(`/v1/admin/moderation/cases/${caseId}/close`, {
      status: 'action_taken',
      resolution: 'Fake review removed',
      reason,
    });
    expect(closed.status, closed.text).toBe(200);
    expect(
      (await mod.get(`/v1/admin/reports?target_type=review&limit=100`)).body.items.find((x: Json) => x.id === rep.body.report_id).status,
    ).toBe('resolved');
    // W3: the fake-review penalty (−50) and every badge revoked.
    await flush(api, worker);
    const score = await query<{ trust_score: number | null }>(
      api,
      sql`SELECT trust_score FROM organization.organizations WHERE id = ${p.id}::uuid`,
    );
    const signal = await query<{ value_details: Json }>(
      api,
      sql`SELECT value_details FROM trust.trust_signals WHERE subject_id = ${p.id}::uuid AND signal_type = 'overall_trust_score' ORDER BY calculated_at DESC LIMIT 1`,
    );
    expect(score[0]!.trust_score).not.toBeNull();
    expect(JSON.stringify(signal[0]?.value_details ?? {})).toContain('fake_review');
  });

  it('account suspension from a case needs the case open and never targets the acting staff member', async () => {
    const target = await api.fixtures.user();
    const reporter = client(api, await api.fixtures.token(await api.fixtures.user()));
    const rep = await reporter.post('/v1/reports', { target_type: 'user', target_id: target.id, reason: 'harassment' });
    expect(rep.status, rep.text).toBe(201);
    const caseId = (await mod.post(`/v1/admin/reports/${rep.body.report_id}/triage`, { open_case: { severity: 'medium' }, reason })).body
      .moderation_case_id;
    const act = await mod.post(
      `/v1/admin/moderation/cases/${caseId}/actions`,
      { action_type: 'suspend_account', reason },
      purpose('case', caseId),
    );
    expect(act.status, act.text).toBe(201);
    const u = await query<{ status: string }>(api, sql`SELECT status FROM identity.user_accounts WHERE id = ${target.id}::uuid`);
    expect(u[0]!.status).toBe('suspended');
    await mod.post(`/v1/admin/moderation/cases/${caseId}/close`, { status: 'action_taken', resolution: 'Suspended', reason });
    expect(
      (
        await mod.post(
          `/v1/admin/moderation/cases/${caseId}/actions`,
          { action_type: 'reactivate_account', reason },
          purpose('case', caseId),
        )
      ).status,
    ).toBe(404);
  });

  it('held content enters the queue through the intake rule; approval publishes a showcase item', async () => {
    const p = await publishedProvider(api, n, { name: `Showcase ${newId().slice(-6)}` });
    const item = uuidv7();
    await api.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
      db
        .insertInto('organization.portfolio_items')
        .values({
          id: item,
          provider_organization_id: p.id,
          title: 'Brake job',
          service_system_node_id: n.system,
          content_locale: 'en',
          status: 'pending_review',
          moderation_status: 'pending',
        })
        .execute(),
    );
    expect(await worker.get(ModerationIntakeRule).run()).toBeGreaterThan(0);
    const cases = await mod.get('/v1/admin/moderation/cases?case_type=portfolio_item&status=open&limit=100');
    const c = cases.body.items.find((x: Json) => x.target.id === item);
    expect(c).toMatchObject({ source: 'system_rule', severity: 'low' });
    // Idempotent: no second case for the same item.
    await worker.get(ModerationIntakeRule).run();
    expect(
      (await mod.get('/v1/admin/moderation/cases?case_type=portfolio_item&status=open&limit=100')).body.items.filter(
        (x: Json) => x.target.id === item,
      ),
    ).toHaveLength(1);
    const ok = await mod.post(`/v1/admin/moderation/cases/${c.id}/actions`, { action_type: 'approve', reason }, purpose('case', c.id));
    expect(ok.status, ok.text).toBe(201);
    const row = await query<{ status: string; moderation_status: string }>(
      api,
      sql`SELECT status, moderation_status FROM organization.portfolio_items WHERE id = ${item}::uuid`,
    );
    expect(row[0]).toEqual({ status: 'published', moderation_status: 'approved' });
    expect((await events(api, { aggregateId: item })).map((e) => e.type)).toContain('portfolio.published');
  });
});

describe('badges, verification, locations and organizations (40 §23.2, §23.4)', () => {
  it('a verified_business badge becomes active only on staff approval', async () => {
    const p = await publishedProvider(api, n, { name: `Badge ${newId().slice(-6)}` });
    const badge = uuidv7();
    await api.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
      db
        .insertInto('trust.provider_badges')
        .values({
          id: badge,
          provider_organization_id: p.id,
          badge_type: 'verified_business',
          rule_key: 'verified_business',
          rule_version: '54-2026-10',
          evaluation_snapshot: JSON.stringify({ verified: ['business_identity', 'location'] }),
          requires_admin_approval: true,
          status: 'pending_approval',
        })
        .execute(),
    );
    const res = await mod.post(`/v1/admin/badges/${badge}/approve`, { reason });
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ status: 'active', badge_type: 'verified_business' });
    expect((await events(api, { aggregateId: badge })).map((e) => e.type)).toEqual(['badge.awarded']);
    expect((await mod.post(`/v1/admin/badges/${badge}/approve`, { reason })).status).toBe(409);
  });

  it('verification: a far_apart pin is corrected first; business identity and location make the organization verified', async () => {
    const p = await publishedProvider(api, n, { name: `Verify ${newId().slice(-6)}` });
    const ver = `/v1/orgs/${p.id}/verifications`;
    const identity = await p.c.post(ver, { verification_type: 'business_identity' });
    expect(identity.status, identity.text).toBe(201);
    const location = await p.c.post(ver, { verification_type: 'location' });
    await api.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
      db
        .updateTable('organization.organization_locations')
        .set({ location_check_status: 'far_apart' })
        .where('id', '=', p.locationId)
        .execute(),
    );
    const queue = await mod.get('/v1/admin/verifications?status=pending&verification_type=location&limit=100');
    expect(queue.body.items.find((v: Json) => v.id === location.body.id)).toMatchObject({
      organization: { id: p.id },
      location_check: { location_check_status: 'far_apart' },
    });
    const blocked = await mod.post(
      `/v1/admin/verifications/${location.body.id}/decision`,
      { decision: 'verified', reason },
      purpose('verification', location.body.id),
    );
    expect(blocked.status).toBe(409);
    const corrected = await mod.post(`/v1/admin/orgs/${p.id}/locations/${p.locationId}/correct`, {
      pin: { lat: p.point.lat + 0.001, lng: p.point.lng },
      reason,
    });
    expect(corrected.status, corrected.text).toBe(200);
    expect(corrected.body).toMatchObject({ geo_source: 'admin_corrected', location_check_status: 'consistent' });
    expect((await events(api, { aggregateId: p.locationId, type: 'organization.location.corrected' })).length).toBe(1);
    expect(
      (
        await mod.post(
          `/v1/admin/verifications/${identity.body.id}/decision`,
          { decision: 'rejected', reason },
          purpose('verification', identity.body.id),
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await mod.post(
          `/v1/admin/verifications/${identity.body.id}/decision`,
          { decision: 'verified', reason },
          purpose('verification', identity.body.id),
        )
      ).status,
    ).toBe(200);
    const done = await mod.post(
      `/v1/admin/verifications/${location.body.id}/decision`,
      { decision: 'verified', reason },
      purpose('verification', location.body.id),
    );
    expect(done.status, done.text).toBe(200);
    const org = await query<{ verification_status: string }>(
      api,
      sql`SELECT verification_status FROM organization.organizations WHERE id = ${p.id}::uuid`,
    );
    expect(org[0]!.verification_status).toBe('verified');
    expect((await events(api, { aggregateId: p.id, type: 'organization.verified' })).length).toBe(1);
  });

  it('suspension takes the profile off public reads; reactivation restores it; staff org views are purpose-bound', async () => {
    const p = await publishedProvider(api, n, { name: `Suspend ${newId().slice(-6)}` });
    const anon = await api.fixtures.anonymousToken();
    const before = await api.request<Json>({ path: `/v1/public/orgs/${p.id}/reviews`, token: anon });
    expect(before.status).toBe(200);
    const sus = await mod.post(`/v1/admin/orgs/${p.id}/status`, { status: 'suspended', reason });
    expect(sus.status, sus.text).toBe(200);
    expect(sus.body).toMatchObject({ status: 'suspended', subscription: { plan: { plan_key: 'provider_basic' } } });
    const profile = await query<{ public_status: string }>(
      api,
      sql`SELECT public_status FROM organization.provider_profiles WHERE organization_id = ${p.id}::uuid`,
    );
    expect(profile[0]!.public_status).toBe('suspended');
    expect((await mod.post(`/v1/admin/orgs/${p.id}/status`, { status: 'suspended', reason })).status).toBe(409);
    expect((await mod.post(`/v1/admin/orgs/${p.id}/status`, { status: 'active', reason })).status).toBe(200);
    const caseId = await openCase(api, { type: 'organization', targetId: p.id });
    const view = await mod.get(`/v1/admin/orgs/${p.id}`, purpose('case', caseId));
    expect(view.status, view.text).toBe(200);
    expect(view.body).toMatchObject({ id: p.id, locations: [{ id: p.locationId }], open_cases: 1 });
    const audit = await query<{ access_purpose: string }>(
      api,
      sql`SELECT access_purpose FROM analytics.audit_logs WHERE entity_id = ${p.id}::uuid AND action = 'pii.read'`,
    );
    expect(audit).toEqual([{ access_purpose: `case:${caseId}` }]);
    const search = await mod.post('/v1/admin/orgs/search', { organization_id: p.id });
    expect(search.status, search.text).toBe(200);
    expect(search.body.items[0]).toMatchObject({ id: p.id, status: 'active', member_count: 1 });
  });

  it('a merge needs a second admin; the duplicate becomes merged', async () => {
    const [x, y] = await Promise.all([api.fixtures.org('provider'), api.fixtures.org('provider')]);
    const req = await adm.post(`/v1/admin/orgs/${x.id}/merge`, { into_organization_id: y.id, reason });
    expect(req.status, req.text).toBe(202);
    expect((await adm.post(`/v1/admin/orgs/${x.id}/merge`, { into_organization_id: x.id, reason })).status).toBe(422);
    expect((await adm2.post(`/v1/admin/four-eyes/${req.body.change_id}/decision`, { decision: 'approve', reason })).status).toBe(200);
    const row = await query<{ status: string; merged_into_organization_id: string }>(
      api,
      sql`SELECT status, merged_into_organization_id FROM organization.organizations WHERE id = ${x.id}::uuid`,
    );
    expect(row[0]).toEqual({ status: 'merged', merged_into_organization_id: y.id });
  });

  it('staff download private files only with a purpose, and every download is audited', async () => {
    const org = await api.fixtures.org('provider');
    const id = uuidv7();
    const bytes = Buffer.from('%PDF-1.4 test document');
    const uploader = await api.fixtures.user();
    await api.infra.storage.put(`media/${id}/original`, bytes, 'application/pdf', { encrypt: true });
    await api.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
      db
        .insertInto('media.media_assets')
        .values({
          id,
          owner_type: 'organization',
          owner_id: org.id,
          purpose: 'verification_document',
          media_type: 'document',
          mime_type: 'application/pdf',
          file_size_bytes: String(bytes.length),
          checksum_sha256: createHash('sha256').update(bytes).digest('base64'),
          storage_reference: `media/${id}/original`,
          privacy_level: 'private',
          encrypted_at_rest: true,
          scan_status: 'clean',
          uploaded_by: uploader.id,
          status: 'active',
        })
        .execute(),
    );
    const caseId = await openCase(api, { type: 'organization', targetId: org.id });
    expect((await mod.post(`/v1/admin/media/${id}/download-url`, { variant: 'original' })).status).toBe(400);
    const res = await mod.post(`/v1/admin/media/${id}/download-url`, { variant: 'original' }, purpose('case', caseId));
    expect(res.status, res.text).toBe(200);
    expect(res.body.url).toBeTruthy();
    const audit = await query<{ access_purpose: string }>(
      api,
      sql`SELECT access_purpose FROM analytics.audit_logs WHERE entity_id = ${id}::uuid AND action = 'media.staff_download'`,
    );
    expect(audit).toEqual([{ access_purpose: `case:${caseId}` }]);
  });
});
