// S9a AI facade (40 §21; 53; SEC-AI-1..7): Help Me triage with safety first
// (the safety block survives AI being off), completion into an issue, a
// match session and an appointment draft whose pre-visit report carries the
// AI summary; asynchronous feature requests run by W9 through the gateway
// with the MCP access log written by W13; suggestions applied through the
// owning module; approval requests never decided by their requester; the
// kill switch turns every AI operation into 503 while search, profiles and
// appointments keep working; AI context never crosses tenants; DSR and
// retention cover the AI records.
import type { INestApplicationContext } from '@nestjs/common';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FlagService, type FlagContext } from '#libs/flags/index.js';
import { SafetyLexicon } from '#libs/safety-check/index.js';
import { TxRunner } from '#libs/tenancy/index.js';
import { RetentionHandlers } from '#modules/admin/interface/admin.js';
import { SkillHeatmapBuilder } from '#modules/ai-mcp/ai-mcp.module.js';
import { PersonalDataRegistry } from '#modules/identity/interface/identity.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { taxonomyNodes, type Json, type Nodes } from './s4-support.js';
import { client, newId } from './s5-support.js';
import { flush, publishedProvider, publishedVendor, uniquePoint, type PublishedOrg } from './s6-support.js';
import { customer, requestBody } from './s7-support.js';
import { query } from './s8-support.js';
import { createTestApp, createTestWorker, type TestApp } from './test-app.js';

let app: TestApp;
let worker: INestApplicationContext;
let n: Nodes;
let provider: PublishedOrg;
let criticalText: string;

const area = (p: { lat: number; lng: number }, span = 0.05) => ({
  mode: 'map_center',
  viewport: { center: p, zoom: 13, bbox: { south: p.lat - span, west: p.lng - span, north: p.lat + span, east: p.lng + span } },
});

/** Every AI feature flag reads as off: the kill switch (SEC-AI-6). */
const killSwitch = {
  provide: FlagService,
  useFactory: (tx: TxRunner) =>
    new (class extends FlagService {
      override async isEnabled(key: string, ctx?: FlagContext): Promise<boolean> {
        if ((await this.type(key)) === 'ai_feature' || key.startsWith('ai.')) return false;
        return super.isEnabled(key, ctx);
      }
    })(tx, 'dev', 0),
  inject: [TxRunner],
};

/** Waits for the queued jobs and relays the events (W9 jobs, W13 access log, W5, W10, W11). */
async function settle(): Promise<void> {
  await app.infra.jobs.idle();
  await flush(app, worker);
  await app.infra.jobs.idle();
}

/** An organization consent as org.consents_grant stores it (that operation needs an AAL2 owner session). */
async function grantOrgConsent(orgId: string, type: string): Promise<void> {
  await app.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
    db
      .insertInto('identity.consent_records')
      .values({
        subject_type: 'organization',
        subject_id: orgId,
        consent_type: type,
        policy_version: '2026-10',
        granted: true,
        granted_at: new Date(),
        source: 'api',
      })
      .execute(),
  );
}

async function job(c: ReturnType<typeof client>, id: string): Promise<Json> {
  return (await c.get(`/v1/jobs/${id}`)).body;
}

beforeAll(async () => {
  app = await createTestApp({ host: 'api' });
  worker = await createTestWorker({ infra: app.infra });
  n = await taxonomyNodes(app);
  provider = await publishedProvider(app, n, { name: `S9 Help Me Garage ${newId().slice(-6)}`, point: uniquePoint() });
  const terms = await app.app.get(SafetyLexicon, { strict: false }).terms();
  const critical = terms.find((t) => t.urgency === 'safety_critical')!;
  criticalText = (await app.app.get(TaxonomyResolver, { strict: false }).get(critical.nodeId))!.nameTranslations.en!;
}, 120_000);

afterAll(async () => {
  await worker?.close();
  await app?.close();
});

