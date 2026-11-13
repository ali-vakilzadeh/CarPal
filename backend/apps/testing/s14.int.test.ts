// S14 (contract 1.4.0; backend/BR-update-plan.json S14): staff access purposes bound to the record (BR-09, RCP-01,
// NI-02), the narrow organization search row (BR-35 part 1, DI-31) and timed suspensions lifted by the scheduler
// (BR-07, DI-66). The contract sweep probes every PURP route with an unrelated purpose (runner.ts); this file covers
// the RCP-01 scenario, the subjects of each queue kind, the scoped user search, moderation actions on other records,
// the search row and the suspension rule.
import type { INestApplicationContext } from '@nestjs/common';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadRegistry } from '#libs/contract/index.js';
import { uuidv7 } from '#libs/crypto/index.js';
import type { TestUser } from '#libs/testing/index.js';
import { PurposeBindings, PurposeSubjects, subjectKey } from '#modules/admin/interface/admin.js';
import { SuspensionExpiryRule } from '#modules/identity/application/suspension-rule.js';
import type { Json } from './s4-support.js';
import { openCase, purpose, query, REASON, staff, type StaffApi } from './s8-support.js';
import { createTestApp, createTestWorker, type TestApp } from './test-app.js';

let api: TestApp;
let admin: TestApp;
let worker: INestApplicationContext;
let moderator: StaffApi;
let support: StaffApi;
let userA: TestUser;
let userB: TestUser;
let caseA: string;

const sys = <T>(fn: Parameters<TestApp['fixtures']['worker']['run']>[1]) =>
  api.fixtures.worker.run({ actorType: 'system' }, fn) as Promise<T>;

/** The subjects of a purpose item, as "type:id" keys (the item itself first). */
const subjectsOf = (kind: 'case' | 'dispute' | 'dsr' | 'verification' | 'approval', id: string) =>
  sys<string[]>(async (scope) => (await admin.app.get(PurposeSubjects).of(scope, { kind, id, value: `${kind}:${id}` })).map(subjectKey));

beforeAll(async () => {
  api = await createTestApp({ host: 'api' });
  admin = await createTestApp({ host: 'admin-api', infra: api.infra });
  worker = await createTestWorker({ infra: api.infra });
  moderator = (await staff(admin, 'platform_moderator')).c;
  support = (await staff(admin, 'platform_support')).c;
  [userA, userB] = await Promise.all([api.fixtures.user(), api.fixtures.user()]);
  caseA = await openCase(api, { type: 'user', targetId: userA.id });
}, 60_000);

afterAll(async () => {
  await worker?.close();
  await admin?.close();
  await api?.close();
});

