// AI workers of the worker deployable (41 §2.4):
//   W9  ai-insight-generator: §21.3 jobs (AiFeatureRunner, queue ai.insight)
//       and imports that asked for AI normalization (vendor.inventory.imported).
//   W10 skill-heatmap: SkillHeatmapEntry per provider from 54 §2.3, rule-based
//       (no model): numbers from the capability levels, rebuilt on completed
//       appointments, published reviews and profiles, and nightly.
//   W11 fraud-detection: rule-based review pattern checks that only open
//       moderation cases (52 ModerationCase: AI flags only open cases).
//   W13 mcp-audit-logger: persists the gateway's McpAccessLog records and
//       warns on denied calls.
//   W14 embedding-indexer: skeleton; semantic search (search.semantic.enabled)
//       needs an embedding model behind the MCP port, so lite mode indexes
//       nothing (next iteration).
import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConsentChecker } from '#libs/consent-gate/index.js';
import { FlagService } from '#libs/flags/index.js';
import { ScheduledRule } from '#libs/jobs/index.js';
import type { Logger } from '#libs/observability/index.js';
import type { EventEnvelope, QueuedJob } from '#libs/infra/index.js';
import { EventConsumer } from '#libs/outbox/index.js';
import { InjectLogger } from '#libs/runtime/index.js';
import { TxRunner, type TxScope } from '#libs/tenancy/index.js';
import { ModerationIntake } from '#modules/admin/interface/admin.js';
import { ProviderCapabilities, type CapabilityRecord } from '#modules/organization/interface/provider-capabilities.js';
import { TOOLS } from '../domain/tools.js';
import { AiStore } from '../infrastructure/ai-store.js';
import { AiContextSources } from '../interface/ai.js';
import { AiFeatureRunner } from './features.js';
import type { AccessLogRecord } from './gateway.js';

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

// ------------------------------------------------------------------ W13

@Injectable()
export class McpAuditLogger {
  constructor(
    private readonly tx: TxRunner,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  async persist(job: QueuedJob): Promise<void> {
    const r = job.data as unknown as AccessLogRecord;
    await this.tx.run({ actorType: 'system' }, ({ db }) =>
      db
        .insertInto('ai_mcp.mcp_access_logs')
        .values({ ...r, created_at: new Date(r.created_at) })
        .onConflict((oc) => oc.doNothing())
        .execute(),
    );
    if (r.policy_decision === 'denied')
      this.logger.warn(
        { mcp_client_id: r.mcp_client_id, tool: r.resource_or_tool_key, principal_type: r.principal_type },
        'MCP call denied',
      );
  }
}

// ------------------------------------------------------------------ W9 events

/** Imports that asked for AI normalization (52 InventoryImportBatch.ai_normalization_requested). */
@Injectable()
export class ImportNormalizationConsumer extends EventConsumer {
  readonly name = 'ai.import_normalization';
  readonly subjects = ['vendor.inventory.imported'];

  constructor(
    private readonly runner: AiFeatureRunner,
    private readonly consents: ConsentChecker,
    private readonly flags: FlagService,
    private readonly tx: TxRunner,
    @InjectLogger() private readonly logger: Logger,
  ) {
    super();
  }