describe('Help Me triage (40 §21.2)', () => {
  it('runs start → reply → get → complete into an issue, a match session and a draft with the AI summary', async () => {
    const cu = await customer(app, n);
    const start = await cu.c.post('/v1/me/triage-sessions', {
      vehicle_id: cu.vehicleId,
      text: 'There is a grinding noise from the front wheels.',
      locale: 'en',
    });
    expect(start.status, start.text).toBe(201);
    expect(start.headers.location).toBe(`/v1/me/triage-sessions/${start.body.id}`);
    expect(start.body).toMatchObject({ vehicle_id: cu.vehicleId, status: 'in_progress', locale: 'en', result_insight_id: null });
    expect(start.body.turns.map((t: Json) => t.role)).toEqual(['user', 'assistant']);
    expect(start.body.safety).toMatchObject({ flag: false, level: 'none', do_not_drive: false });
    const id = start.body.id as string;

    const reply = await cu.c.post(`/v1/me/triage-sessions/${id}/turns`, { text: 'It happens when braking at low speed.' });
    expect(reply.status, reply.text).toBe(200);
    expect(reply.body.turns).toHaveLength(4);
    expect((await cu.c.get(`/v1/me/triage-sessions/${id}`)).body.turns).toHaveLength(4);

    // Another user never sees the session (404, not 403).
    const other = await customer(app, n);
    expect((await other.c.get(`/v1/me/triage-sessions/${id}`)).status).toBe(404);
    expect((await other.c.post(`/v1/me/triage-sessions/${id}/turns`, { text: 'hello there' })).status).toBe(404);

    const done = await cu.c.post(`/v1/me/triage-sessions/${id}/complete`, {
      create_issue: true,
      find_providers: true,
      location: area(provider.point),
      draft_appointment_with: provider.id,
    });
    expect(done.status, done.text).toBe(200);
    expect(done.body.status).toBe('completed');
    expect(done.body.issue_id).toEqual(expect.any(String));
    expect(done.body.match_session_id).toEqual(expect.any(String));
    expect(done.body.appointment_draft_id).toEqual(expect.any(String));
    expect(done.body.result_insight_id).toEqual(expect.any(String));
    expect(done.body.next_question).toBeNull();

    // The issue comes from the triage (source ai_triage) and references the AI insight, never stores AI text.
    const [issue] = await query<{ source: string; triage_session_id: string; ai_triage_insight_id: string; description: string }>(
      app,
      sql`SELECT source, triage_session_id, ai_triage_insight_id, description FROM vehicle.vehicle_issues WHERE id = ${done.body.issue_id}::uuid`,
    );
    expect(issue).toMatchObject({ source: 'ai_triage', triage_session_id: id, ai_triage_insight_id: done.body.result_insight_id });
    expect(issue!.description).toContain('grinding noise');
    const issueEvents = await query<{ event_type: string }>(
      app,
      sql`SELECT event_type FROM core.domain_event_outbox WHERE aggregate_id = ${done.body.issue_id}::uuid`,
    );
    expect(issueEvents.map((e) => e.event_type)).toContain('vehicle.issue.reported');

    // The match session is a Help Me session; the draft is not sent and its preview shows the AI summary.
    const [session] = await query<{ source: string; entry_point: string; triage_session_id: string }>(
      app,
      sql`SELECT source, entry_point, triage_session_id FROM discovery.match_sessions WHERE id = ${done.body.match_session_id}::uuid`,
    );
    expect(session).toEqual({ source: 'ai_triage', entry_point: 'help_me', triage_session_id: id });
    const draft = await cu.c.get(`/v1/me/appointments/${done.body.appointment_draft_id}`);
    expect(draft.body).toMatchObject({
      status: 'draft',
      triage_session_id: id,
      triage_status: 'provided',
      related_issue_id: done.body.issue_id,
    });
    const report = await cu.c.get(`/v1/me/appointments/${done.body.appointment_draft_id}/pre-visit-report`);
    expect(report.status, report.text).toBe(200);
    expect(report.body.ai_summary).toEqual(expect.any(String));
    expect(report.body.ai_summary_status).toBe('pending');

    // The insight is the user's own (owner_only, pending until the user's submit approves it).
    const insight = await cu.c.get(`/v1/insights/${done.body.result_insight_id}`);
    expect(insight.status, insight.text).toBe(200);
    expect(insight.body).toMatchObject({
      insight_type: 'triage_summary',
      visibility: 'owner_only',
      subject: { type: 'triage_session', id },
    });
    expect((await other.c.get(`/v1/insights/${done.body.result_insight_id}`)).status).toBe(404);

    // A closed session takes no more turns.
    const closed = await cu.c.post(`/v1/me/triage-sessions/${id}/turns`, { text: 'one more thing' });
    expect(closed.status).toBe(409);
    expect(closed.body.code).toBe('INVALID_TRANSITION');

    // Every tool call reached the MCP access log through W13.
    await settle();
    const logs = await query<{ resource_or_tool_key: string; policy_decision: string; principal_id: string }>(
      app,
      sql`SELECT resource_or_tool_key, policy_decision, principal_id FROM ai_mcp.mcp_access_logs WHERE principal_id = ${cu.user.id}::uuid ORDER BY created_at`,
    );
    expect(logs.map((l) => l.resource_or_tool_key)).toEqual([
      'tool:triage.classify_symptom',
      'tool:triage.classify_symptom',
      'tool:triage.create_summary',
    ]);
    expect(logs.every((l) => l.policy_decision === 'allowed')).toBe(true);
  });

  it('a safety-critical symptom escalates the session and an appointment can cite only a completed own session', async () => {
    const cu = await customer(app, n);
    const res = await cu.c.post('/v1/me/triage-sessions', {
      vehicle_id: cu.vehicleId,
      text: `Since this morning: ${criticalText}`,
      locale: 'en',
    });
    expect(res.status, res.text).toBe(201);
    expect(res.body.status).toBe('escalated_safety');
    expect(res.body.urgency_level).toBe('safety_critical');
    expect(res.body.safety).toEqual({
      flag: true,
      level: 'urgent',
      message_i18n_key: 'safety.banner.urgent',
      urgent_help_available: true,
      do_not_drive: true,
    });
    // Not completed yet: appointments.create refuses the reference.
    const early = await cu.c.post('/v1/me/appointments', requestBody(provider, cu, n, { triage_session_id: res.body.id, submit: false }));
    expect(early.status).toBe(422);
    expect(early.body.errors[0].pointer).toBe('/triage_session_id');
    // Someone else's vehicle is not a reference.
    const other = await customer(app, n);
    const bad = await other.c.post('/v1/me/triage-sessions', { vehicle_id: cu.vehicleId, text: 'noise from the engine bay', locale: 'en' });
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0].pointer).toBe('/vehicle_id');
  });
});

