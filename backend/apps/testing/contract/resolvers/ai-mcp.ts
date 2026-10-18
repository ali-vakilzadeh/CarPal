// Contract sweep resolvers: the AI facade (40 §21) — Help Me triage, the
// asynchronous feature requests (202 Job), insights, suggestions and approval
// requests — and AI oversight on the admin plane (§23.5). Every FLAG(ai.*)
// route is replayed on the kill-switch host first (503 AI_UNAVAILABLE, the
// runner); AI records never cross tenants (BOLA); approval requests are never
// decided by their requester.
import type { Route } from '#libs/contract/index.js';
import { sql } from 'kysely';
import { expect } from 'vitest';
import { REASON } from '../../s8-support.js';
import { ok, type Actor, type Harness, type Json, type Published, type Resolvers } from '../harness.js';

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);

/** An organization consent as org.consents_grant stores it (that operation needs an AAL2 owner session). */
async function orgConsent(h: Harness, orgId: string, type: string): Promise<void> {
  await h.sys((db) =>
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

/** A member of a new organization on a plan, with the organization consents the AI features need. */
async function orgMember(
  h: Harness,
  type: 'provider' | 'vendor' | 'fleet',
  plan: string,
  o: { role?: string; consents?: string[] } = {},
): Promise<Actor> {
  const owner = await h.member(type);
  await h.fx.subscription(owner.org!, plan);
  for (const c of o.consents ?? []) await orgConsent(h, owner.org!.id, c);
  return o.role ? h.colleague(owner, o.role) : owner;
}

/** A triage session of a user about their vehicle. */
async function triage(h: Harness): Promise<{ as: Actor; id: string }> {
  const as = await h.user();
  const s = ok(
    await as.c.post('/v1/me/triage-sessions', {
      vehicle_id: await h.vehicle(as),
      text: 'There is a grinding noise from the front wheels.',
      locale: 'en',
    }),
    'triage.start',
  );
  return { as, id: s.id as string };
}

/** A user's finished vehicle-suggestions job (W9): the insight and its pending suggestions. */
async function vehicleInsight(h: Harness): Promise<{ as: Actor; insightId: string; suggestions: Json[] }> {
  const as = await h.user();
  const vehicleId = await h.vehicle(as);
  const job = ok(
    await as.c.post(`/v1/me/vehicles/${vehicleId}/ai/suggestions`, { kinds: ['maintenance_suggestion', 'vehicle_summary'] }),
    'vehicle suggestions',
  );
  await h.settle();
  const done = ok(await as.c.get(`/v1/jobs/${job.id}`), 'job');
  if (done.status !== 'succeeded') throw new Error(`AI job ${JSON.stringify(done)}`);
  const mine = ok(await as.c.get('/v1/me/ai/suggestions'), 'suggestions');
  return { as, insightId: done.result.id as string, suggestions: (mine.items as Json[]).filter((s) => s.insight_id === done.result.id) };
}

/** A vendor whose staff member asked for normalization: a pending approval request for the owner. */
async function staffNormalization(h: Harness): Promise<{ owner: Actor; staff: Actor; approvalId: string; vendorId: string }> {
  const owner = await orgMember(h, 'vendor', 'vendor_basic', { consents: ['vendor_inventory_ai_use'] });
  const item = ok(
    await owner.c.post(`/v1/orgs/${owner.org!.id}/vendor/inventory`, {
      sku: `AI-${h.newId().slice(-10)}`,
      name_translations: { en: '  front   brake   pad set ' },
      part_origin: 'aftermarket',
      condition: 'new',
      part_category_node_id: h.n.partCategory,
      price_public: '450000',
      currency: 'IRR',
      price_on_request: false,
      stock_status: 'in_stock',
      visibility: 'public',
      status: 'active',
    }),
    'item',
  );
  const staff = await h.colleague(owner, 'vendor_staff');
  const job = ok(await staff.c.post(`/v1/orgs/${owner.org!.id}/vendor/ai/normalize`, { item_ids: [item.id] }), 'normalize');
  await h.settle();
  const done = ok(await staff.c.get(`/v1/jobs/${job.id}`), 'job');
  const approvals = ok(await owner.c.get(`/v1/orgs/${owner.org!.id}/approval-requests`), 'approvals');
  const approval = (approvals.items as Json[]).find((a) => a.insight_id === done.result?.id);
  if (!approval) throw new Error(`no approval request: ${JSON.stringify(done)}`);
  return { owner, staff, approvalId: approval.id as string, vendorId: owner.org!.id };
}

/** A published provider (default plan) with a published review of a customer. */
async function reviewed(h: Harness): Promise<{ p: Published; reviewId: string }> {
  const p = await h.provider();
  const author = await h.user();
  const r = ok(
    await author.c.post('/v1/reviews', {
      subject_organization_id: p.id,
      subject_type: 'provider',
      overall_rating: 2,
      body: 'They fixed the noise but it came back after a week.',
      content_locale: 'en',
    }),
    'review',
  );
  await h.q(sql`UPDATE trust.reviews SET confirmation_path = 'visit_based', verified_status = 'admin_verified',
      business_confirmation_status = NULL, business_confirmation_due_at = NULL, reviewer_decision = NULL,
      status = 'published', published_at = now(), trust_weight = '1.000', counts_toward_core_score = true
    WHERE id = ${r.id}::uuid`);
  return { p, reviewId: r.id as string };
}

/** A vehicle owner on the route's scope; fleets get a plan with the AI tools. */
async function aiVehicleOwner(h: Harness, route: Route): Promise<{ as: Actor; vehicleId: string }> {
  const as = route.scope === 'fleet' ? await orgMember(h, 'fleet', 'fleet_50', { role: 'fleet_maintenance_coordinator' }) : await h.user();
  return { as, vehicleId: await h.vehicle(as) };
}

export const resolvers: Resolvers = {
  'triage.start': async (h) => {
    const as = await h.user();
    return {
      as,
      body: { vehicle_id: await h.vehicle(as), text: 'There is a grinding noise from the front wheels.', locale: 'en' },
      bodyRefs: true,
    };
  },
  'triage.reply': async (h) => {
    const t = await triage(h);
    return { as: t.as, params: { session_id: t.id }, body: { text: 'It happens when braking at low speed.' } };
  },
  'triage.get': async (h) => {
    const t = await triage(h);
    return { as: t.as, params: { session_id: t.id } };
  },
  'triage.complete': async (h) => {
    const t = await triage(h);
    return { as: t.as, params: { session_id: t.id }, body: { create_issue: true, find_providers: false } };
  },
  'ai.vehicle_suggestions': async (h, route) => {
    const o = await aiVehicleOwner(h, route);
    return { as: o.as, params: { vehicle_id: o.vehicleId }, body: { kinds: ['vehicle_summary'] } };
  },
  'ai.service_history_insights': async (h, route) => {
    const o = await aiVehicleOwner(h, route);
    return { as: o.as, params: { vehicle_id: o.vehicleId } };
  },
  'ai.profile_helper': async (h) => {
    // The helper reads the provider's own profile and records (published provider, default plan).
    const p = await h.provider();
    await orgConsent(h, p.id, 'provider_analytics_ai_use');
    return { as: p.as };
  },
  'ai.skill_heatmap': async (h) => ({
    as: await orgMember(h, 'provider', 'provider_basic', { consents: ['provider_analytics_ai_use'] }),
    query: { scope_type: 'service_system' },
  }),
  'ai.review_response_draft': async (h) => {
    const r = await reviewed(h);
    return { as: r.p.as, params: { review_id: r.reviewId }, body: { tone: 'friendly', locale: 'en' } };
  },
  'ai.review_insights': async (h) => ({
    as: await orgMember(h, 'provider', 'provider_pro', { consents: ['provider_analytics_ai_use'] }),
    body: { from: daysAgo(90), to: daysAgo(0) },
  }),
  'ai.showcase_compose': async (h) => {
    const as = await orgMember(h, 'provider', 'provider_basic', { role: 'provider_staff' });
    const item = ok(
      await as.c.post(`/v1/orgs/${as.org!.id}/provider/portfolio`, {
        title: 'Control arm replacement',
        content_locale: 'en',
        service_system_node_id: h.n.system,
        visibility: 'public',
      }),
      'portfolio item',
    );
    return { as, params: { item_id: item.id as string }, body: { locale: 'en' } };
  },
  'ai.appointment_suggestions': async (h) => {
    const as = await orgMember(h, 'provider', 'provider_basic', { role: 'provider_staff' });
    const customer = await h.user();
    const appointmentId = await h.fx.appointment(as.org!, customer.user, await h.vehicle(customer));
    return { as, params: { appointment_id: appointmentId } };
  },
  'ai.inventory_normalize': async (h) => {
    const s = await staffNormalization(h);
    const item = (ok(await s.owner.c.get(`/v1/orgs/${s.vendorId}/vendor/inventory`), 'items').items as Json[])[0]!;
    // SEC-AI-4 / SEC-AZ-4: another vendor (same plan and consent) cannot name these items.
    return {
      as: s.owner,
      body: { item_ids: [item.id] },
      bola: { attackers: [await orgMember(h, 'vendor', 'vendor_basic', { consents: ['vendor_inventory_ai_use'] })] },
    };
  },
  'ai.fitment_suggest': async (h) => {
    const as = await orgMember(h, 'vendor', 'vendor_basic', { consents: ['vendor_inventory_ai_use'], role: 'vendor_staff' });
    const owner = await h.colleague(as, 'vendor_owner');
    const item = ok(
      await owner.c.post(`/v1/orgs/${as.org!.id}/vendor/inventory`, {
        sku: `AI-${h.newId().slice(-10)}`,
        name_translations: { en: 'Front brake pad set' },
        part_origin: 'aftermarket',
        condition: 'new',
        part_category_node_id: h.n.partCategory,
        price_public: '450000',
        currency: 'IRR',
        price_on_request: false,
        stock_status: 'in_stock',
        visibility: 'public',
        status: 'active',
      }),
      'item',
    );
    return { as, params: { item_id: item.id as string } };
  },
  'ai.inventory_gaps': async (h) => ({ as: await orgMember(h, 'vendor', 'vendor_pro') }),
  'ai.fleet_suggestions': async (h) => {
    const as = await orgMember(h, 'fleet', 'fleet_50', { consents: ['fleet_data_ai_use'] });
    return {
      as,
      body: { vehicle_ids: [await h.vehicle(as)] },
      bodyRefs: true,
      bola: { attackers: [await orgMember(h, 'fleet', 'fleet_50', { consents: ['fleet_data_ai_use'] })] },
    };
  },
  'ai.insight_get': async (h) => {
    const i = await vehicleInsight(h);
    return { as: i.as, params: { insight_id: i.insightId } };
  },
  'ai.insight_feedback': async (h) => {
    const i = await vehicleInsight(h);
    return { as: i.as, params: { insight_id: i.insightId }, body: { feedback_type: 'rating', rating: 4 } };
  },
  'ai.suggestions_list': async (h) => {
    const s = await staffNormalization(h);
    return { as: s.owner, query: { target_type: 'inventory_item' }, check: (res) => expect(res.body.items.length).toBeGreaterThan(0) };
  },
  'ai.suggestions_mine': async (h) => {
    const i = await vehicleInsight(h);
    return { as: i.as, check: (res) => expect(res.body.items.length).toBeGreaterThan(0) };
  },
  'ai.suggestion_decide': async (h) => {
    const i = await vehicleInsight(h);
    return { as: i.as, params: { suggestion_id: i.suggestions[0]!.id as string }, body: { decision: 'reject' } };
  },
  'ai.approvals_list': async (h) => {
    const s = await staffNormalization(h);
    return { as: s.owner, check: (res) => expect(res.body.items.map((a: Json) => a.id)).toContain(s.approvalId) };
  },
  'ai.approval_decide': async (h) => {
    const s = await staffNormalization(h);
    // Never decided by the requester or anyone outside the approver role (404).
    return {
      as: s.owner,
      params: { approval_id: s.approvalId },
      body: { decision: 'approved', decision_reason: 'Names look right' },
      bola: { attackers: [await h.stranger(), s.staff] },
    };
  },
  'admin.ai_insights_search': async (h) => ({
    as: await h.staff('platform_moderator'),
    body: { from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date().toISOString(), limit: 10 },
  }),
  'admin.mcp_clients_list': async (h) => ({ as: await h.staff('platform_admin') }),
  'admin.mcp_client_update': async (h) => {
    // A client of its own (the baseline test counts the seeded clients): removed when the suite ends.
    const id = h.newId();
    await h.sys((db) =>
      db
        .insertInto('ai_mcp.mcp_clients')
        .values({
          id,
          name: `sweep_client_${id.slice(-8)}`,
          client_type: 'internal_assistant',
          allowed_scopes: ['read:a'],
          allowed_resources: ['res:a'],
          allowed_tools: ['tool:a@1'],
          rate_limit_policy: 'default',
          environment: 'dev',
        })
        .execute(),
    );
    h.onClose(() => h.sys((db) => db.deleteFrom('ai_mcp.mcp_clients').where('id', '=', id).execute()));
    return { as: await h.staff('platform_admin'), params: { client_id: id }, version: 1, body: { status: 'suspended', reason: REASON } };
  },
  'admin.mcp_access_log_search': async (h) => ({
    as: await h.staff('platform_admin'),
    body: { from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date().toISOString(), limit: 10 },
  }),
};
