// In-process MCP gateway of lite mode (41 §1 D6, 53 §18.3 tool invocation,
// GD-35). Every AI tool call of the facade and the AI workers runs here:
//   1. policy pre-checks: the operation's AI flag and the kill switch
//      (SEC-AI-6, re-checked at run time for queued jobs), the internal MCP
//      client's registry row (active, this environment, tool allowed) and
//      tenancy (an organization principal only stores output for itself,
//      SEC-AI-4); consent is checked by the facade in the caller's
//      transaction before it calls (CNS) and passed here for the log;
//   2. the McpClientPort call with a time limit;
//   3. SEC-AI-5 validation of the structured payload and proposed
//      suggestions (malformed output is discarded and logged);
//   4. storage as AiInsight (+ AiSuggestion rows) by carpal_ai and the
//      ai.insight.generated event;
//   5. one McpAccessLog record per call, handed to W13 (mcp-audit-logger)
//      on the mcp.access_log queue, also for denied and failed calls.
// Any refusal or failure surfaces as 503 AI_UNAVAILABLE: the non-AI path of
// the calling operation always remains (53 §16.2).
import { Injectable } from '@nestjs/common';
import type { Selectable } from 'kysely';
import type { CarpalConfig } from '#libs/config/index.js';
import { ApiError } from '#libs/contract/index.js';
import type { InsightType } from '#libs/contract/generated/enums.js';
import { uuidv7 } from '#libs/crypto/index.js';
import type { DB } from '#libs/db/index.js';
import { FlagService } from '#libs/flags/index.js';
import type { Locale } from '#libs/i18n/index.js';
import type { Infra } from '#libs/infra/index.js';
import type { Logger } from '#libs/observability/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import { InjectConfig, InjectInfra, InjectLogger } from '#libs/runtime/index.js';
import { INSIGHT_TTL_DAYS, INTERNAL_ONLY, PUBLIC_AFTER_APPROVAL, registryKey, type McpClientName, type ToolSpec } from '../domain/tools.js';
import { suggestionPayloadErrors, validInsightPayload } from '../domain/payloads.js';
import { AiStore } from '../infrastructure/ai-store.js';
import { McpClientPort, McpUnavailableError, type ToolOutput, type ToolPrincipal } from './mcp-port.js';

export type InsightRow = Selectable<DB['ai_mcp.ai_insights']>;
export type SuggestionRow = Selectable<DB['ai_mcp.ai_suggestions']>;
export type ApprovalRow = Selectable<DB['ai_mcp.approval_requests']>;

export const MCP_ACCESS_LOG_QUEUE = 'mcp.access_log';

/** One McpAccessLog row as handed to W13 (52 McpAccessLog). */
export interface AccessLogRecord {
  id: string;
  created_at: string;
  mcp_client_id: string;
  principal_type: 'user' | 'organization' | 'system';
  principal_id: string;
  organization_id: string | null;
  operation_type: 'resource_read' | 'tool_invoke';
  resource_or_tool_key: string;
  tool_version: string | null;
  risk_level: string;
  context_resources: string[];
  context_entity_type: string | null;
  context_entity_id: string | null;
  consent_reference_id: string | null;
  redactions_applied: string[];
  policy_decision: 'allowed' | 'denied' | 'consent_required' | 'approval_required' | 'rate_limited' | 'error';
  approval_request_id: string | null;
  output_insight_id: string | null;
  model_version: string | null;
  result_status: 'success' | 'failure' | 'partial';
  latency_ms: number | null;
  request_id: string;
}

export interface StoreAs {
  subject: { type: string; id: string };
  organizationId: string | null;
  ownerUserId: string | null;
  /** Default: internal for INTERNAL_ONLY types, public_after_approval for PUBLIC_AFTER_APPROVAL, else owner_only. */
  visibility?: 'internal' | 'owner_only' | 'public_after_approval';
  /** Who asked (event payload, approval requests). */
  requestedByUserId: string | null;
  /** The 202 Job this insight answers, if any. */
  jobId?: string | null;
}

export interface InvokeRequest {
  tool: ToolSpec;
  client: McpClientName;
  principal: ToolPrincipal;
  locale: Locale;
  insightType: InsightType;
  requestId: string;
  /** FLAG(key) of the operation, re-checked here (kill switch). */
  flag?: string;
  context: Record<string, unknown>;
  /** res:* keys of the context package (logged as context_resources). */
  resources: string[];
  userText?: readonly string[];
  contextEntity?: { type: string; id: string };
  consentReferenceId?: string | null;
  /** Store the output as an AiInsight (omit for intermediate output such as a triage turn). */
  store?: StoreAs;
}

