// Response projections of the AI facade (40 §21.1). Internal columns
// (prompt keys, tool keys, client ids, input references, decided_by) never
// leave the server; insights are returned as data with their
// human_approval_status (SEC-AI-3).
import type { Selectable } from 'kysely';
import type { DB } from '#libs/db/index.js';
import { iso, isoOrNull } from '#libs/http-pipeline/index.js';
import type { L10n } from '#libs/i18n/index.js';
import type { Urgency } from '#libs/safety-check/index.js';

export type InsightRow = Selectable<DB['ai_mcp.ai_insights']>;
export type SuggestionRow = Selectable<DB['ai_mcp.ai_suggestions']>;
export type ApprovalRow = Selectable<DB['ai_mcp.approval_requests']>;
export type TriageRow = Selectable<DB['ai_mcp.triage_sessions']>;
export type HeatmapRow = Selectable<DB['ai_mcp.skill_heatmap_entries']>;

const ref = (type: string, id: string) => ({ type: type.slice(0, 40), id });
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export function toInsight(i: InsightRow) {
  const refs = Array.isArray(i.evidence_references) ? (i.evidence_references as { type: string; id: string }[]) : [];
  return {
    id: i.id,
    insight_type: i.insight_type,
    subject: ref(i.subject_entity_type, i.subject_entity_id),
    locale: i.locale,
    confidence_score: i.confidence_score,
    summary: i.summary,
    structured_payload: obj(i.structured_payload),
    evidence_references: refs.slice(0, 50).map((r) => ref(String(r.type), r.id)),
    safety_flags: i.safety_flags,
    visibility: i.visibility,
    human_approval_status: i.human_approval_status,
    model_version: i.model_version,
    created_at: iso(i.created_at),
    expires_at: isoOrNull(i.expires_at),
  };
}

export function toSuggestion(s: SuggestionRow) {
  return {
    id: s.id,
    insight_id: s.insight_id,
    target: ref(s.target_entity_type, s.target_entity_id),
    suggestion_text: s.suggestion_text,
    suggested_action: s.suggested_action,
    proposed_payload: obj(s.proposed_payload),
    status: s.status,
    decided_at: isoOrNull(s.decided_at),
  };
}

export function toApproval(a: ApprovalRow) {
  return {
    id: a.id,
    action_type: a.action_type,
    subject: ref(a.subject_entity_type, a.subject_entity_id),
    risk_level: a.risk_level,
    summary: a.summary,
    insight_id: a.insight_id,
    approver_role: a.approver_role,
    status: a.status,
    decision_reason: a.decision_reason,
    decided_at: isoOrNull(a.decided_at),
    created_at: iso(a.created_at),
  };
}

/** A stored turn (40 TriageTurn; `asks` = the clarifying question of an assistant turn, server-side only). */
export interface StoredTurn {
  role: 'user' | 'assistant';
  text: string;
  at: string;
  asks?: string | null;
  media_ids?: string[];
}

export const turnsOf = (t: TriageRow): StoredTurn[] => (Array.isArray(t.turns) ? (t.turns as unknown as StoredTurn[]) : []);

/** 40 SafetyBlock & { do_not_drive } from the session's server-side safety state. */
export function triageSafety(urgency: Urgency | null, safetyCritical: boolean) {
  const flag = safetyCritical || urgency === 'high';
  const level: 'none' | 'warning' | 'urgent' = safetyCritical ? 'urgent' : urgency === 'high' ? 'warning' : 'none';
  return {
    flag,
    level,
    message_i18n_key: level === 'none' ? null : `safety.banner.${level}`,
    urgent_help_available: level === 'urgent',
    do_not_drive: safetyCritical,
  };
}

export function toTriage(t: TriageRow, labels: Map<string, L10n>) {
  const turns = turnsOf(t);
  const node = (id: string) => (labels.has(id) ? { node_id: id, label: labels.get(id)! } : null);
  const nodes = (ids: readonly string[]) =>
    ids
      .map(node)
      .filter((x): x is { node_id: string; label: L10n } => !!x)
      .slice(0, 10);
  const last = turns.at(-1);
  const open = t.status === 'in_progress' || t.status === 'escalated_safety';
  return {
    id: t.id,
    vehicle_id: t.vehicle_id,
    issue_id: t.issue_id,
    locale: t.locale,
    turns: turns.slice(0, 40).map((x) => ({ role: x.role, text: x.text, at: x.at })),
    status: t.status,
    safety: triageSafety(t.urgency_level as Urgency | null, t.safety_critical),
    urgency_level: t.urgency_level,
    symptoms: nodes(t.symptom_node_ids),
    likely_systems: nodes(t.likely_system_node_ids),
    recommended_service: t.recommended_service_node_id ? node(t.recommended_service_node_id) : null,
    next_question: open && last?.role === 'assistant' ? (last.asks ?? null) : null,
    result_insight_id: t.result_insight_id,
    match_session_id: t.match_session_id,
    appointment_draft_id: t.appointment_draft_id,
  };
}

/** Node ids a triage view labels. */
export const triageNodeIds = (t: TriageRow): string[] => [
  ...t.symptom_node_ids,
  ...t.likely_system_node_ids,
  ...(t.recommended_service_node_id ? [t.recommended_service_node_id] : []),
];
