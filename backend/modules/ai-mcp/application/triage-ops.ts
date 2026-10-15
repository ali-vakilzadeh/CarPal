// Help Me triage (40 §21.2; 53 triage tools; MVP Module F). Safety first:
// the rule-based safety check (L18) runs on every user turn before anything
// else, its urgency can only be raised by the AI (SEC-AI-7), and when AI is
// switched off or fails the 503 still carries the server-computed safety
// block and the direct-search path (the handler checks its own flag,
// ChecksOwnFlags). User text reaches the tool as data (SEC-AI-2). Completing
// a session creates, on request, a vehicle issue (vehicle.issue.reported), a
// ranked match session and an appointment draft; nothing is sent to a
// provider without the user's own submit (SEC-AI-3).
import { Injectable, Optional } from '@nestjs/common';
import { ApiError, isApiError, type TriageSafety } from '#libs/contract/index.js';
import {
  ChecksOwnFlags,
  created,
  Operation,
  type OperationContext,
  type OperationHandler,
  type OperationResult,
} from '#libs/http-pipeline/index.js';
import type { Locale } from '#libs/i18n/index.js';
import { SafetyCheck, type Urgency } from '#libs/safety-check/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { AppointmentDrafts } from '#modules/appointment/interface/appointments.js';
import { TriageMatching } from '#modules/discovery/interface/match-results.js';
import { FleetDrivers } from '#modules/fleet/interface/fleet.js';
import { MediaService } from '#modules/media/interface/media.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { VehicleCards, VehicleService } from '#modules/vehicle/interface/vehicles.js';
import { toTriage, triageNodeIds, triageSafety, turnsOf, type StoredTurn, type TriageRow } from '../api/projections.js';
import { TOOLS } from '../domain/tools.js';
import { McpGateway } from './gateway.js';

export const TRIAGE_FLAG = 'ai.triage.enabled';
const MAX_TURNS = 40;
const OPEN = ['in_progress', 'escalated_safety'];
const FLEET_REPORTERS = ['fleet_owner', 'fleet_manager', 'fleet_maintenance_coordinator', 'fleet_driver'];
const PHOTO_PURPOSES = ['issue_photo', 'vehicle_photo'] as const;

type TriagePayload = {
  symptom_node_ids: string[];
  likely_system_node_ids: string[];
  recommended_service_node_id: string | null;
  urgency: Urgency | null;
  next_question: string | null;
};

const caller = (ctx: OperationContext): string => {
  if (ctx.principal.kind !== 'user') throw new ApiError('NOT_FOUND');
  return ctx.principal.userId;
};
const notFoundAt = (pointer: string) => ApiError.validation([{ pointer, code: 'reference_not_found' }], 'REFERENCE_NOT_FOUND');
const uniq = (ids: readonly string[], max: number) => [...new Set(ids)].slice(0, max);

/** 503 AI_UNAVAILABLE that still answers the safety block and the non-AI path (40 triage.start err). */
function unavailable(err: ApiError | null, safety: TriageSafety): ApiError {
  return new ApiError('AI_UNAVAILABLE', {
    retryAfterMs: err?.retryAfterMs ?? 60_000,
    detail: err?.detail ?? 'triage unavailable',
    extensions: { safety, fallback_path: '/v1/search' },
  });
}

interface TriageVehicle {
  vehicleId: string;
  orgId: string | null;
  role: string | null;
}

/**
 * The vehicle a triage may run for (USR | ORG(F*) DRV): the caller's own, or
 * a vehicle of a fleet the caller belongs to (drivers: assigned vehicles
 * only, SEC-AZ-7). Sets the fleet as the transaction's organization.
 */