describe('purpose bound to the record (BR-09, RCP-01)', () => {
  it('every PURP operation has a record binding (an operation without one refuses every purpose)', () => {
    const purp = loadRegistry()
      .operations.filter((o) => o.sec.includes('PURP'))
      .map((o) => o.opId)
      .sort();
    expect(purp).toHaveLength(14);
    expect(admin.app.get(PurposeBindings).opIds().sort()).toEqual(purp);
  });

  it('RCP-01 scenario: a case about user A does not unlock user B; A is read with pii.read naming the case and A', async () => {
    const other = await moderator.get(`/v1/admin/users/${userB.id}`, purpose('case', caseA));
    expect(other.status, other.text).toBe(403);
    expect(other.body).toMatchObject({ code: 'PURPOSE_RECORD_MISMATCH' });
    expect(other.text).not.toContain(userB.email);
    // A record that does not exist gets the same answer (no oracle).
    const ghost = await moderator.get(`/v1/admin/users/${uuidv7()}`, purpose('case', caseA));
    expect([ghost.status, ghost.body.code]).toEqual([403, 'PURPOSE_RECORD_MISMATCH']);

    const own = await moderator.get(`/v1/admin/users/${userA.id}`, purpose('case', caseA));
    expect(own.status, own.text).toBe(200);
    expect(own.body.id).toBe(userA.id);
    const audit = await query<{ access_purpose: string; new_state_summary: string }>(
      api,
      sql`SELECT access_purpose, new_state_summary FROM analytics.audit_logs
           WHERE action = 'pii.read' AND entity_id = ${userA.id}::uuid AND access_purpose = ${`case:${caseA}`}`,
    );
    expect(audit.map((x) => x.new_state_summary)).toContain(`account view; subject user:${userA.id}`);
    // Nothing was logged for B: the request never reached the handler.
    const leaked = await query(api, sql`SELECT 1 FROM analytics.audit_logs WHERE action = 'pii.read' AND entity_id = ${userB.id}::uuid`);
    expect(leaked).toHaveLength(0);
  });

  it('a purpose item is about itself only: another case under this case is refused, an unknown item stays 404', async () => {
    const otherCase = await openCase(api, { type: 'user', targetId: userB.id });
    const res = await moderator.get(`/v1/admin/moderation/cases/${otherCase}`, purpose('case', caseA));
    expect([res.status, res.body.code]).toEqual([403, 'PURPOSE_RECORD_MISMATCH']);
    expect((await moderator.get(`/v1/admin/moderation/cases/${otherCase}`, purpose('case', otherCase))).status).toBe(200);
    expect((await moderator.get(`/v1/admin/users/${userA.id}`, purpose('case', uuidv7()))).status).toBe(404);
  });

  it('a user search under a purpose finds only the item’s subjects (empty page, never a refusal)', async () => {
    const miss = await support.post('/v1/admin/users/search', { email: userB.email }, purpose('case', caseA));
    expect(miss.status, miss.text).toBe(200);
    expect(miss.body.items).toEqual([]);
    const hit = await support.post('/v1/admin/users/search', { email: userA.email }, purpose('case', caseA));
    expect(hit.status, hit.text).toBe(200);
    expect((hit.body.items as Json[]).map((u) => u.id)).toEqual([userA.id]);
  });

  it('case subjects: target, its author and organization, and the reporters', async () => {
    const reporter = await api.fixtures.user();
    const org = await api.fixtures.org('provider');
    const caseOrg = await openCase(api, { type: 'organization', targetId: org.id });
    await sys(({ db }) =>
      db
        .insertInto('admin.content_reports')
        .values({
          reporter_user_id: reporter.id,
          target_type: 'organization',
          target_id: org.id,
          reason: 'other',
          moderation_case_id: caseOrg,
        })
        .execute(),
    );
    expect(await subjectsOf('case', caseOrg)).toEqual([`case:${caseOrg}`, `organization:${org.id}`, `user:${reporter.id}`]);
    expect(await subjectsOf('case', caseA)).toEqual([`case:${caseA}`, `user:${userA.id}`]);
    // The reporter of the case can be read under it; the organization too, another organization cannot.
    expect((await moderator.get(`/v1/admin/users/${reporter.id}`, purpose('case', caseOrg))).status).toBe(200);
    const otherOrg = await api.fixtures.org('provider');
    const res = await moderator.get(`/v1/admin/orgs/${otherOrg.id}`, purpose('case', caseOrg));
    expect([res.status, res.body.code]).toEqual([403, 'PURPOSE_RECORD_MISMATCH']);
  });

  it('dsr, verification and dispute subjects; a dispute about a review admits that review only', async () => {
    const dsr = uuidv7();
    await sys(({ db }) =>
      db.insertInto('identity.data_subject_requests').values({ id: dsr, user_id: userA.id, request_type: 'export' }).execute(),
    );
    expect(await subjectsOf('dsr', dsr)).toEqual([`dsr:${dsr}`, `user:${userA.id}`]);

    const org = await api.fixtures.org('provider');
    const [verification, doc] = [uuidv7(), uuidv7()];
    await sys(({ db }) =>
      db
        .insertInto('organization.organization_verifications')
        .values({
          id: verification,
          organization_id: org.id,
          verification_type: 'business_identity',
          submitted_document_ids: [doc],
          created_by: userB.id,
        })
        .execute(),
    );
    expect(await subjectsOf('verification', verification)).toEqual([
      `verification:${verification}`,
      `organization:${org.id}`,
      `user:${userB.id}`,
      `media_asset:${doc}`,
    ]);
    // A verification purpose reads its submitter, not someone else; an unknown file is refused like an unrelated one.
    expect((await moderator.get(`/v1/admin/users/${userB.id}`, purpose('verification', verification))).status).toBe(200);
    const notSubject = await moderator.get(`/v1/admin/users/${userA.id}`, purpose('verification', verification));
    expect([notSubject.status, notSubject.body.code]).toEqual([403, 'PURPOSE_RECORD_MISMATCH']);
    const file = await moderator.post(
      `/v1/admin/media/${uuidv7()}/download-url`,
      { variant: 'display' },
      purpose('verification', verification),
    );
    expect([file.status, file.body.code]).toEqual([403, 'PURPOSE_RECORD_MISMATCH']);

    const [dispute, review] = [uuidv7(), uuidv7()];
    await sys(({ db }) =>
      db
        .insertInto('trust.disputes')
        .values({
          id: dispute,
          target_entity_type: 'review',
          target_entity_id: review,
          dispute_type: 'inaccurate_review',
          raised_by_user_id: userA.id,
          raised_by_organization_id: org.id,
          reason: 'The review describes a different visit.',
        })
        .execute(),
    );
    expect(await subjectsOf('dispute', dispute)).toEqual([
      `dispute:${dispute}`,
      `user:${userA.id}`,
      `organization:${org.id}`,
      `review:${review}`,
    ]);
    // The disputed review passes the binding (then 404: this fixture review does not exist); another review is refused.
    const crv = (await staff(admin, 'platform_community_reviewer')).c;
    expect((await crv.get(`/v1/admin/review-approvals/${review}`, purpose('dispute', dispute))).status).toBe(404);
    const otherReview = await crv.get(`/v1/admin/review-approvals/${uuidv7()}`, purpose('dispute', dispute));
    expect([otherReview.status, otherReview.body.code]).toEqual([403, 'PURPOSE_RECORD_MISMATCH']);
  });

  it('a moderation action under a case acts on the case’s subjects only', async () => {
    const target = await api.fixtures.user();
    const caseT = await openCase(api, { type: 'user', targetId: target.id });
    const res = await moderator.post(
      `/v1/admin/moderation/cases/${caseT}/actions`,
      { action_type: 'warn_user', target: { type: 'user', id: userB.id }, reason: REASON },
      purpose('case', caseT),
    );
    expect([res.status, res.body.code], res.text).toEqual([403, 'PURPOSE_RECORD_MISMATCH']);
    const ghost = await moderator.post(
      `/v1/admin/moderation/cases/${caseT}/actions`,
      { action_type: 'warn_user', target: { type: 'user', id: uuidv7() }, reason: REASON },
      purpose('case', caseT),
    );
    expect([ghost.status, ghost.body.code]).toEqual([403, 'PURPOSE_RECORD_MISMATCH']);
    const ok = await moderator.post(
      `/v1/admin/moderation/cases/${caseT}/actions`,
      { action_type: 'warn_user', target: { type: 'user', id: target.id }, reason: REASON },
      purpose('case', caseT),
    );
    expect(ok.status, ok.text).toBe(201);
    const actions = await query(
      api,
      sql`SELECT 1 FROM admin.moderation_actions WHERE target_entity_id = ${userB.id}::uuid AND moderation_case_id = ${caseT}::uuid`,
    );
    expect(actions).toHaveLength(0);
  });
});

