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
  /**
   * The subject of the purpose item the request's record was bound to, e.g. "user:0190…" (backend S14, BR-09):
   * named in the pii.read audit entry. Null when the operation limits its own results to the item's subjects.
   */
  bound?: string | null;
}

/**
 * Outcome of the purpose check (SEC-ADM-5): the item is open in the caller's queue and the record of the request is
 * one of the item's subjects (ok); the item is not in the queue (404 NOT_FOUND); or the item is, but the record is
 * not about it (403 PURPOSE_RECORD_MISMATCH).
 */
export type PurposeVerdict = { status: 'ok'; bound: string | null } | { status: 'not_in_queue' } | { status: 'record_mismatch' };

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
  /**
   * The referenced item is assigned to the staff member or open in their queue, and the record the operation reads
   * or changes (from its path parameters) is a subject of that item (SEC-ADM-5).
   */
  abstract verify(staffUserId: string, purpose: AccessPurpose, opId: string, params: Record<string, string>): Promise<PurposeVerdict>;
}
