// The admin module's references to organizations for an organization merge (backend S22, BR-08): an open assist
// session on the duplicate refuses the merge (staff end it first); moderation cases about the duplicate stay with it.
import { historyRef, refuseRef, type OrgReference } from '#modules/organization/interface/org-references.js';

export function adminOrgReferences(): OrgReference[] {
  return [
    refuseRef('admin.assist_sessions', {
      table: 'admin.assist_sessions',
      columns: ['organization_id'],
      where: "%.status = 'active' AND %.expires_at > now()",
    }),
    historyRef('admin.cases', {
      table: 'admin.moderation_cases',
      columns: ['target_entity_id'],
      where: "%.target_entity_type = 'organization' AND %.status IN ('open','investigating','escalated')",
    }),
  ];
}
