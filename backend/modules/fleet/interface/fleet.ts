// Public interface of the fleet module (41 §2.1 M9; 40 §18; 52 §13 fleet).
// Other modules ask the fleet about driver assignments (SEC-AZ-7: drivers
// reach assigned vehicles only), the approval workflow (a driver's issue
// starts a repair request; fleet appointments carry an approved fleet
// approval when the workflow is on) and preferred partners (search filter and
// ranking bonus). Calls run in the caller's transaction with the fleet
// organization as RLS context (or the system context).
import type { TxScope } from '#libs/tenancy/index.js';

export interface AssignedDriver {
  user_id: string;
  display_name: string;
}

export abstract class FleetDrivers {
  /** Vehicles with an active assignment to the driver in this fleet (vehicles.list, appointments for drivers). */
  abstract assignedVehicleIds(scope: TxScope, orgId: string, driverUserId: string): Promise<Set<string>>;
  /** The active driver of each vehicle (40 Vehicle.assigned_driver), by vehicle id. */
  abstract assignedDrivers(scope: TxScope, vehicleIds: readonly string[]): Promise<Map<string, AssignedDriver>>;
}

export interface DriverIssue {
  orgId: string;
  vehicleId: string;
  issueId: string;
  driverUserId: string;
}

export interface AppointmentApprovalCheck {
  orgId: string;
  approvalId: string | null;
  vehicleId: string;
  providerOrgId: string;
  /** The requesting member's fleet role: owners and managers decide approvals themselves. */
  role: string;
}

export abstract class FleetWorkflow {
  /**
   * A driver reported an issue (40 issues.create, ORG(FC) DRV): with the
   * approval workflow on, a repair_request approval is opened and
   * fleet.approval.requested published; returns the issue's
   * fleet_approval_status ('approved' when the fleet has the workflow off).
   */
  abstract driverIssue(scope: TxScope, i: DriverIssue): Promise<'pending' | 'approved'>;
  /**
   * The approval an appointment request carries (40 AppointmentCreate.fleet_approval_id):
   * approved, for the same vehicle, for this provider when one was selected.
   * Required while the workflow is on unless the requester is a fleet owner
   * or manager. Returns the approval id to store, or null. Throws 422 on a
   * bad reference.
   */
  abstract appointmentApproval(scope: TxScope, a: AppointmentApprovalCheck): Promise<string | null>;
  /** Links an approval to the appointment it was used for (fleet.approval related_appointment_id). */
  abstract linkAppointment(scope: TxScope, approvalId: string, appointmentId: string): Promise<void>;
}

export interface PreferredPartner {
  organizationId: string;
  priority: number;
  serviceSystemNodeId: string | null;
}

export abstract class FleetPartners {
  /** Active preferred providers of a fleet (SearchFilters.preferred_partners_only, 54 §5.1 fleet bonus). */
  abstract preferredProviders(scope: TxScope, fleetOrgId: string): Promise<PreferredPartner[]>;
}