async function triageVehicle(
  ctx: OperationContext,
  scope: TxScope,
  vehicles: VehicleCards,
  drivers: FleetDrivers | undefined,
  vehicleId: string,
  pointer: string,
): Promise<TriageVehicle> {
  const own = await vehicles.visible(scope, vehicleId);
  const usable = (status: string) => status === 'active' || status === 'in_repair';
  if (own && own.ownerType === 'user') {
    if (!usable(own.status)) throw notFoundAt(pointer);
    return { vehicleId, orgId: null, role: null };
  }
  const fleetId = await vehicles.fleetOwner(scope, vehicleId);
  if (!fleetId) throw notFoundAt(pointer);
  const org = await ctx.authorizeOrg(fleetId, ['F*']).catch((err: unknown) => {
    throw isApiError(err) && err.code === 'NOT_FOUND' ? notFoundAt(pointer) : err;
  });
  if (org.role === 'fleet_driver' && !(await drivers?.assignedVehicleIds(scope, fleetId, caller(ctx)))?.has(vehicleId))
    throw notFoundAt(pointer);
  await scope.setOrganization(fleetId, org.role);
  const v = await vehicles.visible(scope, vehicleId);
  if (!v || !usable(v.status)) throw notFoundAt(pointer);
  return { vehicleId, orgId: fleetId, role: org.role };
}

@Injectable()
export class TriageService {
  constructor(
    private readonly gateway: McpGateway,
    private readonly safety: SafetyCheck,
    private readonly taxonomy: TaxonomyResolver,
  ) {}

  /** Rule-based safety over every user turn (SEC-BF-8). */
  async ruleSafety(userTexts: readonly string[]) {
    return this.safety.check(userTexts.join('\n'));
  }

  /** One clarifying turn of the tool; throws 503 with the safety block when AI is off or fails. */
  async turn(
    ctx: OperationContext,
    userId: string,
    o: { vehicleId: string; locale: Locale; userTexts: string[]; safety: TriageSafety },
  ): Promise<{ text: string; payload: TriagePayload }> {
    if (!(await ctx.flagEnabled(TRIAGE_FLAG))) throw unavailable(null, o.safety);
    try {
      const r = await this.gateway.invoke({
        tool: TOOLS.triageClassify,
        client: 'consumer_assistant',
        principal: { type: 'user', id: userId, organizationId: null },
        locale: o.locale,
        insightType: 'triage_summary',
        requestId: ctx.requestId,
        flag: TRIAGE_FLAG,
        context: { user_turns: o.userTexts.length },
        resources: ['res:vehicle.summary', 'res:taxonomy.symptoms', 'res:taxonomy.service_systems'],
        userText: o.userTexts,
        contextEntity: { type: 'vehicle', id: o.vehicleId },
      });
      return { text: r.output.summary, payload: r.output.payload as unknown as TriagePayload };
    } catch (err) {
      if (isApiError(err) && err.code === 'AI_UNAVAILABLE') throw unavailable(err, o.safety);
      throw err;
    }
  }

  async view(scope: TxScope, t: TriageRow, locale: Locale) {
    return toTriage(t, await this.taxonomy.labels(triageNodeIds(t), locale));
  }
}

/** Merges a turn's rule-based safety and AI classification into the session state. */
function merged(
  prev: { urgency: Urgency | null; safetyCritical: boolean; symptoms: readonly string[] },
  rule: { urgency: Urgency | null; matched_node_ids: string[] },
  ai: TriagePayload | null,
) {
  const urgency = SafetyCheck.merge(SafetyCheck.merge(prev.urgency, rule.urgency), ai?.urgency ?? null);
  const safetyCritical = prev.safetyCritical || urgency === 'safety_critical';
  return {
    urgency,
    safetyCritical,
    symptoms: uniq([...rule.matched_node_ids, ...prev.symptoms, ...(ai?.symptom_node_ids ?? [])], 10),
  };
}

const userTextsOf = (turns: StoredTurn[]) => turns.filter((t) => t.role === 'user').map((t) => t.text);

@Injectable()
@ChecksOwnFlags
@Operation('triage.start')
export class TriageStartHandler implements OperationHandler {
  constructor(
    private readonly triage: TriageService,
    private readonly vehicles: VehicleCards,
    private readonly media: MediaService,
    @Optional() private readonly drivers?: FleetDrivers,
  ) {}

