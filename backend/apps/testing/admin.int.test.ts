// S8 admin plane: host separation and staff sessions, four-eyes changes,
// purpose-bound PII reads with their audit, users and platform roles, data
// subject requests (export bundle through W8; deletion through four-eyes and
// the worker, leaving no linkable analytics events), feature flags and the
// kill switch, retention, audit search, product analytics (events.ingest →
// W12 → dashboards), billing and taxonomy administration, MCP oversight and
// assisted onboarding sessions.
import type { INestApplicationContext } from '@nestjs/common';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '#libs/crypto/index.js';
import { FlagService } from '#libs/flags/index.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import type { TestUser } from '#libs/testing/index.js';
import { AnalyticsPools, DailyMetricsRule } from '#modules/analytics/analytics.module.js';
import type { Json } from './s4-support.js';
import { client } from './s5-support.js';
import { flush } from './s6-support.js';
import { openCase as openCaseFor, purpose, query, REASON, staff, staffApi, type StaffApi } from './s8-support.js';
import { createTestApp, createTestWorker, type TestApp } from './test-app.js';

let api: TestApp;
let admin: TestApp;
let worker: INestApplicationContext;
let adminA: TestUser;
let adminB: TestUser;
let a: StaffApi;
let b: StaffApi;
let support: StaffApi;

const reason = REASON;

beforeAll(async () => {
  api = await createTestApp({ host: 'api' });
  admin = await createTestApp({ host: 'admin-api', infra: api.infra });
  worker = await createTestWorker({ infra: api.infra });
  const sa = await staff(admin, 'platform_admin');
  const sb = await staff(admin, 'platform_admin');
  adminA = sa.user;
  adminB = sb.user;
  a = sa.c;
  b = sb.c;
  support = (await staff(admin, 'platform_support')).c;
}, 60_000);

afterAll(async () => {
  await worker?.close();
  await admin?.close();
  await api?.close();
});

describe('admin plane foundations (SEC-ADM)', () => {
  it('admin operations exist only on admin-api; consumer tokens and weak staff sessions are refused there', async () => {
    const user = await api.fixtures.user();
    const consumer = await api.fixtures.token(user);
    // The api host has no admin routes at all.
    expect((await api.request({ path: '/v1/admin/flags', token: consumer })).status).toBe(404);
    // A consumer token on admin-api: wrong audience → 401.
    expect((await admin.request({ path: '/v1/admin/flags', token: consumer })).status).toBe(401);
    // Staff without the role → 404; a staff session below aal3 → 401.
    expect((await support.get('/v1/admin/flags')).status).toBe(404);
    const weak = await admin.fixtures.token(adminA, { staff: true, acr: 'aal2' });
    expect((await staffApi(admin, weak).get('/v1/admin/flags')).status).toBe(401);
    expect((await a.get('/v1/admin/flags?limit=100')).status).toBe(200);
  });

  it('PURP needs a purpose of an open item in the caller queue; PII reads write pii.read with the purpose (SEC-LOG-4)', async () => {
    const target = await api.fixtures.user();
    expect((await a.get(`/v1/admin/users/${target.id}`)).status).toBe(400);
    expect((await a.get(`/v1/admin/users/${target.id}`, purpose('case', uuidv7()))).status).toBe(404);
    const caseId = await openCaseFor(api, { targetId: target.id });
    const res = await a.get(`/v1/admin/users/${target.id}`, purpose('case', caseId));
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ id: target.id, email: target.email, subscription: { plan_key: 'individual_free' } });
    expect(res.headers['cache-control']).toBe('no-store');
    const rows = await query<{ action: string; access_purpose: string; actor_type: string }>(
      api,
      sql`SELECT action, access_purpose, actor_type FROM analytics.audit_logs WHERE entity_id = ${target.id}::uuid AND action = 'pii.read'`,
    );
    expect(rows).toEqual([{ action: 'pii.read', access_purpose: `case:${caseId}`, actor_type: 'platform_staff' }]);
    // A case assigned to another moderator is not in the caller's queue.
    await api.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
      db.updateTable('admin.moderation_cases').set({ assigned_to: adminB.id }).where('id', '=', caseId).execute(),
    );
    expect((await a.get(`/v1/admin/users/${target.id}`, purpose('case', caseId))).status).toBe(404);
  });

  it('users_search finds by exactly one identifier and audits every result', async () => {
    const target = await api.fixtures.user();
    const caseId = await openCaseFor(api, { targetId: target.id });
    expect((await a.post('/v1/admin/users/search', { email: target.email, user_id: target.id }, purpose('case', caseId))).status).toBe(422);
    const res = await a.post('/v1/admin/users/search', { email: target.email.toUpperCase() }, purpose('case', caseId));
    expect(res.status, res.text).toBe(200);
    expect(res.body.items.map((u: Json) => u.id)).toEqual([target.id]);
    const none = await a.post('/v1/admin/users/search', { user_id: uuidv7() }, purpose('case', caseId));
    expect(none.body.items).toEqual([]);
  });
});