describe('graceful degradation (SEC-AI-6, 53 §16.2)', () => {
  it('with the kill switch on, AI operations answer 503 (triage with the safety block) while search, profiles and appointments work', async () => {
    const off = await createTestApp({ host: 'api', infra: app.infra, providers: [killSwitch] });
    try {
      const cu = await customer(off, n);
      const res = await off.request<Json>({
        method: 'POST',
        path: '/v1/me/triage-sessions',
        token: cu.token,
        headers: { 'idempotency-key': newId() },
        body: { vehicle_id: cu.vehicleId, text: `Help: ${criticalText}`, locale: 'en' },
      });
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({
        code: 'AI_UNAVAILABLE',
        fallback_path: '/v1/search',
        safety: { flag: true, level: 'urgent', urgent_help_available: true, do_not_drive: true },
      });
      expect(res.headers['carpal-retry-after-ms']).toBeDefined();
      const c = client(off, cu.token);
      const suggestions = await c.post(`/v1/me/vehicles/${cu.vehicleId}/ai/suggestions`, { kinds: ['vehicle_summary'] });
      expect(suggestions.status).toBe(503);
      expect(suggestions.body.code).toBe('AI_UNAVAILABLE');
      // The non-AI paths keep working.
      const search = await c.post('/v1/search', { search_mode: 'providers', entry_point: 'search_box', location: area(provider.point) });
      expect(search.status, search.text).toBe(200);
      const appt = await c.post('/v1/me/appointments', requestBody(provider, cu, n));
      expect(appt.status, appt.text).toBe(201);
    } finally {
      await off.close();
    }
  });

  it('with the model unavailable, triage answers 503 with the safety block and a session still completes without AI', async () => {
    const down = await createTestApp({ host: 'api', infra: app.infra, env: { CARPAL_MCP_MODE: 'unavailable' } });
    try {
      const cu = await customer(down, n);
      const c = client(down, cu.token);
      const res = await c.post('/v1/me/triage-sessions', { vehicle_id: cu.vehicleId, text: 'my car makes a strange noise', locale: 'en' });
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ code: 'AI_UNAVAILABLE', safety: { flag: false, level: 'none', do_not_drive: false } });
      // A session started while AI worked completes without the summary when the model is gone.
      const started = await client(app, cu.token).post('/v1/me/triage-sessions', {
        vehicle_id: cu.vehicleId,
        text: 'my car makes a strange noise',
        locale: 'en',
      });
      expect(started.status, started.text).toBe(201);
      const done = await c.post(`/v1/me/triage-sessions/${started.body.id}/complete`, { create_issue: true, find_providers: false });
      expect(done.status, done.text).toBe(200);
      expect(done.body).toMatchObject({ status: 'completed', result_insight_id: null });
      expect(done.body.issue_id).toEqual(expect.any(String));
    } finally {
      await down.close();
    }
  });
});

