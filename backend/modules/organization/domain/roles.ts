// Organization roles (52 RoleMembership, 40 §0.5, §7.2): which roles belong
// to an organization type, the owner role a creator gets, and the order used
// for "not higher than the inviter's role" and "lower roles only".
import type { OrgType } from '#libs/contract/generated/enums.js';

const ROLES: Record<OrgType, readonly string[]> = {
  provider: ['provider_owner', 'provider_manager', 'provider_staff'],
  vendor: ['vendor_owner', 'vendor_staff'],
  fleet: ['fleet_owner', 'fleet_manager', 'fleet_maintenance_coordinator', 'fleet_driver', 'fleet_viewer'],
  hybrid_provider_vendor: ['provider_owner', 'provider_manager', 'provider_staff', 'vendor_owner', 'vendor_staff'],
};

/** Owner roles (40 O+). */
export const OWNER_ROLES = ['provider_owner', 'vendor_owner', 'fleet_owner'] as const;
/** Roles only an owner may grant (40 org.member_update: "only the owner can grant owner or manager roles"). */
const OWNER_GRANTED = new Set(['provider_owner', 'vendor_owner', 'fleet_owner', 'provider_manager', 'fleet_manager']);

/** Rank of a role inside its organization: owner 4, manager 3, maintenance coordinator 2, others 1. */
export function roleRank(role: string): number {
  if (role.endsWith('_owner')) return 4;
  if (role.endsWith('_manager')) return 3;
  if (role === 'fleet_maintenance_coordinator') return 2;
  return 1;
}

export const rolesOf = (type: OrgType): readonly string[] => ROLES[type];

export const roleFitsOrg = (role: string, type: OrgType): boolean => ROLES[type].includes(role);

/**
 * Owner role of the creator. A hybrid provider/vendor organization starts
 * with provider_owner (one membership per user and organization; DI-21).
 */
export function ownerRoleFor(type: OrgType): string {
  return type === 'vendor' ? 'vendor_owner' : type === 'fleet' ? 'fleet_owner' : 'provider_owner';
}

export const isOwnerRole = (role: string): boolean => (OWNER_ROLES as readonly string[]).includes(role);

/** org.member_invite: the role must fit the organization and must not be higher than the inviter's role. */
export function mayInvite(inviterRole: string, role: string, type: OrgType): boolean {
  return roleFitsOrg(role, type) && roleRank(role) <= roleRank(inviterRole);
}

/** org.member_update: owners change any role; owner and manager roles are granted by an owner only. */
export function mayGrant(actorRole: string, role: string, type: OrgType): boolean {
  if (!roleFitsOrg(role, type)) return false;
  return OWNER_GRANTED.has(role) ? isOwnerRole(actorRole) : roleRank(role) <= roleRank(actorRole);
}

/** org.member_remove "M+: lower roles only": a manager removes strictly lower roles; an owner anyone. */
export function mayRemove(actorRole: string, targetRole: string): boolean {
  return isOwnerRole(actorRole) || roleRank(targetRole) < roleRank(actorRole);
}