describe('four-eyes changes (SEC-ADM-6)', () => {
  it('a platform role grant applies only after a second admin approves; the requester cannot approve it', async () => {
    const target = await api.fixtures.user();
    const req = await a.post(`/v1/admin/users/${target.id}/platform-roles`, { role: 'platform_support', reason });
    expect(req.status, req.text).toBe(202);
    expect(req.body).toMatchObject({ op_id: 'admin.platform_role_grant', status: 'pending', reason });
    const change = req.body.change_id;
    // Still not applied: the target has no staff access.
    const targetApi = staffApi(admin, await admin.fixtures.token(target, { staff: true }));
    expect((await targetApi.get('/v1/admin/data-requests')).status).toBe(404);
    // A second request for the same change is refused; the requester cannot approve their own.
    expect((await a.post(`/v1/admin/users/${target.id}/platform-roles`, { role: 'platform_support', reason })).status).toBe(409);
    const self = await a.post(`/v1/admin/four-eyes/${change}/decision`, { decision: 'approve', reason });
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('SELF_APPROVAL_FORBIDDEN');
    // Never listed for the requester, listed for the second admin.
    expect((await a.get('/v1/admin/four-eyes?limit=100')).body.items.map((c: Json) => c.change_id)).not.toContain(change);
    expect((await b.get('/v1/admin/four-eyes?limit=100')).body.items.map((c: Json) => c.change_id)).toContain(change);
    const ok = await b.post(`/v1/admin/four-eyes/${change}/decision`, { decision: 'approve', reason: 'Second check done' });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body.status).toBe('approved');
    expect((await targetApi.get('/v1/admin/data-requests')).status).toBe(200);
    expect((await b.post(`/v1/admin/four-eyes/${change}/decision`, { decision: 'approve', reason })).status).toBe(409);
    // Revocation is immediate; DELETE carries its reason in CarPal-Reason (DI-09).
    expect((await a.del(`/v1/admin/users/${target.id}/platform-roles/platform_support`)).status).toBe(422);
    const revoke = await a.del(`/v1/admin/users/${target.id}/platform-roles/platform_support`, {
      'carpal-reason': 'Role no longer needed',
    });
    expect(revoke.status, revoke.text).toBe(200);
    expect((await staffApi(admin, await admin.fixtures.token(target, { staff: true })).get('/v1/admin/data-requests')).status).toBe(404);
  });

  it('a moderator decides moderation changes only; expired changes cannot be decided', async () => {
    const mod = await staff(admin, 'platform_moderator');
    const target = await api.fixtures.user();
    const req = await a.post(`/v1/admin/users/${target.id}/platform-roles`, { role: 'platform_moderator', reason });
    expect(mod.c && (await mod.c.post(`/v1/admin/four-eyes/${req.body.change_id}/decision`, { decision: 'approve', reason })).status).toBe(
      404,
    );
    await api.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
      db
        .updateTable('admin.pending_admin_changes')
        .set({ expires_at: new Date(Date.now() - 1000) })
        .where('id', '=', req.body.change_id)
        .execute(),
    );
    const late = await b.post(`/v1/admin/four-eyes/${req.body.change_id}/decision`, { decision: 'approve', reason });
    expect(late.status).toBe(409);
  });
});