export interface InvokeResult {
  output: ToolOutput;
  insight: InsightRow | null;
  suggestions: SuggestionRow[];
}

const unavailable = (detail: string) => new ApiError('AI_UNAVAILABLE', { retryAfterMs: 60_000, detail });

@Injectable()
export class McpGateway {
  constructor(
    private readonly port: McpClientPort,
    private readonly store: AiStore,
    private readonly flags: FlagService,
    @InjectConfig() private readonly config: CarpalConfig,
    @InjectInfra() private readonly infra: Infra,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  async invoke(r: InvokeRequest): Promise<InvokeResult> {
    if (r.flag)
      await this.flags.require(r.flag, {
        ...(r.principal.type === 'user' ? { userId: r.principal.id } : {}),
        ...(r.principal.organizationId ? { orgId: r.principal.organizationId } : {}),
      });
    const client = await this.store.run(
      ({ db }) =>
        db.selectFrom('ai_mcp.mcp_clients').selectAll().where('name', '=', r.client).where('deleted_at', 'is', null).executeTakeFirst(),
      r.requestId,
    );
    const started = Date.now();
    const log = (o: Partial<AccessLogRecord> & Pick<AccessLogRecord, 'policy_decision' | 'result_status'>) => {
      if (client) this.#log(r, client.id, started, o);
      else this.logger.error({ client: r.client, tool: r.tool.key }, 'MCP client missing from the registry: call not logged');
    };
    if (
      !client ||
      client.status !== 'active' ||
      client.environment !== this.config.env ||
      !client.allowed_tools.includes(registryKey(r.tool))
    ) {
      log({ policy_decision: 'denied', result_status: 'failure' });
      throw unavailable(`client ${r.client} may not call ${r.tool.key}`);
    }
    // SEC-AI-4: output of an organization principal belongs to that organization only.
    if (r.store && r.principal.organizationId && r.store.organizationId !== r.principal.organizationId) {
      log({ policy_decision: 'denied', result_status: 'failure' });
      throw unavailable('cross-tenant output refused');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.mcp.timeoutMs);
    let output: ToolOutput;
    try {
      output = await Promise.race([
        this.port.invoke({
          tool: r.tool,
          client: r.client,
          principal: r.principal,
          locale: r.locale,
          insightType: r.insightType,
          context: r.context,
          userText: r.userText ?? [],
          signal: controller.signal,
        }),
        new Promise<never>((_, reject) =>
          controller.signal.addEventListener('abort', () => reject(new McpUnavailableError('tool call timed out')), { once: true }),
        ),
      ]);
    } catch (err) {
      log({ policy_decision: 'error', result_status: 'failure' });
      if (!(err instanceof McpUnavailableError)) this.logger.error({ err, tool: r.tool.key }, 'MCP tool call failed');
      throw unavailable(`tool ${r.tool.key} failed`);
    } finally {
      clearTimeout(timer);
    }

    // SEC-AI-5: malformed output is discarded and logged.
    const badSuggestion = output.suggestions.find((s) => suggestionPayloadErrors(s.target.type, s.payload, '').length > 0);
    if (!validInsightPayload(r.insightType, output.payload) || badSuggestion || !output.summary.trim()) {
      log({ policy_decision: 'allowed', result_status: 'failure', model_version: output.modelVersion });
      this.logger.warn({ tool: r.tool.key, insight_type: r.insightType }, 'AI output failed validation and was discarded');
      throw unavailable(`tool ${r.tool.key} returned malformed output`);
    }
    if (!r.store) {
      log({ policy_decision: 'allowed', result_status: 'success', model_version: output.modelVersion });
      return { output, insight: null, suggestions: [] };
    }

    const s = r.store;
    const visibility =
      s.visibility ??
      (INTERNAL_ONLY.has(r.insightType) ? 'internal' : PUBLIC_AFTER_APPROVAL.has(r.insightType) ? 'public_after_approval' : 'owner_only');
    const ttl = INSIGHT_TTL_DAYS[r.insightType];
    const { insight, suggestions } = await this.store.run(async (scope) => {
      const insight = await scope.db
        .insertInto('ai_mcp.ai_insights')
        .values({
          insight_type: r.insightType,
          subject_entity_type: s.subject.type,
          subject_entity_id: s.subject.id,
          organization_id: s.organizationId,
          owner_user_id: s.ownerUserId,
          input_references: JSON.stringify(r.contextEntity ? [r.contextEntity] : []),
          source_tool_key: `tool:${r.tool.key}`,
          source_tool_version: r.tool.version,
          source_client_id: client.id,
          prompt_key: output.promptKey,
          prompt_version: output.promptVersion,
          model_version: output.modelVersion,
          locale: r.locale,
          confidence_score: output.confidence,
          summary: output.summary,
          structured_payload: output.payload === null ? null : JSON.stringify(output.payload),
          evidence_references: JSON.stringify(output.evidence.slice(0, 50)),
          safety_flags: output.safetyFlags,
          visibility,
          human_approval_status: visibility === 'public_after_approval' ? 'pending' : 'not_required',
          expires_at: ttl ? new Date(Date.now() + ttl * 86_400_000) : null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const suggestions = output.suggestions.length
        ? await scope.db
            .insertInto('ai_mcp.ai_suggestions')
            .values(
              output.suggestions.slice(0, 500).map((g) => ({
                insight_id: insight.id,
                target_entity_type: g.target.type,
                target_entity_id: g.target.id,
                organization_id: s.organizationId,
                owner_user_id: s.organizationId ? null : s.ownerUserId,
                suggestion_text: g.text.slice(0, 2000),
                suggested_action: g.action,
                proposed_payload: g.payload === null ? null : JSON.stringify(g.payload),
              })),
            )
            .returningAll()
            .execute()
        : [];
      await publishEvent(scope, {
        type: 'ai.insight.generated',
        aggregateType: 'ai_insight',
        aggregateId: insight.id,
        payload: {
          insight_type: insight.insight_type,
          subject_type: insight.subject_entity_type,
          subject_id: insight.subject_entity_id,
          organization_id: insight.organization_id,
          owner_user_id: insight.owner_user_id,
          requested_by_user_id: s.requestedByUserId,
          job_id: s.jobId ?? null,
          suggestion_count: suggestions.length,
          visibility: insight.visibility,
        },
      });
      return { insight, suggestions };
    }, r.requestId);
    log({ policy_decision: 'allowed', result_status: 'success', model_version: output.modelVersion, output_insight_id: insight.id });
    return { output, insight, suggestions };
  }

  /** Records a policy refusal the facade decided itself (e.g. a missing consent) in the MCP access log. */
  async refused(
    r: Omit<InvokeRequest, 'store' | 'insightType' | 'locale' | 'context'>,
    decision: 'consent_required' | 'denied',
  ): Promise<void> {
    const client = await this.store.run(
      ({ db }) =>
        db.selectFrom('ai_mcp.mcp_clients').select('id').where('name', '=', r.client).where('deleted_at', 'is', null).executeTakeFirst(),
      r.requestId,
    );
    if (client)
      this.#log({ ...r, insightType: 'triage_summary', locale: 'en', context: {} }, client.id, Date.now(), {
        policy_decision: decision,
        result_status: 'failure',
      });
  }

  #log(
    r: InvokeRequest,
    clientId: string,
    started: number,
    o: Partial<AccessLogRecord> & Pick<AccessLogRecord, 'policy_decision' | 'result_status'>,
  ): void {
    const record: AccessLogRecord = {
      id: uuidv7(),
      created_at: new Date().toISOString(),
      mcp_client_id: clientId,
      principal_type: r.principal.type,
      principal_id: r.principal.id,
      organization_id: r.principal.organizationId,
      operation_type: 'tool_invoke',
      resource_or_tool_key: `tool:${r.tool.key}`,
      tool_version: r.tool.version,
      risk_level: r.tool.risk,
      context_resources: r.resources.slice(0, 50),
      context_entity_type: r.contextEntity?.type.slice(0, 60) ?? null,
      context_entity_id: r.contextEntity?.id ?? null,
      consent_reference_id: r.consentReferenceId ?? null,
      // User text travels as delimited data (SEC-AI-2); the context package carries no contact data.
      redactions_applied: r.userText?.length ? ['user_text_as_data'] : [],
      approval_request_id: null,
      output_insight_id: null,
      model_version: null,
      latency_ms: Math.min(600_000, Date.now() - started),
      request_id: r.requestId.slice(0, 64),
      ...o,
    };
    void this.infra.jobs
      .enqueue(MCP_ACCESS_LOG_QUEUE, { jobId: record.id, data: record as unknown as Record<string, unknown> })
      .catch((err: unknown) => {
        this.logger.error({ err }, 'MCP access log record could not be queued');
      });
  }
}
