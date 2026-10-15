// AI oversight on the admin plane (40 §23.5: ai_insights_search,
// mcp_clients_list, mcp_client_update, mcp_access_log_search; 52 McpClient,
// McpAccessLog, AiInsight; S8 scope "data only": the AI facade, workers and
// gateway arrive in S9). Suspending or revoking a client acts at once;
// changing its scopes, resources or tools needs a second admin (4EYES).
// Access-log searches are audited themselves. Moderators can hide an AI
// output reported by users (moderation target ai_output).
import { Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import type { Selectable } from 'kysely';
import { writeAudit } from '#libs/audit/index.js';
import { ApiError } from '#libs/contract/index.js';
import { textArray, type DB } from '#libs/db/index.js';
import { Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { FourEyes, FourEyesExecutors, ModerationTargets, staffOf, type ContentAction } from '#modules/admin/interface/admin.js';

type ClientRow = Selectable<DB['ai_mcp.mcp_clients']>;
type InsightRow = Selectable<DB['ai_mcp.ai_insights']>;
type LogRow = Selectable<DB['ai_mcp.mcp_access_logs']>;

const MAX_RANGE_MS = 93 * 86_400_000;
const iso = (d: Date | string) => new Date(d).toISOString();

/** from < to and at most 93 days (40 admin.audit_search; the same bound for the AI searches). */
export function rangeOf(b: { from: string; to: string }): { from: Date; to: Date } {
  const from = new Date(b.from);
  const to = new Date(b.to);
  if (to <= from) throw ApiError.validation([{ pointer: '/to', code: 'order' }]);
  if (to.getTime() - from.getTime() > MAX_RANGE_MS) throw ApiError.validation([{ pointer: '/to', code: 'out_of_range', limit: '93 days' }]);
  return { from, to };
}

type Position = { id?: string } | undefined;

export function toClient(c: ClientRow) {
  return {
    id: c.id,
    name: c.name,
    client_type: c.client_type,
    allowed_scopes: c.allowed_scopes,
    allowed_resources: c.allowed_resources,
    allowed_tools: c.allowed_tools,
    rate_limit_policy: c.rate_limit_policy,
    geo_restrictions: textArray(c.geo_restrictions),
    environment: c.environment,
    status: c.status,
    version: c.version,
  };
}

function toInsight(i: InsightRow) {
  const refs = Array.isArray(i.evidence_references) ? (i.evidence_references as { type: string; id: string }[]) : [];
  return {
    id: i.id,
    insight_type: i.insight_type,
    subject: { type: i.subject_entity_type.slice(0, 40), id: i.subject_entity_id },
    locale: i.locale,
    confidence_score: i.confidence_score,
    summary: i.summary,
    structured_payload: (i.structured_payload as Record<string, unknown> | null) ?? null,
    evidence_references: refs.slice(0, 50).map((r) => ({ type: String(r.type).slice(0, 40), id: r.id })),
    safety_flags: i.safety_flags,
    visibility: i.visibility,
    human_approval_status: i.human_approval_status,
    model_version: i.model_version,
    created_at: iso(i.created_at),
    expires_at: i.expires_at ? iso(i.expires_at) : null,
    organization_id: i.organization_id,
  };
}

function toLog(l: LogRow) {
  return {
    id: l.id,
    mcp_client_id: l.mcp_client_id,
    principal: { type: l.principal_type, id: l.principal_id },
    organization_id: l.organization_id,
    operation_type: l.operation_type,
    resource_or_tool_key: l.resource_or_tool_key,
    tool_version: l.tool_version,
    risk_level: l.risk_level,
    consent_reference_id: l.consent_reference_id,
    redactions_applied: l.redactions_applied,
    policy_decision: l.policy_decision,
    approval_request_id: l.approval_request_id,
    output_insight_id: l.output_insight_id,
    model_version: l.model_version,
    result_status: l.result_status,
    latency_ms: l.latency_ms,
    request_id: l.request_id,
    created_at: iso(l.created_at),
  };
}

type InsightSearch = { insight_type?: string; organization_id?: string; has_feedback?: string; from: string; to: string; limit?: number };

@Injectable()
@Operation('admin.ai_insights_search')
export class AiInsightsSearchHandler implements OperationHandler {
  async handle(ctx: OperationContext<InsightSearch>): Promise<OperationResult> {
    staffOf(ctx);
    const b = ctx.body;
    const { from, to } = rangeOf(b);
    const limit = b.limit ?? 20;
    const after = (ctx.cursor as Position)?.id;
    const body = await ctx.tx(
      async (scope) => {
        let q = scope.db
          .selectFrom('ai_mcp.ai_insights')
          .selectAll()
          .where('created_at', '>=', from)
          .where('created_at', '<', to)
          .where('deleted_at', 'is', null);
        if (b.insight_type) q = q.where('insight_type', '=', b.insight_type);
        if (b.organization_id) q = q.where('organization_id', '=', b.organization_id);
        if (b.has_feedback)
          q = q.where(({ exists, selectFrom }) =>
            exists(
              selectFrom('ai_mcp.ai_evaluation_records as e')
                .select('e.id')
                .whereRef('e.insight_id', '=', 'ai_mcp.ai_insights.id')
                .where('e.feedback_type', '=', b.has_feedback!),
            ),
          );
        if (after) q = q.where('id', '<', after);
        const rows = await q
          .orderBy('id', 'desc')
          .limit(limit + 1)
          .execute();
        const page = rows.slice(0, limit);
        return ctx.page(page.map(toInsight), rows.length > limit ? { id: page.at(-1)!.id } : null);
      },
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('admin.mcp_clients_list')
export class McpClientsListHandler implements OperationHandler {
  async handle(ctx: OperationContext<undefined, { limit: number }>): Promise<OperationResult> {
    staffOf(ctx);
    const after = (ctx.cursor as Position)?.id;
    const body = await ctx.tx(
      async (scope) => {
        let q = scope.db.selectFrom('ai_mcp.mcp_clients').selectAll().where('deleted_at', 'is', null);
        if (after) q = q.where('id', '>', after);
        const rows = await q
          .orderBy('id')
          .limit(ctx.query.limit + 1)
          .execute();
        const page = rows.slice(0, ctx.query.limit);
        return ctx.page(page.map(toClient), rows.length > ctx.query.limit ? { id: page.at(-1)!.id } : null);
      },
      { readOnly: true },
    );
    return { body };
  }
}

type ClientUpdate = { status?: string; allowed_scopes?: string[]; allowed_resources?: string[]; allowed_tools?: string[]; reason: string };
const ACCESS_FIELDS = ['allowed_scopes', 'allowed_resources', 'allowed_tools'] as const;

/** Applies a client change (directly for status, or as the approved four-eyes change for access lists). */
export async function applyClientChange(scope: TxScope, clientId: string, b: ClientUpdate): Promise<ClientRow> {
  const c = await scope.db
    .selectFrom('ai_mcp.mcp_clients')
    .selectAll()
    .where('id', '=', clientId)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  if (!c) throw new ApiError('NOT_FOUND');
  if (c.status === 'revoked' && b.status !== undefined && b.status !== 'revoked')
    throw new ApiError('INVALID_TRANSITION', { detail: 'revoked' });
  const set = {
    ...(b.status !== undefined ? { status: b.status } : {}),
    ...Object.fromEntries(ACCESS_FIELDS.filter((f) => b[f] !== undefined).map((f) => [f, [...new Set(b[f])]])),
  };
  const row = Object.keys(set).length
    ? await scope.db.updateTable('ai_mcp.mcp_clients').set(set).where('id', '=', c.id).returningAll().executeTakeFirstOrThrow()
    : c;
  await writeAudit(scope, {
    action: 'mcp.client_updated',
    entityType: 'mcp_client',
    entityId: c.id,
    reason: b.reason,
    previous: JSON.stringify({
      status: c.status,
      scopes: c.allowed_scopes.length,
      resources: c.allowed_resources.length,
      tools: c.allowed_tools.length,
    }),
    next: JSON.stringify({
      status: row.status,
      scopes: row.allowed_scopes.length,
      resources: row.allowed_resources.length,
      tools: row.allowed_tools.length,
    }),
  });
  return row;
}

@Injectable()
@Operation('admin.mcp_client_update')
export class McpClientUpdateHandler implements OperationHandler {
  constructor(private readonly fourEyes: FourEyes) {}

  async handle(ctx: OperationContext<ClientUpdate>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const b = ctx.body;
    return ctx.tx(async (scope) => {
      const c = await scope.db
        .selectFrom('ai_mcp.mcp_clients')
        .selectAll()
        .where('id', '=', ctx.params.client_id!)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!c) throw new ApiError('NOT_FOUND');
      if (ctx.ifMatch !== c.version) throw new ApiError('VERSION_MISMATCH');
      const accessChange = ACCESS_FIELDS.some((f) => b[f] !== undefined);
      // 4EYES(scope, resource or tool changes): suspension and revocation never wait; reactivation does.
      if (accessChange || (b.status === 'active' && c.status !== 'active')) {
        const pending = await this.fourEyes.request(
          scope,
          s.userId,
          {
            opId: 'admin.mcp_client_update',
            targetType: 'mcp_client',
            targetId: c.id,
            payload: { ...b },
            summary: `MCP client ${c.name}: ${[b.status ? `status ${b.status}` : '', ...ACCESS_FIELDS.filter((f) => b[f]).map((f) => `${f} (${b[f]!.length})`)].filter(Boolean).join(', ')}`,
            reason: b.reason,
            requiredRole: 'platform_admin',
          },
          ctx.locale,
        );
        return { status: 202, body: pending };
      }
      return { body: toClient(await applyClientChange(scope, c.id, b)) };
    });
  }
}

type LogSearch = {
  mcp_client_id?: string;
  principal_id?: string;
  resource_or_tool_key?: string;
  policy_decision?: string;
  from: string;
  to: string;
  limit?: number;
};

@Injectable()
@Operation('admin.mcp_access_log_search')
export class McpAccessLogSearchHandler implements OperationHandler {
  async handle(ctx: OperationContext<LogSearch>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const b = ctx.body;
    const { from, to } = rangeOf(b);
    const limit = b.limit ?? 20;
    const after = (ctx.cursor as Position)?.id;
    const body = await ctx.tx(async (scope) => {
      let q = scope.db.selectFrom('ai_mcp.mcp_access_logs').selectAll().where('created_at', '>=', from).where('created_at', '<', to);
      if (b.mcp_client_id) q = q.where('mcp_client_id', '=', b.mcp_client_id);
      if (b.principal_id) q = q.where('principal_id', '=', b.principal_id);
      if (b.resource_or_tool_key) q = q.where('resource_or_tool_key', '=', b.resource_or_tool_key);
      if (b.policy_decision) q = q.where('policy_decision', '=', b.policy_decision);
      if (after) q = q.where('id', '<', after);
      const rows = await q
        .orderBy('id', 'desc')
        .limit(limit + 1)
        .execute();
      // The search itself is audited (40 admin.mcp_access_log_search AUD).
      await writeAudit(scope, {
        action: 'mcp.access_log_searched',
        entityType: 'mcp_access_log',
        entityId: s.userId,
        next: JSON.stringify({ ...b, cursor: undefined }).slice(0, 2000),
      });
      const page = rows.slice(0, limit);
      return ctx.page(page.map(toLog), rows.length > limit ? { id: page.at(-1)!.id } : null);
    });
    return { body };
  }
}

/** Moderators act on reported AI output: hidden outputs become internal (never shown again), restore makes them owner-only. */
async function applyToInsight(scope: TxScope, id: string, action: ContentAction): Promise<boolean> {
  const i = await scope.db
    .selectFrom('ai_mcp.ai_insights')
    .selectAll()
    .where('id', '=', id)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  if (!i) return false;
  if ((action === 'hide' || action === 'remove') && i.visibility !== 'internal') {
    await scope.db.updateTable('ai_mcp.ai_insights').set({ visibility: 'internal' }).where('id', '=', i.id).execute();
    return true;
  }
  if (action === 'restore' && i.visibility === 'internal' && (i.organization_id || i.owner_user_id)) {
    await scope.db.updateTable('ai_mcp.ai_insights').set({ visibility: 'owner_only' }).where('id', '=', i.id).execute();
    return true;
  }
  return false;
}

@Injectable()
export class AiMcpAdminRegistrations implements OnModuleInit {
  constructor(
    @Optional() private readonly executors?: FourEyesExecutors,
    @Optional() private readonly targets?: ModerationTargets,
  ) {}

  onModuleInit(): void {
    this.executors?.register(
      'admin.mcp_client_update',
      async (scope, c) => void (await applyClientChange(scope, c.targetId, c.payload as ClientUpdate)),
    );
    this.targets?.register('ai_output', {
      exists: async (scope, id) =>
        !!(await scope.db
          .selectFrom('ai_mcp.ai_insights')
          .select('id')
          .where('id', '=', id)
          .where('deleted_at', 'is', null)
          .executeTakeFirst()),
      snapshot: async (scope, id) => {
        const i = await scope.db.selectFrom('ai_mcp.ai_insights').selectAll().where('id', '=', id).executeTakeFirst();
        return i
          ? {
              type: 'ai_output',
              id: i.id,
              insight_type: i.insight_type,
              summary: i.summary,
              visibility: i.visibility,
              model_version: i.model_version,
            }
          : null;
      },
      subjectOrganization: async (scope, id) =>
        (await scope.db.selectFrom('ai_mcp.ai_insights').select('organization_id').where('id', '=', id).executeTakeFirst())
          ?.organization_id ?? null,
      apply: applyToInsight,
    });
  }
}