describe('users and sessions', () => {
  it('suspension revokes every session at once and is a moderation action; staff cannot suspend themselves', async () => {
    const target = await api.fixtures.user();
    const token = await api.fixtures.token(target);
    expect((await api.request({ path: '/v1/me', token })).status).toBe(200);
    const res = await a.post(`/v1/admin/users/${target.id}/status`, { status: 'suspended', reason });
    expect(res.status, res.text).toBe(200);
    expect(res.body.status).toBe('suspended');
    expect((await api.request({ path: '/v1/me', token })).status).toBe(401);
    const events = await query<{ event_type: string }>(
      api,
      sql`SELECT event_type FROM core.domain_event_outbox WHERE payload ->> 'user_id' = ${target.id} AND event_type = 'moderation.action.taken'`,
    );
    expect(events.length).toBe(1);
    expect((await a.post(`/v1/admin/users/${adminA.id}/status`, { status: 'suspended', reason })).status).toBe(403);
    expect((await a.post(`/v1/admin/users/${target.id}/status`, { status: 'active', reason })).body.status).toBe('active');
  });

  it('sessions revoke and onboarding reset', async () => {
    const target = await api.fixtures.user();
    const token = await api.fixtures.token(target);
    expect((await support.post(`/v1/admin/users/${target.id}/sessions/revoke`, { reason })).status).toBe(200);
    expect((await api.request({ path: '/v1/me', token })).status).toBe(401);
    const saved = await api.request<Json>({
      method: 'PUT',
      path: '/v1/me/onboarding/individual',
      token: await api.fixtures.token(target),
      headers: { 'if-match': '"v1"' },
      body: { current_step: 'vehicle', completed_step: 'profile' },
    });
    expect(saved.status, saved.text).toBe(200);
    const reset = await support.post(`/v1/admin/users/${target.id}/onboarding/individual/reset`, { reason });
    expect(reset.status, reset.text).toBe(200);
    expect(reset.body).toMatchObject({ status: 'reset', completed_steps: [] });
  });
});

describe('data subject requests (MVP §14)', () => {
  it('export bundle: verify identity, build the CSV through W8, complete; the user downloads it', async () => {
    const user = await api.fixtures.user();
    const uc = client(api, await api.fixtures.token(user, { acr: 'aal2' }));
    const dsr = await uc.post('/v1/me/data-requests', { request_type: 'export' });
    expect(dsr.status, dsr.text).toBe(201);
    const id = dsr.body.id;
    const queue = await support.get('/v1/admin/data-requests?status=received&limit=100');
    expect(queue.body.items.find((d: Json) => d.id === id)).toMatchObject({ user_id: user.id });
    expect((await support.post(`/v1/admin/data-requests/${id}/export`, { reason }, purpose('dsr', id))).status).toBe(409);
    expect((await support.post(`/v1/admin/data-requests/${id}/status`, { status: 'completed', reason }, purpose('dsr', id))).status).toBe(
      409,
    );
    expect(
      (await support.post(`/v1/admin/data-requests/${id}/status`, { status: 'verifying_identity', reason }, purpose('dsr', id))).status,
    ).toBe(200);
    expect((await support.post(`/v1/admin/data-requests/${id}/status`, { status: 'in_progress', reason }, purpose('dsr', id))).status).toBe(
      200,
    );
    // Completing an export needs its bundle first.
    expect((await support.post(`/v1/admin/data-requests/${id}/status`, { status: 'completed', reason }, purpose('dsr', id))).status).toBe(
      409,
    );
    const job = await support.post(`/v1/admin/data-requests/${id}/export`, { reason }, purpose('dsr', id));
    expect(job.status, job.text).toBe(202);
    await api.infra.jobs.idle();
    const done = await support.post(`/v1/admin/data-requests/${id}/status`, { status: 'completed', reason }, purpose('dsr', id));
    expect(done.status, done.text).toBe(200);
    expect(done.body.export_available).toBe(true);
    const mine = await uc.get(`/v1/me/data-requests/${id}`);
    expect(mine.body.export_available).toBe(true);
  });

  it('deletion: four-eyes, then the worker erases; the pseudonym key is deleted so analytics events are unlinkable', async () => {
    const user = await api.fixtures.user();
    const token = await api.fixtures.token(user, { acr: 'aal2' });
    const uc = client(api, token);
    // The user produced analytics events (pseudonymized by W12).
    const ingest = await api.request<Json>({
      method: 'POST',
      path: '/v1/events',
      token,
      body: {
        platform: 'ios',
        app_version: '1.0.0',
        events: [
          { event_name: 'map.opened', schema_version: 1, occurred_at: new Date().toISOString(), properties: { entry_point: 'home' } },
        ],
      },
    });
    expect(ingest.status, ingest.text).toBe(202);
    await api.infra.jobs.idle();
    const keys = await query<{ n: string }>(
      api,
      sql`SELECT count(*) AS n FROM analytics.actor_pseudonyms WHERE user_id = ${user.id}::uuid`,
    );
    expect(Number(keys[0]!.n)).toBe(1);
    const dsr = await uc.post('/v1/me/data-requests', { request_type: 'deletion' });
    const id = dsr.body.id;
    for (const status of ['verifying_identity', 'in_progress'])
      expect((await support.post(`/v1/admin/data-requests/${id}/status`, { status, reason }, purpose('dsr', id))).status).toBe(200);
    // Support may not execute deletions (STF(ADM)); an admin files it, another admin approves.
    expect((await support.post(`/v1/admin/data-requests/${id}/execute-deletion`, { reason }, purpose('dsr', id))).status).toBe(404);
    const req = await a.post(`/v1/admin/data-requests/${id}/execute-deletion`, { reason }, purpose('dsr', id));
    expect(req.status, req.text).toBe(202);
    expect((await b.post(`/v1/admin/four-eyes/${req.body.change_id}/decision`, { decision: 'approve', reason })).status).toBe(200);
    await flush(api, worker);
    const account = await query<{ status: string; email: string; full_name: string; anonymized_at: Date | null }>(
      api,
      sql`SELECT status, email, full_name, anonymized_at FROM identity.user_accounts WHERE id = ${user.id}::uuid`,
    );
    expect(account[0]).toMatchObject({ status: 'deleted', full_name: 'Deleted user' });
    expect(account[0]!.email).not.toBe(user.email);
    expect(account[0]!.anonymized_at).not.toBeNull();
    expect(
      Number(
        (await query<{ n: string }>(api, sql`SELECT count(*) AS n FROM analytics.actor_pseudonyms WHERE user_id = ${user.id}::uuid`))[0]!.n,
      ),
    ).toBe(0);
    const dsrRow = await query<{ status: string }>(api, sql`SELECT status FROM identity.data_subject_requests WHERE id = ${id}::uuid`);
    expect(dsrRow[0]!.status).toBe('completed');
    const events = await query<{ event_type: string }>(
      api,
      sql`SELECT event_type FROM core.domain_event_outbox WHERE aggregate_id = ${user.id}::uuid AND event_type = 'user.deletion.completed'`,
    );
    expect(events.length).toBe(1);
    expect((await api.request({ path: '/v1/me', token })).status).toBe(401);
  });
});

