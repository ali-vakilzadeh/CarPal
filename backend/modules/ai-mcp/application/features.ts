// Asynchronous AI feature requests (40 §21.3, 202 Job; W9
// ai-insight-generator). The API handler authorizes the target in the
// caller's transaction (owner predicates through the owning module's context
// source, consent CNS and entitlement ENT), then queues a core.background_jobs
// row of kind ai_insight whose input summary holds ids and options only. W9
// runs the job in the requester's own RLS context: it re-reads the context
// package (a withdrawn consent or a target gone fails the job), calls the
// tools through the gateway (flag and kill switch re-checked), stores the
// insights, and hands suggestions to the owning module as pending records
// (sinks) a human decides later. Low-role members' drafts for external
// actions wait for an ApprovalRequest (53 §14.2).
import { Injectable } from '@nestjs/common';
import { ApiError, isApiError, type OperationId } from '#libs/contract/index.js';
import type { ConsentType, InsightType } from '#libs/contract/generated/enums.js';
import { ConsentChecker, requireConsent } from '#libs/consent-gate/index.js';
import { EntitlementChecker, requireEntitlement, type EntitlementKey } from '#libs/entitlements/index.js';
import { Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import { isLocale, type Locale } from '#libs/i18n/index.js';
import { acceptedJob, JobService, type JobContext, type JobOutcome } from '#libs/jobs/index.js';
import { TxRunner, type TxScope } from '#libs/tenancy/index.js';
import { AiContextSources, type AiPrincipal, type AiSinkKey, type AiSourceKey } from '../interface/ai.js';
import { TOOLS, type McpClientName, type ToolSpec } from '../domain/tools.js';
import { AiStore } from '../infrastructure/ai-store.js';
import { McpGateway, type InvokeResult } from './gateway.js';

export const AI_INSIGHT_QUEUE = 'ai.insight';

type Json = Record<string, unknown>;

/** One tool call of a feature run. */
interface CallPlan {
  tool: ToolSpec;
  client: McpClientName;
  insightType: InsightType;
  context: Json;
  resources: string[];
  userText?: string[];
  subject: { type: string; id: string };
  visibility?: 'internal' | 'owner_only' | 'public_after_approval';
  /** Output to hand to the owning module (pending records). */
  sink?: AiSinkKey;
}

interface Approval {
  actionType: 'publish_showcase' | 'apply_inventory_normalization';
  approverRole: string;
  /** Requester roles that need it (staff-level members). */
  forRoles: string[];
  subject: (input: Json, who: AiPrincipal) => { type: string; id: string };
}

interface FeatureDef {
  op: OperationId;
  flag: string;
  consent?: ConsentType;
  entitlement: EntitlementKey;
  /** Authorizes the target in the caller's transaction; returns the job input summary (ids and options only). */
  accept(ctx: OperationContext, scope: TxScope, who: AiPrincipal, sources: AiContextSources): Promise<Json>;
  /** W9: the calls of a run, from context packages read in the requester's context; null = target gone. */
  plan(scope: TxScope, who: AiPrincipal, input: Json, sources: AiContextSources, locale: Locale): Promise<CallPlan[] | null>;
  approval?: Approval;
}

const notFound = () => new ApiError('NOT_FOUND');
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** A context package or 404: the owning module answers null when the target is not the caller's. */
async function need(sources: AiContextSources, key: AiSourceKey, scope: TxScope, who: AiPrincipal, args: Json): Promise<Json> {
  const pkg = await sources.source(key)(scope, who, args);
  if (!pkg) throw notFound();
  return pkg;
}

/** Personal vehicles act through the consumer assistant, fleet vehicles through the fleet assistant (53 §19). */
const vehicleClient = (who: AiPrincipal): McpClientName => (who.orgId ? 'fleet_assistant' : 'consumer_assistant');

const VEHICLE_KINDS: Record<string, { tool: ToolSpec; type: InsightType }> = {
  vehicle_field_suggestion: { tool: TOOLS.vehicleFields, type: 'vehicle_field_suggestion' },
  maintenance_suggestion: { tool: TOOLS.vehicleMaintenance, type: 'maintenance_suggestion' },
  vehicle_summary: { tool: TOOLS.vehicleHistory, type: 'vehicle_summary' },
};

export const FEATURES: FeatureDef[] = [
  {
    op: 'ai.vehicle_suggestions',
    flag: 'ai.vehicle_helper.enabled',
    entitlement: 'ai_tools_enabled',
    async accept(ctx, scope, who, sources) {
      const vehicleId = ctx.params.vehicle_id!;
      await need(sources, 'vehicle.profile', scope, who, { vehicle_id: vehicleId });
      return { vehicle_id: vehicleId, kinds: ids((ctx.body as Json).kinds) };
    },
    async plan(scope, who, input, sources) {
      const v = await sources.source('vehicle.profile')(scope, who, { vehicle_id: input.vehicle_id });
      if (!v) return null;
      return ids(input.kinds)
        .filter((k) => VEHICLE_KINDS[k])
        .map((k) => ({
          tool: VEHICLE_KINDS[k]!.tool,
          client: vehicleClient(who),
          insightType: VEHICLE_KINDS[k]!.type,
          context: v,
          resources: ['res:vehicle.summary', 'res:vehicle.details', 'res:vehicle.maintenance_plan', 'res:taxonomy.service_systems'],
          subject: { type: 'vehicle', id: str(input.vehicle_id)! },
        }));
    },
  },
  {
    op: 'ai.service_history_insights',
    flag: 'ai.service_history.enabled',
    entitlement: 'ai_tools_enabled',
    async accept(ctx, scope, who, sources) {
      const vehicleId = ctx.params.vehicle_id!;
      await need(sources, 'vehicle.profile', scope, who, { vehicle_id: vehicleId });
      return { vehicle_id: vehicleId };
    },
    async plan(scope, who, input, sources) {
      const h = await sources.source('vehicle.history')(scope, who, { vehicle_id: input.vehicle_id });
      if (!h) return null;
      return [
        {
          tool: TOOLS.vehicleHistory,
          client: vehicleClient(who),
          insightType: 'service_history_summary',
          context: h,
          resources: ['res:vehicle.summary', 'res:vehicle.service_history'],
          subject: { type: 'vehicle', id: str(input.vehicle_id)! },
        },
      ];
    },
  },
  {
    op: 'ai.profile_helper',
    flag: 'ai.profile_helper.enabled',
    consent: 'provider_analytics_ai_use',
    entitlement: 'ai_tools_enabled',
    async accept(_ctx, scope, who, sources) {
      await need(sources, 'provider.profile_facts', scope, who, {});
      return {};
    },
    async plan(scope, who, _input, sources) {
      const f = await sources.source('provider.profile_facts')(scope, who, {});
      if (!f) return null;
      return [
        {
          tool: TOOLS.profileCapabilities,
          client: 'provider_assistant',
          insightType: 'capability_suggestion',
          context: f,
          resources: ['res:provider.profile_details', 'res:provider.capability_evidence', 'res:provider.profile_gaps'],
          subject: { type: 'organization', id: who.orgId! },
          sink: 'provider.capability_suggestions',
        },
      ];
    },
  },
  {
    op: 'ai.review_response_draft',
    flag: 'ai.review_response.enabled',
    entitlement: 'ai_tools_enabled',
    async accept(ctx, scope, who, sources) {
      const reviewId = ctx.params.review_id!;
      await need(sources, 'review.for_response', scope, who, { review_id: reviewId });
      const b = ctx.body as Json;
      return { review_id: reviewId, tone: str(b.tone) ?? 'formal', locale: b.locale };
    },
    async plan(scope, who, input, sources) {
      const r = await sources.source('review.for_response')(scope, who, { review_id: input.review_id });
      if (!r) return null;
      return [
        {
          tool: TOOLS.reviewDraft,
          client: who.role?.startsWith('vendor_') ? 'vendor_assistant' : 'provider_assistant',
          insightType: 'review_response_draft',
          context: { review: r, tone: input.tone },
          resources: ['res:review.detail'],
          subject: { type: 'review', id: str(input.review_id)! },
        },
      ];
    },
  },
  {
    op: 'ai.review_insights',
    flag: 'ai.review_insights.enabled',
    consent: 'provider_analytics_ai_use',
    entitlement: 'advanced_analytics_enabled',
    async accept(ctx) {
      const b = ctx.body as { from: string; to: string };
      if (b.to < b.from) throw ApiError.validation([{ pointer: '/to', code: 'order' }]);
      if (Date.parse(b.to) - Date.parse(b.from) > 366 * 86_400_000)
        throw ApiError.validation([{ pointer: '/to', code: 'out_of_range', limit: '366 days' }]);
      return { from: b.from, to: b.to };
    },
    async plan(scope, who, input, sources) {
      const r = await sources.source('review.period')(scope, who, { from: input.from, to: input.to });
      if (!r) return null;
      return [
        {
          tool: TOOLS.reviewSummary,
          client: who.role?.startsWith('vendor_') ? 'vendor_assistant' : 'provider_assistant',
          insightType: 'review_theme',
          context: r,
          resources: ['res:review.list', 'res:provider.review_themes'],
          subject: { type: 'organization', id: who.orgId! },
        },
      ];
    },
  },
  {
    op: 'ai.showcase_compose',
    flag: 'ai.showroom.enabled',
    entitlement: 'ai_tools_enabled',
    async accept(ctx, scope, who, sources) {
      const itemId = ctx.params.item_id!;
      await need(sources, 'provider.portfolio_item', scope, who, { item_id: itemId, locale: (ctx.body as Json).locale });
      return { item_id: itemId, locale: (ctx.body as Json).locale };
    },
    async plan(scope, who, input, sources, locale) {
      const p = await sources.source('provider.portfolio_item')(scope, who, { item_id: input.item_id, locale });
      if (!p) return null;
      const subject = { type: 'portfolio_item', id: str(input.item_id)! };
      return [
        {
          tool: TOOLS.portfolioCaption,
          client: 'provider_assistant',
          insightType: 'showcase_caption',
          context: p,
          resources: ['res:provider.portfolio_summary'],
          subject,
        },
        {
          tool: TOOLS.portfolioRedaction,
          client: 'provider_assistant',
          insightType: 'redaction_suggestion',
          context: { image_media_ids: p.image_media_ids },
          resources: ['res:provider.portfolio_summary'],
          subject,
          sink: 'media.redaction_suggestions',
        },
      ];
    },
    approval: {
      actionType: 'publish_showcase',
      approverRole: 'provider_manager',
      forRoles: ['provider_staff'],
      subject: (input) => ({ type: 'portfolio_item', id: str(input.item_id)! }),
    },
  },
  {
    op: 'ai.appointment_suggestions',
    flag: 'ai.appointment.enabled',
    entitlement: 'ai_tools_enabled',
    async accept(ctx, scope, who, sources) {
      const id = ctx.params.appointment_id!;
      await need(sources, 'provider.appointment', scope, who, { appointment_id: id });
      return { appointment_id: id };
    },
    async plan(scope, who, input, sources) {
      const a = await sources.source('provider.appointment')(scope, who, { appointment_id: input.appointment_id });
      if (!a) return null;
      return [
        {
          tool: TOOLS.appointmentDuration,
          client: 'provider_assistant',
          insightType: 'appointment_slot_suggestion',
          context: a,
          resources: ['res:appointment.details', 'res:provider.availability', 'res:provider.services'],
          subject: { type: 'appointment', id: str(input.appointment_id)! },
        },
      ];
    },
  },
  {
    op: 'ai.inventory_normalize',
    flag: 'vendor.ai_import.enabled',
    consent: 'vendor_inventory_ai_use',
    entitlement: 'ai_tools_enabled',
    async accept(ctx, scope, who, sources) {
      const b = ctx.body as { item_ids?: string[]; import_batch_id?: string };
      if (!!b.item_ids === !!b.import_batch_id)
        throw ApiError.validation([
          { pointer: b.item_ids ? '/import_batch_id' : '/item_ids', code: b.item_ids ? 'conditional_forbidden' : 'conditional_required' },
        ]);
      const pkg = await sources.source('vendor.items')(scope, who, { ...b });
      if (!pkg)
        throw ApiError.validation(
          [{ pointer: b.item_ids ? '/item_ids' : '/import_batch_id', code: 'reference_not_found' }],
          'REFERENCE_NOT_FOUND',
        );
      return { ...(b.item_ids ? { item_ids: b.item_ids } : { import_batch_id: b.import_batch_id }) };
    },
    async plan(scope, who, input, sources) {
      const pkg = await sources.source('vendor.items')(scope, who, input);
      if (!pkg) return null;
      return [
        {
          tool: TOOLS.inventoryNormalize,
          client: 'vendor_assistant',
          insightType: 'inventory_normalization',
          context: pkg,
          resources: ['res:vendor.inventory_list', 'res:inventory.item_details', 'res:taxonomy.part_categories'],
          subject: input.import_batch_id
            ? { type: 'inventory_import_batch', id: str(input.import_batch_id)! }
            : { type: 'organization', id: who.orgId! },
        },
      ];
    },
    approval: {
      actionType: 'apply_inventory_normalization',
      approverRole: 'vendor_owner',
      forRoles: ['vendor_staff'],
      subject: (input, who) =>
        input.import_batch_id
          ? { type: 'inventory_import_batch', id: str(input.import_batch_id)! }
          : { type: 'organization', id: who.orgId! },
    },
  },
  {
    op: 'ai.fitment_suggest',
    flag: 'vendor.ai_import.enabled',
    consent: 'vendor_inventory_ai_use',
    entitlement: 'ai_tools_enabled',
    async accept(ctx, scope, who, sources) {
      const itemId = ctx.params.item_id!;
      await need(sources, 'vendor.item', scope, who, { item_id: itemId });
      return { item_id: itemId };
    },
    async plan(scope, who, input, sources) {
      const it = await sources.source('vendor.item')(scope, who, { item_id: input.item_id });
      if (!it) return null;
      return [
        {
          tool: TOOLS.inventoryFitment,
          client: 'vendor_assistant',
          insightType: 'fitment_suggestion',
          context: it,
          resources: ['res:inventory.item_details', 'res:inventory.fitment', 'res:taxonomy.vehicle.brands', 'res:taxonomy.vehicle.models'],
          // The vendor's own item text, matched against the public vehicle taxonomy (SEC-AI-2: data).
          userText: [str(it.name) ?? '', str(it.description) ?? ''].filter(Boolean),
          subject: { type: 'inventory_item', id: str(input.item_id)! },
          sink: 'vendor.fitment_suggestions',
        },
      ];
    },
  },
  {
    op: 'ai.inventory_gaps',
    flag: 'ai.inventory_gaps.enabled',
    entitlement: 'advanced_analytics_enabled',
    async accept() {
      return {};
    },
    async plan(scope, who, _input, sources) {
      const own = await sources.source('vendor.catalog')(scope, who, {});
      // Demand is aggregated over all searches (counts per part category): no other vendor's data (40 ai.inventory_gaps).
      const demand = await sources.source('search.part_demand')(scope, who, {});
      if (!own || !demand) return null;
      return [
        {
          tool: TOOLS.inventoryGaps,
          client: 'vendor_assistant',
          insightType: 'inventory_gap',
          context: { ...own, ...demand },
          resources: ['res:vendor.catalog_gaps', 'res:taxonomy.part_categories'],
          subject: { type: 'organization', id: who.orgId! },
        },
      ];
    },
  },
  {
    op: 'ai.fleet_suggestions',
    flag: 'ai.fleet.enabled',
    consent: 'fleet_data_ai_use',
    entitlement: 'ai_fleet_suggestions_enabled',
    async accept(ctx, scope, who, sources) {
      const vehicleIds = ids((ctx.body as Json).vehicle_ids);
      const pkg = await sources.source('fleet.vehicles')(scope, who, { vehicle_ids: vehicleIds });
      if (!pkg) throw ApiError.validation([{ pointer: '/vehicle_ids', code: 'reference_not_found' }], 'REFERENCE_NOT_FOUND');
      return vehicleIds.length ? { vehicle_ids: vehicleIds } : {};
    },
    async plan(scope, who, input, sources) {
      const pkg = await sources.source('fleet.vehicles')(scope, who, { vehicle_ids: ids(input.vehicle_ids) });
      if (!pkg) return null;
      return [
        {
          tool: TOOLS.fleetHealth,
          client: 'fleet_assistant',
          insightType: 'fleet_suggestion',
          context: pkg,
          resources: ['res:fleet.vehicle_list', 'res:fleet.maintenance_board', 'res:fleet.preferred_providers'],
          subject: { type: 'organization', id: who.orgId! },
        },
      ];
    },
  },
];

const BY_OP = new Map(FEATURES.map((f) => [f.op, f]));

function principalOf(ctx: OperationContext): AiPrincipal {
  if (ctx.principal.kind !== 'user') throw notFound();
  const org = ctx.access.org;
  return { userId: ctx.principal.userId, orgId: org?.id ?? null, role: org?.role ?? null };
}

const subscriberOf = (who: AiPrincipal) =>
  who.orgId ? { type: 'organization' as const, id: who.orgId } : { type: 'user' as const, id: who.userId };

/** CNS(type): the organization's consent for organization features, the user's for personal ones. */
export async function requireAiConsent(checker: ConsentChecker, scope: TxScope, who: AiPrincipal, type: ConsentType): Promise<void> {
  await requireConsent(checker, scope, { consentType: type, subject: subscriberOf(who) });
}

/** One handler class for the twelve §21.3 operations (each binds its definition by op id). */
@Injectable()
@Operation(
  'ai.vehicle_suggestions',
  'ai.service_history_insights',
  'ai.profile_helper',
  'ai.review_response_draft',
  'ai.review_insights',
  'ai.showcase_compose',
  'ai.appointment_suggestions',
  'ai.inventory_normalize',
  'ai.fitment_suggest',
  'ai.inventory_gaps',
  'ai.fleet_suggestions',
)
export class AiFeatureRequestHandler implements OperationHandler {
  constructor(
    private readonly sources: AiContextSources,
    private readonly consents: ConsentChecker,
    private readonly entitlements: EntitlementChecker,
    private readonly jobs: JobService,
  ) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const def = BY_OP.get(ctx.op.opId as OperationId)!;
    const who = principalOf(ctx);
    const job = await ctx.tx(async (scope) => {
      const input = await def.accept(ctx, scope, who, this.sources);
      if (def.consent) await requireAiConsent(this.consents, scope, who, def.consent);
      await requireEntitlement(this.entitlements, scope, subscriberOf(who), def.entitlement, 0);
      return this.jobs.create(scope, {
        kind: 'ai_insight',
        ownerUserId: who.userId,
        organizationId: who.orgId,
        owningModule: 'ai-mcp',
        inputSummary: { op: def.op, role: who.role, locale: ctx.locale, ...input },
        queue: AI_INSIGHT_QUEUE,
      });
    });
    return acceptedJob(job);
  }
}