describe('organization search row (BR-35 part 1, DI-31)', () => {
  it('carries the queue facts without contact data or points', async () => {
    const org = await api.fixtures.org('provider');
    await sys(async ({ db }) => {
      const loc = await db
        .insertInto('organization.organization_locations')
        .values({
          organization_id: org.id,
          address_line_1: '12 Test Street',
          city: 'Tehran',
          country: 'IR',
          latitude: '35.689',
          longitude: '51.389',
          public_latitude: '35.69',
          public_longitude: '51.39',
          geo_source: 'user_pin',
          timezone: 'Asia/Tehran',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db.updateTable('organization.organizations').set({ primary_location_id: loc.id }).where('id', '=', org.id).execute();
    });
    const res = await moderator.post('/v1/admin/orgs/search', { organization_id: org.id, limit: 1 });
    expect(res.status, res.text).toBe(200);
    const row = (res.body.items as Json[])[0]!;
    expect(row).toMatchObject({
      id: org.id,
      organization_type: 'provider',
      city: 'Tehran',
      member_count: 0,
      open_cases: 0,
      pending_verifications: [],
    });
    for (const k of ['contact_email', 'contact_phone', 'locations', 'verifications', 'subscription']) expect(row).not.toHaveProperty(k);
    expect(res.text).not.toContain(`org-${org.id}@test.carpal.app`);
    expect(res.text).not.toContain('51.389');
  });
});

describe('timed suspensions end on their own (BR-07, DI-66)', () => {
  it('admin.user_status stores the end; the scheduler lifts it with an audit entry and the reactivation event', async () => {
    const admin1 = (await staff(admin, 'platform_admin')).c;
    const u = await api.fixtures.user();
    const until = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const res = await admin1.post(`/v1/admin/users/${u.id}/status`, { status: 'suspended', reason: REASON, suspend_until: until });
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ status: 'suspended', suspended_until: until });
    const rule = worker.get(SuspensionExpiryRule);

    // Not lifted before its end.
    await rule.run();
    expect((await query<{ status: string }>(api, sql`SELECT status FROM identity.user_accounts WHERE id = ${u.id}::uuid`))[0]!.status).toBe(
      'suspended',
    );
    // Its end has passed: lifted at the next run.
    await sys(({ db }) =>
      db
        .updateTable('identity.user_accounts')
        .set({ suspended_until: new Date(Date.now() - 1000) })
        .where('id', '=', u.id)
        .execute(),
    );
    expect(await rule.run()).toBeGreaterThanOrEqual(1);
    const [row] = await query<{ status: string; suspended_until: Date | null }>(
      api,
      sql`SELECT status, suspended_until FROM identity.user_accounts WHERE id = ${u.id}::uuid`,
    );
    expect(row).toEqual({ status: 'active', suspended_until: null });
    const audit = await query<{ actor_type: string; previous_state_summary: string; new_state_summary: string }>(
      api,
      sql`SELECT actor_type, previous_state_summary, new_state_summary FROM analytics.audit_logs
           WHERE entity_id = ${u.id}::uuid AND action = 'user.status_changed' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(audit[0]).toMatchObject({ actor_type: 'system', previous_state_summary: 'suspended', new_state_summary: 'active' });
    const events = await query<{ payload: Json }>(
      api,
      sql`SELECT payload FROM core.domain_event_outbox WHERE event_type = 'moderation.action.taken' AND aggregate_id = ${u.id}::uuid`,
    );
    expect(events.map((e) => e.payload)).toContainEqual(expect.objectContaining({ action_type: 'reactivate_account', user_id: u.id }));

    // A staff status change clears the end: a later suspension without one stays until someone lifts it.
    const again = await admin1.post(`/v1/admin/users/${u.id}/status`, { status: 'suspended', reason: REASON });
    expect(again.body.suspended_until).toBeNull();
  });
});
