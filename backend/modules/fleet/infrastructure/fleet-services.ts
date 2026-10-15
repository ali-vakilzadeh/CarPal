// Fleet services behind the fleet interface and the platform port
// DriverAssignments (libs/authz, SEC-AZ-7): active driver assignments, the
// approval workflow hooks used by vehicles and appointments, and preferred
// partners for search.
import { Injectable } from '@nestjs/common';
import { ApiError } from '#libs/contract/index.js';
import type { DriverAssignments } from '#libs/authz/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import { TxRunner, type TxScope } from '#libs/tenancy/index.js';
import { ConsentChecker } from '#libs/consent-gate/index.js';
import { authorDisplayName, UserCards } from '#modules/identity/interface/identity.js';
import {
  FleetDrivers,
  FleetPartners,
  FleetWorkflow,
  type AppointmentApprovalCheck,
  type AssignedDriver,
  type DriverIssue,
  type PreferredPartner,
} from '../interface/fleet.js';

const DRIVER_VISIBILITY = 'fleet_driver_data_visibility';

/** SEC-AZ-7 for the authorizer: a fleet driver reaches a path vehicle only with an active assignment. */
@Injectable()
export class DbDriverAssignments implements DriverAssignments {
  constructor(private readonly tx: TxRunner) {}

  async isAssigned(orgId: string, driverUserId: string, vehicleId: string): Promise<boolean> {
    // The driver's own context (RLS driver_read): the API roles cannot use the system context.
    return this.tx.run(
      { actorType: 'user', userId: driverUserId },
      async ({ db }) =>
        !!(await db
          .selectFrom('fleet.fleet_vehicle_assignments')
          .select('id')
          .where('fleet_organization_id', '=', orgId)
          .where('driver_user_id', '=', driverUserId)
          .where('vehicle_id', '=', vehicleId)
          .where('status', '=', 'active')
          .where('deleted_at', 'is', null)
          .executeTakeFirst()),
      { readOnly: true },
    );
  }
}

/** The display of a driver: their name only with their fleet_driver_data_visibility consent to this fleet. */
@Injectable()
export class DriverNames {
  constructor(
    private readonly users: UserCards,
    private readonly consents: ConsentChecker,
  ) {}

  async names(scope: TxScope, fleetOrgId: string, driverIds: readonly string[], locale = 'en'): Promise<Map<string, string>> {
    const unique = [...new Set(driverIds)];
    const cards = await this.users.cards(scope, unique);
    const out = new Map<string, string>();
    for (const id of unique) {
      const visible = await this.consents.isGranted(scope, {
        consentType: DRIVER_VISIBILITY,
        subject: { type: 'user', id },
        grantee: { type: 'organization', id: fleetOrgId },
      });
      out.set(id, visible ? authorDisplayName(cards.get(id), locale) : locale === 'fa' ? 'راننده' : 'Driver');
    }
    return out;
  }
}

@Injectable()
export class DbFleetDrivers extends FleetDrivers {
  constructor(private readonly names: DriverNames) {
    super();
  }

  async assignedVehicleIds(scope: TxScope, orgId: string, driverUserId: string): Promise<Set<string>> {
    const rows = await scope.db
      .selectFrom('fleet.fleet_vehicle_assignments')
      .select('vehicle_id')
      .where('fleet_organization_id', '=', orgId)
      .where('driver_user_id', '=', driverUserId)
      .where('status', '=', 'active')
      .where('deleted_at', 'is', null)
      .execute();
    return new Set(rows.map((r) => r.vehicle_id));
  }

  async assignedDrivers(scope: TxScope, vehicleIds: readonly string[]): Promise<Map<string, AssignedDriver>> {
    if (vehicleIds.length === 0) return new Map();
    const rows = await scope.db
      .selectFrom('fleet.fleet_vehicle_assignments')
      .select(['vehicle_id', 'driver_user_id', 'fleet_organization_id'])
      .where('vehicle_id', 'in', [...vehicleIds])
      .where('status', '=', 'active')
      .where('deleted_at', 'is', null)
      .execute();
    const out = new Map<string, AssignedDriver>();
    for (const r of rows) {
      const name = (await this.names.names(scope, r.fleet_organization_id, [r.driver_user_id])).get(r.driver_user_id)!;
      out.set(r.vehicle_id, { user_id: r.driver_user_id, display_name: name });
    }
    return out;
  }
}