  async handle(e: EventEnvelope): Promise<void> {
    const p = e.payload as Record<string, unknown>;
    const orgId = str(p.vendor_organization_id);
    const userId = str(p.requested_by_user_id);
    if (!p.ai_normalization_requested || !orgId || !userId || Number(p.created_count ?? 0) + Number(p.updated_count ?? 0) === 0) return;
    if (!(await this.flags.isEnabled('vendor.ai_import.enabled', { orgId }))) return;
    const consented = await this.tx.run({ actorType: 'system' }, (scope) =>
      this.consents.isGranted(scope, { consentType: 'vendor_inventory_ai_use', subject: { type: 'organization', id: orgId } }),
    );
    if (!consented) return;
    const out = await this.runner.execute(
      'ai.inventory_normalize',
      { userId, orgId, role: null },
      { import_batch_id: e.aggregateId },
      'en',
      e.eventId,
    );
    if ('errorCode' in out) this.logger.info({ batch: e.aggregateId, error: out.errorCode }, 'AI normalization of an import skipped');
  }
}

// ------------------------------------------------------------------ W10

const LEVEL: Record<string, number> = { self_declared: 0, low_evidence: 1, moderate_evidence: 2, strong_evidence: 3, verified_expert: 4 };
type Scope = 'brand' | 'model' | 'series' | 'service_system' | 'service_task';

interface Cell {
  scope: Scope;
  nodeId: string;
  level: number;
  score: number;
}

/** 54 §2.3 classification; without a category rating or local demand the level decides (DI, S9). */
export function classify(level: number, trend: 'rising' | 'stable' | 'declining' | null): 'strong' | 'emerging' | 'weak' | 'opportunity' {
  if (level >= 3) return 'strong';
  if (level >= 1 && trend === 'rising') return 'emerging';
  if (level <= 1) return 'weak';
  return 'emerging';
}

function cells(caps: CapabilityRecord[]): Cell[] {
  const out = new Map<string, Cell>();
  const add = (scope: Scope, nodeId: string | null, c: CapabilityRecord) => {
    if (!nodeId) return;
    const key = `${scope}|${nodeId}`;
    const level = LEVEL[c.confidenceLevel] ?? 0;
    const score = Math.min(100, Math.max(0, c.confidenceScore / 2));
    const cur = out.get(key);
    if (!cur || level > cur.level || (level === cur.level && score > cur.score)) out.set(key, { scope, nodeId, level, score });
  };
  for (const c of caps) {
    add('service_system', c.serviceSystemNodeId, c);
    add('service_task', c.serviceTaskNodeId, c);
    add('brand', c.brandNodeId, c);
    add('model', c.modelNodeId, c);
    add('series', c.seriesNodeId, c);
  }
  return [...out.values()].slice(0, 500);
}

@Injectable()
export class SkillHeatmapBuilder {
  constructor(
    private readonly tx: TxRunner,
    private readonly store: AiStore,
    private readonly capabilities: ProviderCapabilities,
    private readonly consents: ConsentChecker,
  ) {}