/**
 * W9 side of the feature requests (queue ai.insight). Runs in the worker
 * deployable with the worker's TxRunner, in the requester's RLS context.
 */
@Injectable()
export class AiFeatureRunner {
  constructor(
    private readonly tx: TxRunner,
    private readonly sources: AiContextSources,
    private readonly consents: ConsentChecker,
    private readonly gateway: McpGateway,
    private readonly store: AiStore,
  ) {}

  async run(ctx: JobContext): Promise<JobOutcome> {
    const job = ctx.job;
    const input = (job.input_summary ?? {}) as Json;
    const def = BY_OP.get(str(input.op) as OperationId);
    if (!def) return { errorCode: 'INTERNAL' };
    const who: AiPrincipal = { userId: job.owner_user_id, orgId: job.organization_id, role: str(input.role) };
    const locale: Locale = isLocale(input.locale) ? input.locale : 'en';
    return this.execute(def.op, who, input, locale, job.id, ctx);
  }

  /** A feature run for `who` (a §21.3 job, or a W9 event such as an import that asked for AI normalization). */
  async execute(
    op: OperationId,
    who: AiPrincipal,
    input: Json,
    locale: Locale,
    requestId: string,
    ctx?: Pick<JobContext, 'signal' | 'progress'>,
  ): Promise<JobOutcome> {
    const def = BY_OP.get(op);
    if (!def) return { errorCode: 'INTERNAL' };
    const job = { id: requestId };
    const asRequester = <T>(fn: (scope: TxScope) => Promise<T>) =>
      this.tx.run({ actorType: 'user', userId: who.userId, orgId: who.orgId, role: who.role, requestId: job.id }, fn);
    try {
      // The context package is read again: a withdrawn consent or a target gone fails the job.
      const plans = await asRequester(async (scope) => {
        if (def.consent) await requireAiConsent(this.consents, scope, who, def.consent);
        return def.plan(scope, who, input, this.sources, locale);
      });
      if (!plans) return { errorCode: 'NOT_FOUND' };
      const results: { plan: CallPlan; result: InvokeResult }[] = [];
      for (const plan of plans) {
        if (ctx?.signal.aborted) return { errorCode: 'INTERNAL' };
        const result = await this.gateway.invoke({
          tool: plan.tool,
          client: plan.client,
          principal: who.orgId
            ? { type: 'organization', id: who.orgId, organizationId: who.orgId }
            : { type: 'user', id: who.userId, organizationId: null },
          locale,
          insightType: plan.insightType,
          requestId: job.id,
          flag: def.flag,
          context: plan.context,
          resources: plan.resources,
          ...(plan.userText ? { userText: plan.userText } : {}),
          contextEntity: plan.subject,
          store: {
            subject: plan.subject,
            ...(who.orgId ? { organizationId: who.orgId, ownerUserId: null } : { organizationId: null, ownerUserId: who.userId }),
            ...(plan.visibility ? { visibility: plan.visibility } : {}),
            requestedByUserId: who.userId,
            jobId: ctx ? job.id : null,
          },
        });
        results.push({ plan, result });
        await ctx?.progress(Math.round((results.length / plans.length) * 90));
      }
      if (results.length === 0) return { errorCode: 'NOT_FOUND' };
      // Pending domain records (decided later by a human with the owning module's operation).
      await asRequester(async (scope) => {
        for (const { plan, result } of results)
          if (plan.sink && result.insight && result.output.payload)
            await this.sources.sink(plan.sink)(scope, who, result.insight.id, result.output.payload, plan.subject);
      });
      const primary = results[0]!.result.insight!;
      if (def.approval && who.role && def.approval.forRoles.includes(who.role))
        await this.#approval(def.approval, input, who, primary.id, primary.summary, job.id);
      return { result: { type: 'ai_insight', id: primary.id } };
    } catch (err) {
      if (isApiError(err)) return { errorCode: err.code };
      throw err;
    }
  }

  /** 53 §14.2: a staff member's AI draft for an external action waits for the approver role (never the requester). */
  async #approval(a: Approval, input: Json, who: AiPrincipal, insightId: string, summary: string, requestId: string): Promise<void> {
    const subject = a.subject(input, who);
    await this.store.run(async ({ db }) => {
      const client = await db
        .selectFrom('ai_mcp.mcp_clients')
        .select('id')
        .where('name', '=', who.role?.startsWith('vendor_') ? 'vendor_assistant' : 'provider_assistant')
        .executeTakeFirst();
      await db
        .insertInto('ai_mcp.approval_requests')
        .values({
          requested_by_client_id: client?.id ?? null,
          requested_by_user_id: who.userId,
          action_type: a.actionType,
          subject_entity_type: subject.type,
          subject_entity_id: subject.id,
          organization_id: who.orgId,
          risk_level: 'external_action',
          summary: summary.slice(0, 1000),
          insight_id: insightId,
          approver_role: a.approverRole,
        })
        .execute();
    }, requestId);
  }
}