/** The fleet's approval workflow switch (52 FleetProfile.approval_workflow_enabled, default on without a profile). */
export async function workflowOn(scope: TxScope, orgId: string): Promise<boolean> {
  const p = await scope.db
    .selectFrom('fleet.fleet_profiles')
    .select('approval_workflow_enabled')
    .where('organization_id', '=', orgId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  return p ? p.approval_workflow_enabled : true;
}

/** fleet.approval.requested for an approval that exists (W5 tells the approvers; 40 Appendix A). */
export async function approvalRequested(
  scope: TxScope,
  a: { id: string; fleet_organization_id: string; vehicle_id: string; approval_type: string; requested_by_user_id: string },
) {
  await publishEvent(scope, {
    type: 'fleet.approval.requested',
    aggregateType: 'fleet_approval',
    aggregateId: a.id,
    payload: {
      organization_id: a.fleet_organization_id,
      approval_id: a.id,
      vehicle_id: a.vehicle_id,
      approval_type: a.approval_type,
      requested_by_user_id: a.requested_by_user_id,
    },
  });
}

@Injectable()
export class DbFleetWorkflow extends FleetWorkflow {
  async driverIssue(scope: TxScope, i: DriverIssue): Promise<'pending' | 'approved'> {
    if (!(await workflowOn(scope, i.orgId))) return 'approved';
    const row = await scope.db
      .insertInto('fleet.fleet_approvals')
      .values({
        fleet_organization_id: i.orgId,
        vehicle_id: i.vehicleId,
        approval_type: 'repair_request',
        related_issue_id: i.issueId,
        requested_by_user_id: i.driverUserId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await approvalRequested(scope, row);
    return 'pending';
  }

  async appointmentApproval(scope: TxScope, a: AppointmentApprovalCheck): Promise<string | null> {
    const notFound = () => ApiError.validation([{ pointer: '/fleet_approval_id', code: 'reference_not_found' }], 'REFERENCE_NOT_FOUND');
    if (!a.approvalId) {
      // Owners and managers decide approvals themselves; everyone else books with an approved request while the workflow is on.
      if ((await workflowOn(scope, a.orgId)) && !['fleet_owner', 'fleet_manager'].includes(a.role))
        throw ApiError.validation([{ pointer: '/fleet_approval_id', code: 'conditional_required' }]);
      return null;
    }
    const ap = await scope.db
      .selectFrom('fleet.fleet_approvals')
      .selectAll()
      .where('id', '=', a.approvalId)
      .where('fleet_organization_id', '=', a.orgId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!ap || ap.status !== 'approved' || ap.vehicle_id !== a.vehicleId || ap.approval_type === 'cost_estimate') throw notFound();
    if (ap.selected_provider_organization_id && ap.selected_provider_organization_id !== a.providerOrgId) throw notFound();
    if (ap.related_appointment_id) throw notFound();
    return ap.id;
  }

  async linkAppointment(scope: TxScope, approvalId: string, appointmentId: string): Promise<void> {
    await scope.db
      .updateTable('fleet.fleet_approvals')
      .set({ related_appointment_id: appointmentId })
      .where('id', '=', approvalId)
      .execute();
  }
}

@Injectable()
export class DbFleetPartners extends FleetPartners {
  async preferredProviders(scope: TxScope, fleetOrgId: string): Promise<PreferredPartner[]> {
    const rows = await scope.db
      .selectFrom('fleet.fleet_preferred_partners')
      .select(['partner_organization_id', 'priority', 'service_system_node_id'])
      .where('fleet_organization_id', '=', fleetOrgId)
      .where('relationship_type', '=', 'preferred_provider')
      .where('status', '=', 'active')
      .where('deleted_at', 'is', null)
      .orderBy('priority')
      .execute();
    return rows.map((r) => ({
      organizationId: r.partner_organization_id,
      priority: r.priority,
      serviceSystemNodeId: r.service_system_node_id,
    }));
  }
}