describe('feature flags, retention, audit', () => {
  it('flag changes need If-Match; turning the kill switch on is immediate, off again needs a second admin', async () => {
    const list = await a.get('/v1/admin/flags?flag_type=kill_switch&limit=100');
    const kill = list.body.items.find((f: Json) => f.key === 'ai.automation.kill_switch');
    expect(kill).toBeDefined();
    expect((await a.patch('/v1/admin/flags/ai.automation.kill_switch', { enabled: true, reason }, 999)).status).toBe(412);
    const on = await a.patch('/v1/admin/flags/ai.automation.kill_switch', { enabled: true, reason }, kill.version);
    expect(on.status, on.text).toBe(200);
    expect(on.body.enabled).toBe(true);
    expect(on.headers.etag).toBe(`"v${kill.version + 1}"`);
    // This process's cache drops at once: AI features are off.
    expect(await admin.app.get(FlagService).isEnabled('ai.triage.enabled')).toBe(false);
    const off = await a.patch('/v1/admin/flags/ai.automation.kill_switch', { enabled: false, reason }, on.body.version);
    expect(off.status).toBe(202);
    expect(off.body).toMatchObject({ op_id: 'admin.flag_update', status: 'pending' });
    const approved = await b.post(`/v1/admin/four-eyes/${off.body.change_id}/decision`, { decision: 'approve', reason });
    expect(approved.status, approved.text).toBe(200);
    const after = (await a.get('/v1/admin/flags?flag_type=kill_switch&limit=100')).body.items.find(
      (f: Json) => f.key === 'ai.automation.kill_switch',
    );
    expect(after.enabled).toBe(false);
  });

  it('retention changes wait for a second admin; the daily run applies active policies', async () => {
    const list = await a.get('/v1/admin/retention-policies?limit=100');
    const p = list.body.items.find((r: Json) => r.entity_type === 'MatchSession');
    const req = await a.put(`/v1/admin/retention-policies/${p.id}`, {
      entity_type: 'MatchSession',
      applies_to_status: null,
      retention_days: 200,
      action: 'anonymize',
      legal_basis: 'Search analytics',
      status: 'active',
      reason,
    });
    expect(req.status, req.text).toBe(202);
    await b.post(`/v1/admin/four-eyes/${req.body.change_id}/decision`, { decision: 'approve', reason });
    const after = (await a.get('/v1/admin/retention-policies?limit=100')).body.items.find((r: Json) => r.id === p.id);
    expect(after.retention_days).toBe(200);
  });

  it('audit search reads the log within 93 days and is audited itself', async () => {
    const from = new Date(Date.now() - 3_600_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    expect((await a.post('/v1/admin/audit-logs/search', { from, to: new Date(Date.now() + 100 * 86_400_000).toISOString() })).status).toBe(
      422,
    );
    const res = await a.post('/v1/admin/audit-logs/search', { from, to, actor_id: adminA.id, limit: 50 });
    expect(res.status, res.text).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items[0]).toMatchObject({ actor_type: 'platform_staff' });
    const own = await query<{ n: string }>(
      api,
      sql`SELECT count(*) AS n FROM analytics.audit_logs WHERE actor_id = ${adminA.id}::uuid AND action = 'audit.searched'`,
    );
    expect(Number(own[0]!.n)).toBeGreaterThan(0);
  });
});