describe('feature requests and suggestions (40 §21.3, §21.4)', () => {
  it('vehicle suggestions run in W9; accepted reminders are created by the vehicle module, decisions are final', async () => {
    const cu = await customer(app, n);
    const res = await cu.c.post(`/v1/me/vehicles/${cu.vehicleId}/ai/suggestions`, { kinds: ['maintenance_suggestion', 'vehicle_summary'] });
    expect(res.status, res.text).toBe(202);
    expect(res.body).toMatchObject({ kind: 'ai_insight', status: 'queued' });
    await settle();
    const j = await job(cu.c, res.body.id);
    expect(j).toMatchObject({ status: 'succeeded', result: { type: 'ai_insight' } });
    const insight = await cu.c.get(`/v1/insights/${j.result.id}`);
    expect(insight.body).toMatchObject({
      insight_type: 'maintenance_suggestion',
      visibility: 'owner_only',
      human_approval_status: 'not_required',
    });

    const mine = await cu.c.get('/v1/me/ai/suggestions');
    expect(mine.status).toBe(200);
    const pending = (mine.body.items as Json[]).filter((s) => s.insight_id === j.result.id);
    expect(pending.length).toBeGreaterThanOrEqual(2);
    expect(pending[0]).toMatchObject({
      status: 'pending',
      suggested_action: 'add',
      target: { type: 'maintenance_reminder', id: cu.vehicleId },
    });

    const accepted = await cu.c.post(`/v1/ai/suggestions/${pending[0]!.id}/decision`, { decision: 'accept' });
    expect(accepted.status, accepted.text).toBe(200);
    expect(accepted.body.status).toBe('accepted');
    const reminders = await query<{ source: string; insight_id: string }>(
      app,
      sql`SELECT source, insight_id FROM vehicle.maintenance_reminders WHERE vehicle_id = ${cu.vehicleId}::uuid`,
    );
    expect(reminders).toEqual([{ source: 'ai_suggestion', insight_id: j.result.id }]);
    // Edits are validated by the owning module's rules (a due date in the past is refused).
    const edited = await cu.c.post(`/v1/ai/suggestions/${pending[1]!.id}/decision`, {
      decision: 'accept_with_edits',
      edited_payload: { ...pending[1]!.proposed_payload, due_by_date: '2020-01-01' },
    });
    expect(edited.status).toBe(422);
    expect(edited.body.errors[0].pointer).toBe('/edited_payload/due_by_date');
    expect((await cu.c.post(`/v1/ai/suggestions/${pending[1]!.id}/decision`, { decision: 'reject' })).body.status).toBe('rejected');
    const again = await cu.c.post(`/v1/ai/suggestions/${pending[1]!.id}/decision`, { decision: 'accept' });
    expect(again.status).toBe(409);
    // Another user cannot see or decide them.
    const other = await customer(app, n);
    expect((await other.c.post(`/v1/ai/suggestions/${pending[0]!.id}/decision`, { decision: 'reject' })).status).toBe(404);
    expect((await other.c.get(`/v1/insights/${j.result.id}`)).status).toBe(404);
    // Feedback for the evaluation layer.
    expect((await cu.c.post(`/v1/insights/${j.result.id}/feedback`, { feedback_type: 'rating' })).status).toBe(422);
    expect((await cu.c.post(`/v1/insights/${j.result.id}/feedback`, { feedback_type: 'rating', rating: 4 })).status).toBe(201);
    const audits = await query<{ action: string }>(
      app,
      sql`SELECT action FROM analytics.audit_logs WHERE entity_id = ${pending[0]!.id}::uuid`,
    );
    expect(audits.map((a) => a.action)).toContain('ai.suggestion_decided');
  });

  it('the provider profile helper needs the analytics consent; its capability suggestions wait for the provider', async () => {
    const p = await publishedProvider(app, n, { name: `S9 Profile Helper ${newId().slice(-6)}`, point: uniquePoint() });
    const path = `/v1/orgs/${p.id}/provider/ai/profile-helper`;
    const refused = await p.c.post(path);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'CONSENT_REQUIRED', consent_type: 'provider_analytics_ai_use' });
    await grantOrgConsent(p.id, 'provider_analytics_ai_use');
    // A job log is the evidence the helper reads (the organization's own data only).
    const log = await p.c.post(`/v1/orgs/${p.id}/provider/job-logs`, {
      job_date: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
      service_system_node_id: n.system,
      service_task_node_id: n.task,
      brand_node_id: n.brand,
    });
    expect(log.status, log.text).toBe(201);
    const res = await p.c.post(path);
    expect(res.status, res.text).toBe(202);
    await settle();
    const j = await job(p.c, res.body.id);
    expect(j.status, JSON.stringify(j)).toBe('succeeded');
    const caps = await query<{ id: string; source: string; status: string; ai_insight_id: string }>(
      app,
      sql`SELECT id, source, status, ai_insight_id FROM organization.provider_capabilities
           WHERE provider_organization_id = ${p.id}::uuid AND source = 'ai_suggested'`,
    );
    expect(caps.length).toBeGreaterThan(0);
    expect(caps.every((c) => c.status === 'pending_provider_approval' && c.ai_insight_id === j.result.id)).toBe(true);
    const insight = await p.c.get(`/v1/insights/${j.result.id}`);
    expect(insight.body.evidence_references.length).toBeGreaterThan(0);

    // The provider approves a suggestion (provider.gated_decide); pending suggestions never count.
    const approve = await p.c.post(`/v1/orgs/${p.id}/provider/capabilities/${caps[0]!.id}/decision`, { decision: 'approve' });
    expect(approve.status, approve.text).toBe(200);

    // Skill heatmap (W10, 54 §2.3) from the active capability levels, private to the provider with the consent.
    const built = await worker.get(SkillHeatmapBuilder, { strict: false }).rebuild(p.id);
    expect(built).toBeGreaterThan(0);
    const heat = await p.c.get(`/v1/orgs/${p.id}/provider/ai/skill-heatmap`);
    expect(heat.status, heat.text).toBe(200);
    expect(heat.body.entries.length).toBe(built);
    expect(heat.body.entries[0]).toMatchObject({ classification: expect.any(String), confidence: expect.any(String) });
    expect((await provider.c.get(`/v1/orgs/${p.id}/provider/ai/skill-heatmap`)).status).toBe(404);
  });

  it('vendor fitment suggestions wait for confirmation; a staff draft waits for an approval its requester cannot decide', async () => {
    const v = await publishedVendor(app, n, {
      name: `S9 Parts ${newId().slice(-6)}`,
      item: { name_translations: { en: '  front   brake   pad set ' } },
    });
    await grantOrgConsent(v.id, 'vendor_inventory_ai_use');
    const fit = await v.c.post(`${v.vnd}/inventory/${v.itemId}/ai/fitment`);
    expect(fit.status, fit.text).toBe(202);
    await settle();
    expect((await job(v.c, fit.body.id)).status).toBe('succeeded');

    // A vendor staff member asks for normalization: the result waits for the vendor owner's approval.
    const staffUser = await app.fixtures.user();
    await app.fixtures.member(staffUser, { id: v.id, type: 'vendor' } as never, 'vendor_staff');
    const staff = client(app, await app.fixtures.token(staffUser));
    const norm = await staff.post(`${v.vnd}/ai/normalize`, { item_ids: [v.itemId] });
    expect(norm.status, norm.text).toBe(202);
    await settle();
    const nj = await job(staff, norm.body.id);
    expect(nj.status, JSON.stringify(nj)).toBe('succeeded');
    const list = await v.c.get(`/v1/orgs/${v.id}/ai/suggestions?target_type=inventory_item`);
    const suggestion = (list.body.items as Json[]).find((s) => s.insight_id === nj.result.id)!;
    expect(suggestion).toMatchObject({ status: 'pending', target: { type: 'inventory_item', id: v.itemId } });
    const blocked = await v.c.post(`/v1/ai/suggestions/${suggestion.id}/decision`, { decision: 'accept' });
    expect(blocked.status).toBe(409);
    const approvals = await v.c.get(`/v1/orgs/${v.id}/approval-requests`);
    const approval = (approvals.body.items as Json[]).find((a) => a.insight_id === nj.result.id)!;
    expect(approval).toMatchObject({ action_type: 'apply_inventory_normalization', approver_role: 'vendor_owner', status: 'pending' });
    // The staff member is not the approver role (404); the owner approves.
    expect((await staff.post(`/v1/approval-requests/${approval.id}/decision`, { decision: 'approved' })).status).toBe(404);
    const ok = await v.c.post(`/v1/approval-requests/${approval.id}/decision`, {
      decision: 'approved',
      decision_reason: 'Names look right',
    });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body.status).toBe('approved');
    const applied = await v.c.post(`/v1/ai/suggestions/${suggestion.id}/decision`, { decision: 'accept' });
    expect(applied.status, applied.text).toBe(200);
    const [item] = await query<{ normalized_name: string }>(
      app,
      sql`SELECT normalized_name FROM inventory.inventory_items WHERE id = ${v.itemId}::uuid`,
    );
    expect(item!.normalized_name).toBe('Front Brake Pad Set');

    // Separation of duties: nobody approves their own request (SELF_APPROVAL_FORBIDDEN).
    const own = newId();
    await app.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
      db
        .insertInto('ai_mcp.approval_requests')
        .values({
          id: own,
          requested_by_user_id: v.userId,
          action_type: 'publish_showcase',
          subject_entity_type: 'organization',
          subject_entity_id: v.id,
          organization_id: v.id,
          risk_level: 'external_action',
          summary: 'Own request',
          approver_role: 'vendor_owner',
        })
        .execute(),
    );
    const self = await v.c.post(`/v1/approval-requests/${own}/decision`, { decision: 'approved' });
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('SELF_APPROVAL_FORBIDDEN');
    // Another organization sees none of it.
    expect((await provider.c.get(`/v1/insights/${nj.result.id}`)).status).toBe(404);
    expect((await provider.c.post(`/v1/approval-requests/${own}/decision`, { decision: 'approved' })).status).toBe(404);
  });
});

