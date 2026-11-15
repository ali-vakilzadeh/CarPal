// Vehicle's references to organizations for an organization merge (backend S22, BR-08): fleet vehicles, documents a
// user shared with the business and the service records it logged move to the surviving organization. Transfers move
// too, except a transfer between the two organizations and a pending transfer to the merged one while one to the
// surviving organization is pending for the same vehicle: those are cancelled and retired.
import { sql } from 'kysely';
import { moveRef, type OrgReference } from '#modules/organization/interface/org-references.js';

/** Transfers that cannot move: between the two organizations, or a pending duplicate of a pending transfer to the target. */
const stuck = (from: string, into: string) => sql`(
  (t.from_owner_type = 'organization' AND t.to_owner_type = 'organization'
     AND ((t.from_owner_id = ${from}::uuid AND t.to_owner_id = ${into}::uuid) OR (t.from_owner_id = ${into}::uuid AND t.to_owner_id = ${from}::uuid)))
  OR (t.status = 'pending' AND t.to_owner_type = 'organization' AND t.to_owner_id = ${from}::uuid
     AND EXISTS (SELECT 1 FROM vehicle.vehicle_transfers o WHERE o.vehicle_id = t.vehicle_id AND o.status = 'pending'
                   AND o.to_owner_type = 'organization' AND o.to_owner_id = ${into}::uuid)))`;

const mine = (from: string) => sql`t.deleted_at IS NULL AND ((t.from_owner_type = 'organization' AND t.from_owner_id = ${from}::uuid)
  OR (t.to_owner_type = 'organization' AND t.to_owner_id = ${from}::uuid))`;

const transfers: OrgReference = {
  key: 'vehicle.transfers',
  rule: 'keep_target',
  count: async (scope, from, into) => {
    const { rows } = await sql<{ n: string; c: string }>`
      SELECT count(*) AS n, count(*) FILTER (WHERE ${stuck(from, into)}) AS c
        FROM vehicle.vehicle_transfers t WHERE ${mine(from)}`.execute(scope.db);
    return { rows: Number(rows[0]?.n ?? 0), conflicts: Number(rows[0]?.c ?? 0) };
  },
  apply: async (scope, from, into) => {
    const retired = await sql`
      UPDATE vehicle.vehicle_transfers t
         SET status = CASE WHEN t.status = 'pending' THEN 'cancelled' ELSE t.status END,
             deleted_at = now(), deletion_reason = 'organization merged into ' || ${into}::text
       WHERE ${mine(from)} AND ${stuck(from, into)}`.execute(scope.db);
    let moved = 0;
    for (const side of ['from', 'to'] as const) {
      const r = await sql`UPDATE vehicle.vehicle_transfers t SET ${sql.ref(`${side}_owner_id`)} = ${into}::uuid
                           WHERE t.deleted_at IS NULL AND ${sql.ref(`t.${side}_owner_type`)} = 'organization'
                             AND ${sql.ref(`t.${side}_owner_id`)} = ${from}::uuid`.execute(scope.db);
      moved += Number(r.numAffectedRows ?? 0);
    }
    return { moved, retired: Number(retired.numAffectedRows ?? 0) };
  },
};

export function vehicleOrgReferences(): OrgReference[] {
  return [
    moveRef('vehicle.fleet_vehicles', { table: 'vehicle.vehicles', columns: ['owner_id'], where: "%.owner_type = 'organization'" }),
    transfers,
    moveRef('vehicle.shared_documents', { table: 'vehicle.vehicle_documents', columns: ['shared_with_organization_id'] }),
    moveRef('vehicle.service_records', { table: 'vehicle.vehicle_service_records', columns: ['provider_organization_id'] }),
  ];
}
