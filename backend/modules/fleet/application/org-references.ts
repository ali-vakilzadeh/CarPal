// Fleet's references to organizations for an organization merge (backend S22, BR-08): the fleet profile moves when the
// surviving fleet has none (otherwise the merged one's is retired); vehicle assignments, approvals, imports and exports
// move; preferred partners move unless they link the two organizations.
import { keyedRef, moveRef, singleRef, type OrgReference } from '#modules/organization/interface/org-references.js';

export function fleetOrgReferences(): OrgReference[] {
  return [
    singleRef('fleet.profile', { table: 'fleet.fleet_profiles', columns: ['organization_id'], column: 'organization_id' }),
    moveRef('fleet.vehicle_assignments', { table: 'fleet.fleet_vehicle_assignments', columns: ['fleet_organization_id'] }),
    keyedRef('fleet.preferred_partners', {
      table: 'fleet.fleet_preferred_partners',
      columns: ['fleet_organization_id', 'partner_organization_id'],
      pair: true,
    }),
    moveRef('fleet.approvals', { table: 'fleet.fleet_approvals', columns: ['fleet_organization_id', 'selected_provider_organization_id'] }),
    moveRef('fleet.import_batches', { table: 'fleet.fleet_import_batches', columns: ['fleet_organization_id'] }),
    moveRef('fleet.exports', { table: 'fleet.fleet_exports', columns: ['fleet_organization_id'] }),
  ];
}
