// ai-mcp's parts of the S8 platform flows (GD-29; recommendations S9):
// data subject requests (a user's Help Me sessions, personal insights,
// suggestions and approval requests are exported; erasure deletes sessions
// and personal suggestions and anonymizes personal insights, which the
// append-only evaluation records still reference), TriageSession retention
// (52 DataRetentionPolicy, 365 days, delete), taxonomy merges (triage and
// heatmap node references) and the ai_quality gauges.
import { Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import { sql, type RawBuilder } from 'kysely';
import { retentionCutoff, RetentionHandlers } from '#modules/admin/interface/admin.js';
import { MetricGauges } from '#modules/analytics/interface/analytics.js';
import { PersonalDataRegistry } from '#modules/identity/interface/identity.js';
import { TaxonomyReferences } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { turnsOf } from '../api/projections.js';

import type { TxScope } from '#libs/tenancy/index.js';

const count = async (q: RawBuilder<{ n: string }>, scope: TxScope): Promise<number> => Number((await q.execute(scope.db)).rows[0]?.n ?? 0);

@Injectable()
export class AiMcpRegistrations implements OnModuleInit {
  constructor(
    @Optional() private readonly personal?: PersonalDataRegistry,
    @Optional() private readonly retention?: RetentionHandlers,
    @Optional() private readonly taxonomyRefs?: TaxonomyReferences,
    @Optional() private readonly gauges?: MetricGauges,
  ) {}

  onModuleInit(): void {
    this.personal?.register('ai_mcp', {
      async export(scope, userId) {
        const sessions = await scope.db
          .selectFrom('ai_mcp.triage_sessions')
          .selectAll()
          .where('user_id', '=', userId)
          .where('deleted_at', 'is', null)
          .execute();
        const insights = await scope.db
          .selectFrom('ai_mcp.ai_insights')
          .select(['id', 'insight_type', 'subject_entity_type', 'summary', 'human_approval_status', 'created_at'])
          .where('owner_user_id', '=', userId)
          .where('organization_id', 'is', null)
          .where('deleted_at', 'is', null)
          .execute();
        const suggestions = await scope.db
          .selectFrom('ai_mcp.ai_suggestions')
          .select(['id', 'target_entity_type', 'suggestion_text', 'status', 'created_at'])
          .where('owner_user_id', '=', userId)
          .where('organization_id', 'is', null)
          .where('deleted_at', 'is', null)
          .execute();
        const approvals = await scope.db
          .selectFrom('ai_mcp.approval_requests')
          .select(['id', 'action_type', 'summary', 'status', 'created_at'])
          .where('requested_by_user_id', '=', userId)
          .where('deleted_at', 'is', null)
          .execute();
        return [
          {
            section: 'triage_sessions',
            records: sessions.map((t) => ({
              id: t.id,
              fields: {
                vehicle_id: t.vehicle_id,
                status: t.status,
                urgency_level: t.urgency_level,
                // The user's own words; assistant turns are AI output, exported with the insights.
                user_turns: turnsOf(t)
                  .filter((x) => x.role === 'user')
                  .map((x) => x.text)
                  .join(' | '),
                created_at: t.created_at.toISOString(),
              },
            })),
          },
          {
            section: 'ai_insights',
            records: insights.map((i) => ({
              id: i.id,
              fields: {
                insight_type: i.insight_type,
                subject_type: i.subject_entity_type,
                summary: i.summary,
                human_approval_status: i.human_approval_status,
                created_at: i.created_at.toISOString(),
              },
            })),
          },
          {
            section: 'ai_suggestions',
            records: suggestions.map((s) => ({
              id: s.id,
              fields: {
                target_type: s.target_entity_type,
                text: s.suggestion_text,
                status: s.status,
                created_at: s.created_at.toISOString(),
              },
            })),
          },
          {
            section: 'ai_approval_requests',
            records: approvals.map((a) => ({
              id: a.id,
              fields: { action_type: a.action_type, summary: a.summary, status: a.status, created_at: a.created_at.toISOString() },
            })),
          },
        ];
      },
      async erase(scope, userId) {
        let n = 0;
        n += Number((await scope.db.deleteFrom('ai_mcp.triage_sessions').where('user_id', '=', userId).executeTakeFirst()).numDeletedRows);
        n += Number(
          (
            await scope.db
              .deleteFrom('ai_mcp.ai_suggestions')
              .where('owner_user_id', '=', userId)
              .where('organization_id', 'is', null)
              .executeTakeFirst()
          ).numDeletedRows,
        );
        // Personal insights stay as unlinkable rows (append-only evaluation records reference them).
        n += Number(
          (
            await scope.db
              .updateTable('ai_mcp.ai_insights')
              .set({
                owner_user_id: null,
                visibility: 'internal',
                summary: '[erased]',
                structured_payload: null,
                evidence_references: '[]',
                input_references: '[]',
                deleted_at: new Date(),
                deletion_reason: 'data subject erasure',
              })
              .where('owner_user_id', '=', userId)
              .where('organization_id', 'is', null)
              .executeTakeFirst()
          ).numUpdatedRows,
        );
        // Organization approval requests remain the organization's records, without the requester.
        n += Number(
          (
            await scope.db
              .updateTable('ai_mcp.approval_requests')
              .set({ requested_by_user_id: null })
              .where('requested_by_user_id', '=', userId)
              .executeTakeFirst()
          ).numUpdatedRows,
        );
        return n;
      },
    });

    this.retention?.register('TriageSession', async (scope, p) => {
      const r = await scope.db.deleteFrom('ai_mcp.triage_sessions').where('created_at', '<', retentionCutoff(p)).executeTakeFirst();
      return Number(r.numDeletedRows);
    });

    // Merged nodes: triage references move; heatmap entries of the merged node expire (W10 rebuilds them).
    this.taxonomyRefs?.register('ai_mcp', async (scope, fromId, intoId) => {
      const t = await sql`UPDATE ai_mcp.triage_sessions
                             SET symptom_node_ids = array_replace(symptom_node_ids, ${fromId}::uuid, ${intoId}::uuid),
                                 likely_system_node_ids = array_replace(likely_system_node_ids, ${fromId}::uuid, ${intoId}::uuid),
                                 recommended_service_node_id = CASE WHEN recommended_service_node_id = ${fromId}::uuid
                                                                    THEN ${intoId}::uuid ELSE recommended_service_node_id END
                           WHERE ${fromId}::uuid = ANY (symptom_node_ids) OR ${fromId}::uuid = ANY (likely_system_node_ids)
                              OR recommended_service_node_id = ${fromId}::uuid`.execute(scope.db);
      const h = await scope.db
        .updateTable('ai_mcp.skill_heatmap_entries')
        .set({ status: 'expired' })
        .where('taxonomy_node_id', '=', fromId)
        .where('status', '=', 'active')
        .executeTakeFirst();
      return Number(t.numAffectedRows ?? 0) + Number(h.numUpdatedRows);
    });

    const since = sql`now() - interval '1 day'`;
    this.gauges?.register('gauge.ai_suggestions_pending', (scope) =>
      count(sql<{ n: string }>`SELECT count(*) AS n FROM ai_mcp.ai_suggestions WHERE status = 'pending' AND deleted_at IS NULL`, scope),
    );
    for (const [key, types] of [
      ['gauge.ai_feedback_accepted', ['accepted', 'accepted_with_edits']],
      ['gauge.ai_feedback_rejected', ['rejected', 'corrected']],
      ['gauge.ai_hallucination_reports', ['hallucination_report']],
    ] as const)
      this.gauges?.register(key, (scope) =>
        count(
          sql<{ n: string }>`SELECT count(*) AS n FROM ai_mcp.ai_evaluation_records
                              WHERE feedback_type = ANY (${[...types]}::text[]) AND created_at >= ${since}`,
          scope,
        ),
      );
  }
}
