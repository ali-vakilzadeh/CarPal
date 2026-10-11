// Server state the authorizer needs (40 SEC-AU-3: tokens carry no roles).
// Implemented by the owning modules: identity (memberships, platform roles),
// organization (organization type and status), fleet (driver assignments),
// admin (purpose binding). Abstract classes double as Nest DI tokens.
import type { OrgStatus, OrgType } from '#libs/contract/generated/enums.js';

export interface Membership {
  orgId: string;
  /** 52 RoleMembership.role of an active membership. */
  role: string;
}

export interface OrganizationInfo {
  id: string;
  type: OrgType;
  status: OrgStatus;
}

export type PurposeKind = 'case' | 'dispute' | 'dsr' | 'verification' | 'approval';
/** CarPal-Access-Purpose (40 §1.3, SEC-ADM-5). */
export interface AccessPurpose {
  kind: PurposeKind;
  id: string;
  /** Header value as sent, e.g. "case:0190…" (written to audit access_purpose). */
  value: string;
}

export abstract class MembershipDirectory {
  /** Active organization memberships of a user (status = active). */
  abstract memberships(userId: string, actor: 'user' | 'staff'): Promise<Membership[]>;
  /** Active platform roles (platform_admin, platform_moderator, platform_support, platform_community_reviewer). */
  abstract platformRoles(userId: string): Promise<string[]>;
}

export abstract class OrganizationDirectory {
  abstract get(orgId: string): Promise<OrganizationInfo | null>;
}

export abstract class DriverAssignments {
  /** True when the vehicle has an active FleetVehicleAssignment to the driver (SEC-AZ-7). */
  abstract isAssigned(orgId: string, driverUserId: string, vehicleId: string): Promise<boolean>;
}

export abstract class PurposeVerifier {
  /** The referenced item is assigned to the staff member or open in their queue (SEC-ADM-5). */
  abstract verify(staffUserId: string, purpose: AccessPurpose, opId: string): Promise<boolean>;
}
