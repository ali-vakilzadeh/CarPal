// MCP tools the API facade calls (53 §4 naming, §5 risk levels, §19 client
// profiles; the seeded ai_mcp.mcp_clients rows of Docs/43 §22.5). Every
// facade operation names the internal client it acts through, the tool and
// the risk level the gateway logs; the gateway refuses a tool the client's
// registry row does not allow (`tool:<key>@<version>`).
import type { InsightType, McpRiskLevel } from '#libs/contract/generated/enums.js';

export type McpClientName = 'consumer_assistant' | 'provider_assistant' | 'vendor_assistant' | 'fleet_assistant' | 'ai_pipelines';

export interface ToolSpec {
  /** tool:<domain>.<action> without the prefix, e.g. "triage.classify_symptom". */
  key: string;
  version: string;
  risk: McpRiskLevel;
}

const tool = (key: string, risk: McpRiskLevel): ToolSpec => ({ key, version: '1', risk });

/** 53 §9 tool catalog: the tools of the MVP facade. */
export const TOOLS = {
  triageClassify: tool('triage.classify_symptom', 'personalized_read'),
  triageSummary: tool('triage.create_summary', 'draft_creation'),
  vehicleFields: tool('vehicle.extract_fields', 'draft_creation'),
  vehicleMaintenance: tool('vehicle.suggest_maintenance', 'draft_creation'),
  vehicleHistory: tool('vehicle.summarize_history', 'personalized_read'),
  fleetHealth: tool('fleet.summarize_vehicle_health', 'personalized_read'),
  profileCapabilities: tool('profile.suggest_capabilities', 'draft_creation'),
  reviewDraft: tool('review.draft_response', 'draft_creation'),
  reviewSummary: tool('review.summarize', 'personalized_read'),
  portfolioCaption: tool('portfolio.generate_caption', 'draft_creation'),
  portfolioRedaction: tool('portfolio.redaction_check', 'draft_creation'),
  appointmentDuration: tool('appointment.suggest_duration', 'draft_creation'),
  inventoryNormalize: tool('inventory.normalize_item', 'draft_creation'),
  inventoryFitment: tool('inventory.suggest_fitment', 'draft_creation'),
  inventoryGaps: tool('inventory.suggest_catalog_gaps', 'personalized_read'),
  skillHeatmap: tool('skill.generate_heatmap', 'personalized_read'),
  fraudPattern: tool('fraud.detect_review_pattern', 'admin_action'),
} as const satisfies Record<string, ToolSpec>;

export type ToolName = keyof typeof TOOLS;

/** `tool:<key>@<version>` as stored in mcp_clients.allowed_tools. */
export const registryKey = (t: ToolSpec): string => `tool:${t.key}@${t.version}`;

/** Insight types whose output may become public after a human operation (52 AiInsight.visibility). */
export const PUBLIC_AFTER_APPROVAL: ReadonlySet<InsightType> = new Set<InsightType>([
  'review_response_draft',
  'showcase_caption',
  'showcase_draft',
]);

/** Insight types that never leave the platform side (W11 risk flags, moderation hints): visibility internal. */
export const INTERNAL_ONLY: ReadonlySet<InsightType> = new Set<InsightType>(['fraud_flag', 'moderation_recommendation']);

/** How long a stored insight stays citable (52 AiInsight.expires_at; triage summaries follow the session). */
export const INSIGHT_TTL_DAYS: Partial<Record<InsightType, number>> = {
  appointment_slot_suggestion: 7,
  review_response_draft: 30,
  showcase_caption: 30,
  showcase_draft: 30,
  redaction_suggestion: 30,
  inventory_normalization: 30,
  fitment_suggestion: 30,
  fleet_suggestion: 30,
};