describe('AI records in the platform flows (S8 registries)', () => {
  it("DSR exports and erases a user's triage sessions and personal insights; TriageSession retention deletes old sessions", async () => {
    const cu = await customer(app, n);
    const s = await cu.c.post('/v1/me/triage-sessions', { vehicle_id: cu.vehicleId, text: 'rattling noise over bumps', locale: 'en' });
    expect(s.status, s.text).toBe(201);
    const done = await cu.c.post(`/v1/me/triage-sessions/${s.body.id}/complete`, { create_issue: false, find_providers: false });
    expect(done.body.result_insight_id).toEqual(expect.any(String));
    const handler = app.app
      .get(PersonalDataRegistry, { strict: false })
      .entries()
      .find(([m]) => m === 'ai_mcp')![1];
    const sections = await app.fixtures.worker.run({ actorType: 'system' }, (scope) => handler.export!(scope, cu.user.id));
    expect(sections.find((x) => x.section === 'triage_sessions')!.records[0]!.fields.user_turns).toContain('rattling noise');
    expect(sections.find((x) => x.section === 'ai_insights')!.records).toHaveLength(1);
    const erased = await app.fixtures.worker.run({ actorType: 'system' }, (scope) => handler.erase!(scope, cu.user.id));
    expect(erased).toBeGreaterThanOrEqual(2);
    const left = await query<{ n: string }>(app, sql`SELECT count(*) AS n FROM ai_mcp.triage_sessions WHERE user_id = ${cu.user.id}::uuid`);
    expect(Number(left[0]!.n)).toBe(0);
    const [insight] = await query<{ owner_user_id: string | null; summary: string; visibility: string }>(
      app,
      sql`SELECT owner_user_id, summary, visibility FROM ai_mcp.ai_insights WHERE id = ${done.body.result_insight_id}::uuid`,
    );
    expect(insight).toEqual({ owner_user_id: null, summary: '[erased]', visibility: 'internal' });

    // A session older than the 365-day policy (created_at is kept by core.tg_touch, so the row is inserted old).
    const old = { body: { id: newId() } };
    await app.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
      db
        .insertInto('ai_mcp.triage_sessions')
        .values({
          id: old.body.id,
          user_id: cu.user.id,
          vehicle_id: cu.vehicleId,
          locale: 'en',
          created_at: new Date(Date.now() - 400 * 86_400_000),
        })
        .execute(),
    );
    const retention = app.app.get(RetentionHandlers, { strict: false }).get('TriageSession')!;
    const removed = await app.fixtures.worker.run({ actorType: 'system' }, (scope) =>
      retention(scope, { entityType: 'TriageSession', retentionDays: 365, action: 'delete' } as never),
    );
    expect(removed).toBeGreaterThanOrEqual(1);
    expect((await cu.c.get(`/v1/me/triage-sessions/${old.body.id}`)).status).toBe(404);
  });
});