describe('product analytics (events.ingest → W12 → dashboards)', () => {
  it('accepts registered events only, writes them pseudonymously, aggregates daily and serves dashboards', async () => {
    const user = await api.fixtures.user();
    const token = await api.fixtures.token(user);
    const now = new Date().toISOString();
    const res = await api.request<Json>({
      method: 'POST',
      path: '/v1/events',
      token,
      body: {
        platform: 'web_pwa',
        app_version: '1.2.0',
        events: [
          { event_name: 'map.directions_tapped', schema_version: 1, occurred_at: now, properties: { navigation_app_key: 'google_maps' } },
          { event_name: 'map.pin_selected', schema_version: 1, occurred_at: now, properties: { target_type: 'organization', rank: 2 } },
          { event_name: 'unknown.event', schema_version: 1, occurred_at: now },
          { event_name: 'map.pin_selected', schema_version: 1, occurred_at: now, properties: { email: 'x@y.z' } },
        ],
      },
    });
    expect(res.status, res.text).toBe(202);
    expect(res.body).toEqual({ accepted: 2, rejected: 2 });
    await api.infra.jobs.idle();
    const reader = worker.get(AnalyticsPools).reader.db;
    const rows = await reader
      .selectFrom('events.analytics_events')
      .select(['event_name', 'actor_pseudonymous_id', 'platform', 'properties'])
      .where('event_name', '=', 'map.directions_tapped')
      .where('app_version', '=', '1.2.0')
      .orderBy('received_at', 'desc')
      .limit(1)
      .execute();
    expect(rows[0]!.actor_pseudonymous_id).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.actor_pseudonymous_id).not.toContain(user.id.replace(/-/g, ''));
    expect(rows[0]!.properties).toEqual({ navigation_app_key: 'google_maps' });
    // Anonymous ingest is accepted too (PUB), without an actor.
    const anon = await api.request<Json>({
      method: 'POST',
      path: '/v1/events',
      token: await api.fixtures.anonymousToken(),
      body: {
        platform: 'android',
        app_version: '1.0.0',
        events: [{ event_name: 'app.opened', schema_version: 1, occurred_at: now, properties: { cold_start: true } }],
      },
    });
    expect(anon.body).toEqual({ accepted: 1, rejected: 0 });
    await api.infra.jobs.idle();
    await worker.get(DailyMetricsRule).run();
    const day = now.slice(0, 10);
    const dash = await support.get(`/v1/admin/analytics/search_and_map?from=${day}&to=${day}`);
    expect(dash.status, dash.text).toBe(200);
    const taps = dash.body.metrics.find((m: Json) => m.metric_key === 'events.map.directions_tapped');
    expect(Number(taps.value)).toBeGreaterThanOrEqual(1);
    expect(taps.series[0]).toMatchObject({ date: day });
    const growth = await support.get(`/v1/admin/analytics/growth?from=${day}&to=${day}`);
    expect(Number(growth.body.metrics.find((m: Json) => m.metric_key === 'gauge.users_active').value)).toBeGreaterThan(0);
  });
});