  async handle(
    ctx: OperationContext<{ vehicle_id: string; text: string; locale: Locale; media_ids?: string[] }>,
  ): Promise<OperationResult> {
    const userId = caller(ctx);
    const b = ctx.body;
    const rule = await this.triage.ruleSafety([b.text]);
    const v = await ctx.tx(async (scope) => {
      const v = await triageVehicle(ctx, scope, this.vehicles, this.drivers, b.vehicle_id, '/vehicle_id');
      if (b.media_ids?.length)
        await this.media.requireReady(scope, b.media_ids, {
          owner: v.orgId ? { type: 'organization', id: v.orgId } : { type: 'user', id: userId },
          purposes: PHOTO_PURPOSES,
          pointer: '/media_ids',
        });
      return v;
    });
    const before = merged({ urgency: null, safetyCritical: false, symptoms: [] }, rule, null);
    const ai = await this.triage.turn(ctx, userId, {
      vehicleId: v.vehicleId,
      locale: b.locale,
      userTexts: [b.text],
      safety: triageSafety(before.urgency, before.safetyCritical),
    });
    const state = merged({ urgency: null, safetyCritical: false, symptoms: [] }, rule, ai.payload);
    const now = new Date().toISOString();
    const turns: StoredTurn[] = [
      { role: 'user', text: b.text, at: now, ...(b.media_ids?.length ? { media_ids: b.media_ids } : {}) },
      { role: 'assistant', text: ai.text, at: now, asks: ai.payload.next_question },
    ];
    const body = await ctx.tx(async (scope) => {
      const row = await scope.db
        .insertInto('ai_mcp.triage_sessions')
        .values({
          user_id: userId,
          organization_id: v.orgId,
          vehicle_id: v.vehicleId,
          locale: b.locale,
          turns: JSON.stringify(turns),
          symptom_node_ids: state.symptoms,
          likely_system_node_ids: uniq(ai.payload.likely_system_node_ids, 10),
          urgency_level: state.urgency,
          safety_critical: state.safetyCritical,
          recommended_service_node_id: ai.payload.recommended_service_node_id,
          status: state.safetyCritical ? 'escalated_safety' : 'in_progress',
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return this.triage.view(scope, row, ctx.locale);
    });
    return created(body, `/v1/me/triage-sessions/${body.id}`);
  }
}

async function ownSession(scope: TxScope, userId: string, id: string, lock = false): Promise<TriageRow> {
  const q = scope.db
    .selectFrom('ai_mcp.triage_sessions')
    .selectAll()
    .where('id', '=', id)
    .where('user_id', '=', userId)
    .where('deleted_at', 'is', null);
  const row = await (lock ? q.forUpdate() : q).executeTakeFirst();
  if (!row) throw new ApiError('NOT_FOUND');
  return row;
}

@Injectable()
@ChecksOwnFlags
@Operation('triage.reply')
export class TriageReplyHandler implements OperationHandler {
  constructor(private readonly triage: TriageService) {}

  async handle(ctx: OperationContext<{ text: string }>): Promise<OperationResult> {
    const userId = caller(ctx);
    const t = await ctx.tx((scope) => ownSession(scope, userId, ctx.params.session_id!), { readOnly: true });
    if (!OPEN.includes(t.status)) throw new ApiError('INVALID_TRANSITION', { detail: 'session_closed' });
    const turns = turnsOf(t);
    if (turns.length + 2 > MAX_TURNS) throw new ApiError('INVALID_TRANSITION', { detail: 'turn_limit' });
    const userTexts = [...userTextsOf(turns), ctx.body.text];
    const rule = await this.triage.ruleSafety(userTexts);
    const prev = { urgency: t.urgency_level as Urgency | null, safetyCritical: t.safety_critical, symptoms: t.symptom_node_ids };
    const before = merged(prev, rule, null);
    const ai = await this.triage.turn(ctx, userId, {
      vehicleId: t.vehicle_id,
      locale: t.locale as Locale,
      userTexts,
      safety: triageSafety(before.urgency, before.safetyCritical),
    });
    const state = merged(prev, rule, ai.payload);
    const now = new Date().toISOString();
    const body = await ctx.tx(async (scope) => {
      const cur = await ownSession(scope, userId, t.id, true);
      if (!OPEN.includes(cur.status) || cur.version !== t.version)
        throw new ApiError('INVALID_TRANSITION', { detail: OPEN.includes(cur.status) ? 'concurrent_reply' : 'session_closed' });
      const row = await scope.db
        .updateTable('ai_mcp.triage_sessions')
        .set({
          turns: JSON.stringify([
            ...turns,
            { role: 'user', text: ctx.body.text, at: now },
            { role: 'assistant', text: ai.text, at: now, asks: ai.payload.next_question },
          ] satisfies StoredTurn[]),
          symptom_node_ids: state.symptoms,
          likely_system_node_ids: uniq([...ai.payload.likely_system_node_ids, ...t.likely_system_node_ids], 10),
          urgency_level: state.urgency,
          safety_critical: state.safetyCritical,
          recommended_service_node_id: ai.payload.recommended_service_node_id ?? t.recommended_service_node_id,
          status: state.safetyCritical ? 'escalated_safety' : 'in_progress',
        })
        .where('id', '=', t.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return this.triage.view(scope, row, ctx.locale);
    });
    return { body };
  }
}

@Injectable()
@Operation('triage.get')
export class TriageGetHandler implements OperationHandler {
  constructor(private readonly triage: TriageService) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const userId = caller(ctx);
    const body = await ctx.tx(
      async (scope) => this.triage.view(scope, await ownSession(scope, userId, ctx.params.session_id!), ctx.locale),
      {
        readOnly: true,
      },
    );
    return { body };
  }
}

type CompleteBody = {
  create_issue: boolean;
  find_providers: boolean;
  location?: Record<string, unknown>;
  draft_appointment_with?: string;
};

@Injectable()
@Operation('triage.complete')
export class TriageCompleteHandler implements OperationHandler {
  constructor(
    private readonly triage: TriageService,
    private readonly gateway: McpGateway,
    private readonly vehicles: VehicleCards,
    private readonly issues: VehicleService,
    private readonly matching: TriageMatching,
    private readonly drafts: AppointmentDrafts,
    @Optional() private readonly drivers?: FleetDrivers,
  ) {}

  async handle(ctx: OperationContext<CompleteBody>): Promise<OperationResult> {
    const userId = caller(ctx);
    const b = ctx.body;
    const errors = [];
    if (b.find_providers && !b.location) errors.push({ pointer: '/location', code: 'conditional_required' as const });
    if (b.draft_appointment_with && !b.find_providers)
      errors.push({ pointer: '/draft_appointment_with', code: 'conditional_forbidden' as const });
    if (errors.length) throw ApiError.validation(errors);
    const t = await ctx.tx((scope) => ownSession(scope, userId, ctx.params.session_id!), { readOnly: true });
    if (!OPEN.includes(t.status)) throw new ApiError('INVALID_TRANSITION', { detail: 'session_closed' });
    if (b.draft_appointment_with && t.organization_id)
      throw ApiError.validation([{ pointer: '/draft_appointment_with', code: 'conditional_forbidden' }]);
    const turns = turnsOf(t);
    const userTexts = userTextsOf(turns);

    // The summary insight is optional: without AI the session still completes (53 §16.2).
    let insightId: string | null = null;
    try {
      const r = await this.gateway.invoke({
        tool: TOOLS.triageSummary,
        client: 'consumer_assistant',
        principal: { type: 'user', id: userId, organizationId: null },
        locale: t.locale as Locale,
        insightType: 'triage_summary',
        requestId: ctx.requestId,
        flag: TRIAGE_FLAG,
        context: { user_turns: userTexts.length },
        resources: ['res:vehicle.summary', 'res:taxonomy.symptoms', 'res:taxonomy.service_systems'],
        userText: userTexts,
        contextEntity: { type: 'triage_session', id: t.id },
        store: { subject: { type: 'triage_session', id: t.id }, organizationId: null, ownerUserId: userId, requestedByUserId: userId },
      });
      insightId = r.insight!.id;
    } catch (err) {
      if (!(isApiError(err) && err.code === 'AI_UNAVAILABLE')) throw err;
    }

    const body = await ctx.tx(async (scope) => {
      const cur = await ownSession(scope, userId, t.id, true);
      if (!OPEN.includes(cur.status)) throw new ApiError('INVALID_TRANSITION', { detail: 'session_closed' });
      let issueId = cur.issue_id;
      if (b.create_issue && !issueId) {
        const v = await triageVehicle(ctx, scope, this.vehicles, this.drivers, cur.vehicle_id, '/create_issue');
        if (v.role && !FLEET_REPORTERS.includes(v.role))
          throw ApiError.validation([{ pointer: '/create_issue', code: 'conditional_forbidden' }]);
        const text = userTexts.join('\n').trim();
        issueId = await this.issues.reportTriageIssue(scope, {
          vehicleId: cur.vehicle_id,
          orgId: v.orgId,
          driver: v.role === 'fleet_driver',
          userId,
          title: [...(userTexts[0] ?? 'Help Me')].slice(0, 117).join('').padEnd(3, '.'),
          description: [...(text.length >= 10 ? text : `Help Me: ${text}`.padEnd(10, '.'))].slice(0, 3000).join(''),
          locale: cur.locale as Locale,
          symptomNodeId: cur.symptom_node_ids[0] ?? null,
          urgency: (cur.urgency_level as Urgency | null) ?? (cur.safety_critical ? 'safety_critical' : 'medium'),
          triageSessionId: cur.id,
          aiInsightId: insightId,
          mediaIds: turns.flatMap((x) => x.media_ids ?? []).slice(0, 6),
        });
        await scope.setOrganization(null);
      }
      let matchSessionId = cur.match_session_id;
      let draftId = cur.appointment_draft_id;
      if (b.find_providers) {
        const m = await this.matching.match(ctx, scope, {
          triageSessionId: cur.id,
          vehicleId: cur.vehicle_id,
          fleetId: cur.organization_id,
          issueId,
          location: b.location!,
          urgency: (cur.urgency_level as Urgency | null) ?? null,
          symptomNodeId: cur.symptom_node_ids[0] ?? null,
          serviceSystemNodeIds: cur.likely_system_node_ids.slice(0, 10),
          serviceTaskNodeId: cur.recommended_service_node_id,
        });
        matchSessionId = m.matchSessionId;
        if (b.draft_appointment_with) {
          // The draft cites a completed session (appointments.create rules): complete it first.
          await scope.db
            .updateTable('ai_mcp.triage_sessions')
            .set({ status: 'completed', issue_id: issueId, result_insight_id: insightId, match_session_id: matchSessionId })
            .where('id', '=', cur.id)
            .execute();
          draftId = await this.drafts.draftFromTriage(ctx, scope, {
            providerOrgId: b.draft_appointment_with,
            pointer: '/draft_appointment_with',
            vehicleId: cur.vehicle_id,
            issueId,
            triageSessionId: cur.id,
            matchResultId: m.resultIds.get(b.draft_appointment_with) ?? null,
            description: userTexts.join('\n'),
            locale: cur.locale as Locale,
            urgency: (cur.urgency_level as Urgency | null) ?? 'medium',
            symptomNodeId: cur.symptom_node_ids[0] ?? null,
            serviceSystemNodeId: cur.likely_system_node_ids[0] ?? null,
            serviceTaskNodeId: cur.recommended_service_node_id,
          });
        }
      }
      const row = await scope.db
        .updateTable('ai_mcp.triage_sessions')
        .set({
          status: 'completed',
          issue_id: issueId,
          result_insight_id: insightId,
          match_session_id: matchSessionId,
          appointment_draft_id: draftId,
        })
        .where('id', '=', cur.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return this.triage.view(scope, row, ctx.locale);
    });
    return { body };
  }
}
