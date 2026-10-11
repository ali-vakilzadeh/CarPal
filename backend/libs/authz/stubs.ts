// Port implementations used until the owning modules provide theirs:
// fleet driver assignments arrive in S8 (deny all until then: fail closed),
// purpose binding to the staff queue arrives in S8 (well-formed purposes are
// accepted until then: logged deviation). The in-memory directory backs unit
// tests of the authorizer.
import type {
  AccessPurpose,
  DriverAssignments,
  Membership,
  MembershipDirectory,
  OrganizationDirectory,
  OrganizationInfo,
  PurposeVerifier,
} from './ports.js';

export class NoDriverAssignments implements DriverAssignments {
  async isAssigned(): Promise<boolean> {
    return false;
  }
}

export class WellFormedPurposeVerifier implements PurposeVerifier {
  async verify(_staffUserId: string, _purpose: AccessPurpose): Promise<boolean> {
    return true;
  }
}

/** Empty directories: nobody is a member of anything (apps without the identity/organization modules). */
export class EmptyDirectory implements MembershipDirectory, OrganizationDirectory {
  async memberships(): Promise<Membership[]> {
    return [];
  }
  async platformRoles(): Promise<string[]> {
    return [];
  }
  async get(): Promise<OrganizationInfo | null> {
    return null;
  }
}

export class InMemoryDirectory implements MembershipDirectory, OrganizationDirectory, DriverAssignments {
  readonly orgs = new Map<string, OrganizationInfo>();
  readonly members = new Map<string, Membership[]>();
  readonly platform = new Map<string, string[]>();
  readonly assignments = new Set<string>();

  addOrg(org: OrganizationInfo): void {
    this.orgs.set(org.id, org);
  }
  addMember(userId: string, orgId: string, role: string): void {
    this.members.set(userId, [...(this.members.get(userId) ?? []).filter((m) => m.orgId !== orgId), { orgId, role }]);
  }
  addPlatformRole(userId: string, role: string): void {
    this.platform.set(userId, [...(this.platform.get(userId) ?? []), role]);
  }
  assign(orgId: string, driverUserId: string, vehicleId: string): void {
    this.assignments.add(`${orgId}:${driverUserId}:${vehicleId}`);
  }

  async memberships(userId: string): Promise<Membership[]> {
    return this.members.get(userId) ?? [];
  }
  async platformRoles(userId: string): Promise<string[]> {
    return this.platform.get(userId) ?? [];
  }
  async get(orgId: string): Promise<OrganizationInfo | null> {
    return this.orgs.get(orgId) ?? null;
  }
  async isAssigned(orgId: string, driverUserId: string, vehicleId: string): Promise<boolean> {
    return this.assignments.has(`${orgId}:${driverUserId}:${vehicleId}`);
  }
}