describe('billing administration', () => {
  it('assigns a plan with overrides, closes the change request; plan entitlement changes need a second admin', async () => {
    const { org, token } = await api.fixtures.memberOf('fleet', 'fleet_owner');
    const owner = client(api, token);
    expect((await owner.post(`/v1/orgs/${org.id}/subscription/change-requests`, { plan_key: 'fleet_50' })).status).toBe(202);
    const assigned = await a.post('/v1/admin/subscriptions', {
      subscriber: { type: 'organization', id: org.id },
      plan_key: 'fleet_50',
      status: 'trial',
      trial_ends_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
      vehicle_limit_override: 60,
      reason,
    });
    expect(assigned.status, assigned.text).toBe(200);
    expect(assigned.body).toMatchObject({ status: 'trial', plan: { plan_key: 'fleet_50' } });
    expect(assigned.body.effective_entitlements.find((e: Json) => e.key === 'max_vehicles').value).toBe(60);
    // A user cannot get an organization plan.
    const user = await api.fixtures.user();
    expect(
      (
        await a.post('/v1/admin/subscriptions', {
          subscriber: { type: 'user', id: user.id },
          plan_key: 'fleet_50',
          status: 'active',
          reason,
        })
      ).status,
    ).toBe(422);
    const cr = await query<{ status: string }>(
      api,
      sql`SELECT status FROM billing.subscription_change_requests WHERE organization_id = ${org.id}::uuid`,
    );
    expect(cr.map((r) => r.status)).toEqual(['assigned']);
    const plans = await a.get('/v1/admin/plans');
    const plan = plans.body.items.find((p: Json) => p.plan_key === 'vendor_pro');
    const upd = await a.patch(`/v1/admin/plans/${plan.id}`, { entitlements: [{ key: 'max_inventory_items', value: 6000 }], reason }, 1);
    expect(upd.status, upd.text).toBe(202);
    await b.post(`/v1/admin/four-eyes/${upd.body.change_id}/decision`, { decision: 'approve', reason });
    const after = (await a.get('/v1/admin/plans')).body.items.find((p: Json) => p.plan_key === 'vendor_pro');
    expect(after.entitlements.find((e: Json) => e.key === 'max_inventory_items').value).toBe(6000);
    // Restore the seeded value for other tests.
    const back = await a.patch(
      `/v1/admin/plans/${plan.id}`,
      { entitlements: plan.entitlements.filter((e: Json) => e.key === 'max_inventory_items'), reason },
      1,
    );
    await b.post(`/v1/admin/four-eyes/${back.body.change_id}/decision`, { decision: 'approve', reason });
  });
});

