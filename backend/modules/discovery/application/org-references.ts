// Discovery's references to organizations for an organization merge (backend S22, BR-08): past match sessions and
// their results are a record of what was searched and shown, kept with the merged organization. The search index
// follows organization.merged.
import { historyRef, type OrgReference } from '#modules/organization/interface/org-references.js';

export function discoveryOrgReferences(): OrgReference[] {
  return [
    historyRef('discovery.match_sessions', { table: 'discovery.match_sessions', columns: ['requester_organization_id'] }),
    historyRef('discovery.match_results', {
      table: 'discovery.match_results',
      columns: ['target_entity_id'],
      where: "%.target_entity_type = 'organization'",
    }),
  ];
}
