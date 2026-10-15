// AiReferences (interface/ai.ts): other modules resolve the AI records their
// rows cite, in the caller's transaction. RLS limits insights to the caller's
// organization or the caller (owner_read; internal insights never), triage
// sessions to their user (self_all).
import { Injectable } from '@nestjs/common';
import type { InsightType } from '#libs/contract/generated/enums.js';
import type { Urgency } from '#libs/safety-check/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { AiStore } from '../infrastructure/ai-store.js';
import { AiReferences, type TriageFacts, type UsableInsight } from '../interface/ai.js';

@Injectable()
export class AiReferencesImpl extends AiReferences {
  constructor(private readonly store: AiStore) {
    super();
  }

  async activeMcpClient(clientId: string): Promise<boolean> {
    const c = await this.store.run(({ db }) =>
      db
        .selectFrom('ai_mcp.mcp_clients')
        .select('id')
        .where('id', '=', clientId)
        .where('status', '=', 'active')
        .where('deleted_at', 'is', null)
        .executeTakeFirst(),
    );
    return !!c;
  }

  async usable(
    scope: TxScope,
    insightId: string,
    o: { types: readonly InsightType[]; subject?: { type: string; id: string } },
  ): Promise<UsableInsight | null> {
    const i = await scope.db
      .selectFrom('ai_mcp.ai_insights')
      .selectAll()
      .where('id', '=', insightId)
      .where('deleted_at', 'is', null)
      .where('visibility', '<>', 'internal')
      .executeTakeFirst();
    if (!i || !o.types.includes(i.insight_type as InsightType) || i.human_approval_status === 'rejected') return null;
    if (i.expires_at && new Date(i.expires_at).getTime() < Date.now()) return null;
    if (o.subject && (i.subject_entity_type !== o.subject.type || i.subject_entity_id !== o.subject.id)) return null;
    return {
      id: i.id,
      insightType: i.insight_type as InsightType,
      subject: { type: i.subject_entity_type, id: i.subject_entity_id },
      organizationId: i.organization_id,
      ownerUserId: i.owner_user_id,
      summary: i.summary,
      payload: (i.structured_payload as Record<string, unknown> | null) ?? null,
      humanApprovalStatus: i.human_approval_status as UsableInsight['humanApprovalStatus'],
    };
  }

  async approveUse(scope: TxScope, insightId: string): Promise<void> {
    await scope.db
      .updateTable('ai_mcp.ai_insights')
      .set({ human_approval_status: 'approved' })
      .where('id', '=', insightId)
      .where('human_approval_status', '=', 'pending')
      .execute();
  }

  async awaitingApproval(scope: TxScope, insightId: string): Promise<boolean> {
    const a = await scope.db
      .selectFrom('ai_mcp.approval_requests')
      .select('id')
      .where('insight_id', '=', insightId)
      .where('status', 'in', ['pending', 'rejected'])
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return !!a;
  }

  async triage(scope: TxScope, sessionId: string): Promise<TriageFacts | null> {
    const t = await scope.db
      .selectFrom('ai_mcp.triage_sessions as t')
      .leftJoin('ai_mcp.ai_insights as i', (j) => j.onRef('i.id', '=', 't.result_insight_id').on('i.visibility', '<>', 'internal'))
      .selectAll('t')
      .select('i.summary as insight_summary')
      .where('t.id', '=', sessionId)
      .where('t.deleted_at', 'is', null)
      .executeTakeFirst();
    if (!t) return null;
    return {
      id: t.id,
      vehicleId: t.vehicle_id,
      issueId: t.issue_id,
      status: t.status as TriageFacts['status'],
      urgency: (t.urgency_level as Urgency | null) ?? null,
      safetyCritical: t.safety_critical,
      symptomNodeIds: t.symptom_node_ids,
      likelySystemNodeIds: t.likely_system_node_ids,
      recommendedServiceNodeId: t.recommended_service_node_id,
      resultInsightId: t.insight_summary ? t.result_insight_id : null,
      summary: t.insight_summary ?? null,
    };
  }

  async linkAppointment(scope: TxScope, sessionId: string, appointmentId: string): Promise<void> {
    await scope.db.updateTable('ai_mcp.triage_sessions').set({ appointment_draft_id: appointmentId }).where('id', '=', sessionId).execute();
  }
}