  /** Rebuilds one provider's heatmap; hides it without the provider_analytics_ai_use consent. Returns the entry count. */
  async rebuild(orgId: string): Promise<number> {
    const prep = await this.tx.run({ actorType: 'system' }, async (scope) => {
      const consented = await this.consents.isGranted(scope, {
        consentType: 'provider_analytics_ai_use',
        subject: { type: 'organization', id: orgId },
      });
      if (!consented) {
        await scope.db
          .updateTable('ai_mcp.skill_heatmap_entries')
          .set({ status: 'hidden' })
          .where('provider_organization_id', '=', orgId)
          .where('status', '=', 'active')
          .execute();
        return null;
      }
      const previous = await scope.db
        .selectFrom('ai_mcp.skill_heatmap_entries')
        .select(['scope_type', 'taxonomy_node_id', 'score'])
        .where('provider_organization_id', '=', orgId)
        .where('status', 'in', ['active', 'hidden'])
        .execute();
      return { caps: await this.capabilities.forProviders(scope, [orgId]), previous };
    });
    if (!prep) return 0;
    const grid = cells(prep.caps);
    const before = new Map(prep.previous.map((p) => [`${p.scope_type}|${p.taxonomy_node_id}`, Number(p.score)]));
    const pipeline = await this.store.run(({ db }) =>
      db.selectFrom('ai_mcp.mcp_clients').select('id').where('name', '=', 'ai_pipelines').executeTakeFirst(),
    );
    const insight = await this.store.run(({ db }) =>
      db
        .insertInto('ai_mcp.ai_insights')
        .values({
          insight_type: 'skill_heatmap',
          subject_entity_type: 'organization',
          subject_entity_id: orgId,
          organization_id: orgId,
          source_tool_key: `tool:${TOOLS.skillHeatmap.key}`,
          source_tool_version: TOOLS.skillHeatmap.version,
          source_client_id: pipeline?.id ?? null,
          model_version: 'rules-54.2.3',
          locale: 'en',
          confidence_score: null,
          summary: `Skill heatmap: ${grid.length} entries from capability evidence (54 §2.3).`,
          structured_payload: JSON.stringify({ entry_count: grid.length, rule_version: '54.2.3' }),
          visibility: 'owner_only',
        })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    await this.tx.run({ actorType: 'system' }, async ({ db }) => {
      await db
        .updateTable('ai_mcp.skill_heatmap_entries')
        .set({ status: 'expired' })
        .where('provider_organization_id', '=', orgId)
        .where('status', 'in', ['active', 'hidden'])
        .execute();
      if (grid.length === 0) return;
      await db
        .insertInto('ai_mcp.skill_heatmap_entries')
        .values(
          grid.map((c) => {
            const prev = before.get(`${c.scope}|${c.nodeId}`);
            const trend =
              prev === undefined
                ? null
                : c.score >= prev * 1.2 && c.score > prev
                  ? 'rising'
                  : c.score <= prev * 0.8
                    ? 'declining'
                    : 'stable';
            return {
              provider_organization_id: orgId,
              scope_type: c.scope,
              taxonomy_node_id: c.nodeId,
              score: c.score.toFixed(2),
              confidence: c.level >= 3 ? 'high' : c.level === 2 ? 'moderate' : 'low',
              classification: classify(c.level, trend),
              trend,
              evidence_summary: `Level ${c.level} from verified evidence.`,
              insight_id: insight.id,
            };
          }),
        )
        .execute();
    });
    return grid.length;
  }

  /** Providers whose heatmap exists (nightly refresh). */
  async known(scope: TxScope): Promise<string[]> {
    const rows = await scope.db
      .selectFrom('ai_mcp.skill_heatmap_entries')
      .select('provider_organization_id')
      .distinct()
      .where('status', 'in', ['active', 'hidden'])
      .limit(10_000)
      .execute();
    return rows.map((r) => r.provider_organization_id);
  }
}

@Injectable()
export class SkillHeatmapConsumer extends EventConsumer {
  readonly name = 'ai.skill_heatmap';
  readonly subjects = ['appointment.completed', 'review.published', 'provider.profile.published'];

  constructor(private readonly builder: SkillHeatmapBuilder) {
    super();
  }

  async handle(e: EventEnvelope): Promise<void> {
    const p = e.payload as Record<string, unknown>;
    const orgId =
      e.type === 'appointment.completed'
        ? str(p.provider_organization_id)
        : e.type === 'review.published'
          ? p.subject_type === 'provider' || p.subject_type === undefined
            ? str(p.subject_organization_id)
            : null
          : e.aggregateId;
    if (orgId) await this.builder.rebuild(orgId);
  }
}

@Injectable()
export class SkillHeatmapNightlyRule extends ScheduledRule {
  readonly name = 'ai.skill_heatmap_nightly';
  readonly everyMs = 24 * 3_600_000;

  constructor(
    private readonly builder: SkillHeatmapBuilder,
    private readonly tx: TxRunner,
  ) {
    super();
  }

  async run(): Promise<number> {
    const orgs = await this.tx.run({ actorType: 'system' }, (scope) => this.builder.known(scope));
    let n = 0;
    for (const org of orgs) n += await this.builder.rebuild(org);
    return n;
  }
}

// ------------------------------------------------------------------ W11

/** Rule-based review patterns over the subject's recent reviews (trust facts, no model). */
export function reviewSignals(reviews: { id: string; created_at: string; overall_rating: number; text_hash: string | null }[]): {
  reviewIds: string[];
  signals: ('repeated_text' | 'rating_spike')[];
} {
  const flagged = new Set<string>();
  const signals: ('repeated_text' | 'rating_spike')[] = [];
  const byText = new Map<string, string[]>();
  for (const r of reviews) if (r.text_hash) byText.set(r.text_hash, [...(byText.get(r.text_hash) ?? []), r.id]);
  const repeated = [...byText.values()].filter((ids) => ids.length >= 2).flat();
  if (repeated.length) {
    signals.push('repeated_text');
    for (const id of repeated) flagged.add(id);
  }
  // Five or more reviews within 24 hours with the same extreme rating.
  const sorted = [...reviews].sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const rating of [1, 5]) {
    const same = sorted.filter((r) => r.overall_rating === rating);
    for (let i = 0; i + 4 < same.length; i++)
      if (Date.parse(same[i + 4]!.created_at) - Date.parse(same[i]!.created_at) <= 86_400_000) {
        if (!signals.includes('rating_spike')) signals.push('rating_spike');
        for (const r of same.slice(i, i + 5)) flagged.add(r.id);
      }
  }
  return { reviewIds: [...flagged].slice(0, 50), signals };
}

@Injectable()
export class FraudDetectionConsumer extends EventConsumer {
  readonly name = 'ai.fraud_detection';
  readonly subjects = ['review.created'];

