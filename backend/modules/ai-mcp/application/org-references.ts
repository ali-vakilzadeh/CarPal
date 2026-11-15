// AI's references to organizations for an organization merge (backend S22, BR-08): insights, suggestions, approval
// requests and triage sessions are outputs about the duplicate and stay with it; its skill heatmap entries expire (the
// surviving organization's are computed again); embeddings follow their records (inventory items and posts move).
import { historyRef, moveRef, retireRef, type OrgReference } from '#modules/organization/interface/org-references.js';

export function aiOrgReferences(): OrgReference[] {
  return [
    historyRef('ai_mcp.insights', { table: 'ai_mcp.ai_insights', columns: ['organization_id'] }),
    historyRef('ai_mcp.suggestions', { table: 'ai_mcp.ai_suggestions', columns: ['organization_id'] }),
    historyRef('ai_mcp.approval_requests', { table: 'ai_mcp.approval_requests', columns: ['organization_id'] }),
    historyRef('ai_mcp.triage_sessions', { table: 'ai_mcp.triage_sessions', columns: ['organization_id'] }),
    retireRef(
      'ai_mcp.skill_heatmap',
      { table: 'ai_mcp.skill_heatmap_entries', columns: ['provider_organization_id'], where: "%.status = 'active'" },
      "status = 'expired'",
    ),
    moveRef('ai_mcp.embeddings', { table: 'ai_mcp.embeddings', columns: ['organization_id'] }),
  ];
}