describe('taxonomy administration', () => {
  it('creates and edits nodes, synonyms and mappings; a merge re-points references in a job after approval', async () => {
    const symptom = (
      await query<{ id: string }>(
        api,
        sql`SELECT id FROM taxonomy.taxonomy_nodes WHERE type = 'symptom' AND status = 'active' ORDER BY id LIMIT 1`,
      )
    )[0]!.id;
    const slug = `test-system-${uuidv7().slice(-8)}`;
    const created = await a.post('/v1/admin/taxonomy/nodes', {
      type: 'service_system',
      name_translations: { en: 'Test system', fa: 'سامانه آزمایشی' },
      slug,
      reason,
    });
    expect(created.status, created.text).toBe(201);
    expect(created.body.version).toBe(1);
    expect(
      (await a.post('/v1/admin/taxonomy/nodes', { type: 'service_system', name_translations: { en: 'Again', fa: 'دوباره' }, slug, reason }))
        .status,
    ).toBe(409);
    expect(
      (
        await a.post('/v1/admin/taxonomy/nodes', {
          type: 'model',
          name_translations: { en: 'Orphan', fa: 'یتیم' },
          slug: `orphan-${slug}`,
          reason,
        })
      ).status,
    ).toBe(422);
    const upd = await a.patch(`/v1/admin/taxonomy/nodes/${created.body.id}`, { sort_order: 7, reason }, created.body.version);
    expect(upd.status, upd.text).toBe(200);
    expect(upd.body.sort_order).toBe(7);
    // The public catalog sees the change at once in this process.
    const syn = await a.post(`/v1/admin/taxonomy/nodes/${created.body.id}/synonyms`, {
      term: 'tst sys',
      locale: 'en',
      synonym_type: 'abbreviation',
      reason,
    });
    expect(syn.status, syn.text).toBe(201);
    expect(
      (
        await a.post(`/v1/admin/taxonomy/nodes/${created.body.id}/synonyms`, {
          term: 'tst sys',
          locale: 'en',
          synonym_type: 'abbreviation',
          reason,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await a.post(`/v1/admin/taxonomy/nodes/${created.body.id}/synonyms`, {
          term: 'tst',
          locale: 'fa',
          synonym_type: 'transliteration',
          reason,
        })
      ).status,
    ).toBe(422);
    const synList = await a.get(`/v1/admin/taxonomy/nodes/${created.body.id}/synonyms`);
    expect(synList.body.items.map((s: Json) => s.term)).toEqual(['tst sys']);
    const del = await a.del(`/v1/admin/taxonomy/synonyms/${syn.body.id}`, { 'carpal-reason': 'Duplicate of an alias' });
    expect(del.status, del.text).toBe(200);
    const map = await a.put('/v1/admin/taxonomy/mappings', {
      source_node_id: symptom,
      target_node_id: created.body.id,
      mapping_type: 'symptom_to_system',
      weight: 40,
      reason,
    });
    expect(map.status, map.text).toBe(200);
    const wrong = await a.put('/v1/admin/taxonomy/mappings', {
      source_node_id: created.body.id,
      target_node_id: symptom,
      mapping_type: 'symptom_to_system',
      weight: 40,
      reason,
    });
    expect(wrong.status).toBe(422);
    // Merge into another new system: four-eyes, then the job re-points and the node becomes merged.
    const into = await a.post('/v1/admin/taxonomy/nodes', {
      type: 'service_system',
      name_translations: { en: 'Survivor', fa: 'بازمانده' },
      slug: `survivor-${slug}`,
      reason,
    });
    const merge = await a.post(`/v1/admin/taxonomy/nodes/${created.body.id}/merge`, { into_node_id: into.body.id, reason });
    expect(merge.status, merge.text).toBe(202);
    await b.post(`/v1/admin/four-eyes/${merge.body.change_id}/decision`, { decision: 'approve', reason });
    await api.infra.jobs.idle();
    const node = await query<{ status: string; merged_into_id: string }>(
      api,
      sql`SELECT status, merged_into_id FROM taxonomy.taxonomy_nodes WHERE id = ${created.body.id}::uuid`,
    );
    expect(node[0]).toEqual({ status: 'merged', merged_into_id: into.body.id });
    const moved = await query<{ target_node_id: string }>(
      api,
      sql`SELECT target_node_id FROM taxonomy.taxonomy_mappings WHERE id = ${map.body.id}::uuid`,
    );
    expect(moved[0]!.target_node_id).toBe(into.body.id);
    const ev = await query<{ event_type: string }>(
      api,
      sql`SELECT event_type FROM core.domain_event_outbox WHERE aggregate_id = ${created.body.id}::uuid AND event_type = 'taxonomy.node.merged'`,
    );
    expect(ev.length).toBe(1);
    // The shared test database keeps seeded taxonomy counts (baseline and snapshot tests): remove what this test created.
    const ids = [created.body.id, into.body.id];
    await api.fixtures.worker.run({ actorType: 'system' }, async ({ db }) => {
      await db
        .deleteFrom('taxonomy.taxonomy_mappings')
        .where((eb) => eb.or([eb('source_node_id', 'in', ids), eb('target_node_id', 'in', ids)]))
        .execute();
      await db.deleteFrom('taxonomy.taxonomy_synonyms').where('taxonomy_node_id', 'in', ids).execute();
      await db.updateTable('taxonomy.taxonomy_nodes').set({ merged_into_id: null, status: 'inactive' }).where('id', 'in', ids).execute();
      await db.deleteFrom('taxonomy.taxonomy_nodes').where('id', 'in', ids).execute();
    });
    api.app.get(TaxonomyResolver).invalidate();
  });
});

describe('AI oversight and assisted onboarding', () => {
  it('MCP clients: suspension is immediate, scope changes wait for a second admin; access-log searches are audited', async () => {
    // A client of its own (the seeded ones are shared by every run of the shared test database, GD-13).
    const id = uuidv7();
    await api.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
      db
        .insertInto('ai_mcp.mcp_clients')
        .values({
          id,
          name: `test_client_${id.slice(-8)}`,
          client_type: 'internal_assistant',
          allowed_scopes: ['read:a', 'read:b'],
          allowed_resources: ['res:a'],
          allowed_tools: ['tool:a@1'],
          rate_limit_policy: 'default',
          environment: 'dev',
        })
        .execute(),
    );
    // Pages through the registry (the shared test database keeps every run's clients).
    const findClient = async (clientId: string): Promise<Json> => {
      let page = await a.get('/v1/admin/mcp/clients?limit=100');
      expect(page.status, page.text).toBe(200);
      for (;;) {
        const hit = page.body.items.find((x: Json) => x.id === clientId);
        if (hit || !page.body.next_cursor) return hit;
        page = await a.get(`/v1/admin/mcp/clients?limit=100&cursor=${encodeURIComponent(page.body.next_cursor)}`);
      }
    };
    const c = await findClient(id);
    const sus = await a.patch(`/v1/admin/mcp/clients/${c.id}`, { status: 'suspended', reason }, c.version);
    expect(sus.status, sus.text).toBe(200);
    expect(sus.body.status).toBe('suspended');
    const scopes = await a.patch(
      `/v1/admin/mcp/clients/${c.id}`,
      { allowed_scopes: c.allowed_scopes.slice(0, 1), reason },
      sus.body.version,
    );
    expect(scopes.status).toBe(202);
    // One pending change per client: reactivation waits until the scope change is decided.
    expect((await a.patch(`/v1/admin/mcp/clients/${c.id}`, { status: 'active', reason }, sus.body.version)).status).toBe(409);
    expect((await b.post(`/v1/admin/four-eyes/${scopes.body.change_id}/decision`, { decision: 'approve', reason })).status).toBe(200);
    const current = await findClient(c.id);
    expect(current.allowed_scopes).toEqual(c.allowed_scopes.slice(0, 1));
    const react = await a.patch(
      `/v1/admin/mcp/clients/${c.id}`,
      { status: 'active', allowed_scopes: c.allowed_scopes, reason },
      current.version,
    );
    expect(react.status).toBe(202);
    await b.post(`/v1/admin/four-eyes/${react.body.change_id}/decision`, { decision: 'approve', reason });
    const restored = await findClient(c.id);
    expect(restored).toMatchObject({ status: 'active', allowed_scopes: c.allowed_scopes });
    const from = new Date(Date.now() - 86_400_000).toISOString();
    const logs = await a.post('/v1/admin/mcp/access-logs/search', { from, to: new Date().toISOString() });
    expect(logs.status, logs.text).toBe(200);
    const insights = await a.post('/v1/admin/ai/insights/search', { from, to: new Date().toISOString() });
    expect(insights.status, insights.text).toBe(200);
    // The baseline test counts the seeded clients: remove this test's client.
    await api.fixtures.worker.run({ actorType: 'system' }, ({ db }) => db.deleteFrom('ai_mcp.mcp_clients').where('id', '=', id).execute());
  });

  it('assist sessions: one active per organization, ended with a reason', async () => {
    const org = await api.fixtures.org('provider');
    const start = await support.post(`/v1/admin/orgs/${org.id}/assist-sessions`, { flow_type: 'provider', reason });
    expect(start.status, start.text).toBe(201);
    expect(Date.parse(start.body.expires_at) - Date.now()).toBeLessThanOrEqual(4 * 3_600_000 + 5000);
    expect((await support.post(`/v1/admin/orgs/${org.id}/assist-sessions`, { flow_type: 'provider', reason })).status).toBe(409);
    expect((await support.post(`/v1/admin/orgs/${org.id}/assist-sessions`, { flow_type: 'fleet', reason })).status).toBe(422);
    expect((await support.post(`/v1/admin/assist-sessions/${start.body.assist_session_id}/end`, { reason })).status).toBe(200);
    expect((await support.post(`/v1/admin/assist-sessions/${start.body.assist_session_id}/end`, { reason })).status).toBe(409);
  });
});