  constructor(
    private readonly tx: TxRunner,
    private readonly store: AiStore,
    private readonly sources: AiContextSources,
    private readonly intake: ModerationIntake,
  ) {
    super();
  }

  async handle(e: EventEnvelope): Promise<void> {
    const orgId = str((e.payload as Record<string, unknown>).subject_organization_id);
    if (!orgId) return;
    const facts = await this.tx.run({ actorType: 'system' }, (scope) =>
      this.sources.source('review.pattern_facts')(scope, { userId: '00000000-0000-7000-8000-000000000000', orgId, role: null }, {}),
    );
    const found = reviewSignals((facts?.reviews ?? []) as Parameters<typeof reviewSignals>[0]);
    if (found.signals.length === 0) return;
    const pipeline = await this.store.run(({ db }) =>
      db.selectFrom('ai_mcp.mcp_clients').select('id').where('name', '=', 'ai_pipelines').executeTakeFirst(),
    );
    const insight = await this.store.run(({ db }) =>
      db
        .insertInto('ai_mcp.ai_insights')
        .values({
          insight_type: 'fraud_flag',
          subject_entity_type: 'organization',
          subject_entity_id: orgId,
          organization_id: orgId,
          source_tool_key: `tool:${TOOLS.fraudPattern.key}`,
          source_tool_version: TOOLS.fraudPattern.version,
          source_client_id: pipeline?.id ?? null,
          model_version: 'rules-w11-1',
          locale: 'en',
          confidence_score: 70,
          summary: `Review pattern check: ${found.signals.join(', ')} on ${found.reviewIds.length} review(s).`,
          structured_payload: JSON.stringify({ review_ids: found.reviewIds, signals: found.signals }),
          evidence_references: JSON.stringify(found.reviewIds.map((id) => ({ type: 'review', id }))),
          visibility: 'internal',
        })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    await this.tx.run({ actorType: 'system' }, async (scope) => {
      for (const id of found.reviewIds)
        await this.intake.open(scope, {
          targetType: 'review',
          targetId: id,
          reason: 'fake',
          severity: 'medium',
          riskScore: 70,
          insightId: insight.id,
        });
    });
  }
}

// ------------------------------------------------------------------ W14

/** Content changes that would be re-embedded (52 Embedding; tenant-scoped, content_hash). */
@Injectable()
export class EmbeddingIndexerConsumer extends EventConsumer {
  readonly name = 'ai.embedding_indexer';
  readonly subjects = ['provider.profile.published', 'review.published', 'qna.question.created', 'portfolio.published'];

  constructor(
    private readonly flags: FlagService,
    @InjectLogger() private readonly logger: Logger,
  ) {
    super();
  }

  async handle(e: EventEnvelope): Promise<void> {
    if (!(await this.flags.isEnabled('search.semantic.enabled'))) return;
    // No embedding model behind the lite MCP port: the indexer records what it would embed (DI, next iteration).
    this.logger.debug(
      { entity: e.aggregateType, ref: createHash('sha256').update(`${e.aggregateType}:${e.aggregateId}`).digest('hex').slice(0, 16) },
      'embedding skipped: no embedding model in lite mode',
    );
  }
}
