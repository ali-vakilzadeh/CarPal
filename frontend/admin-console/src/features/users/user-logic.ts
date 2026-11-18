// Rules of the user screens (AC10.T1-T3, Docs/23 A-USR-01/02, Docs/40 §23.2 admin.users_search, admin.user_get,
// admin.user_status, admin.user_sessions_revoke, admin.onboarding_reset, admin.platform_role_grant/_revoke). A user is
// found by exactly one identifier and only inside the work item the page was opened for (SEC-ADM-5, backend S14):
// the search is "find within this work item", never a browsable list (DI-03). Platform roles are the user's
// memberships without an organization whose role is platform_* (Docs/40 Membership).
import type { Membership, StaffUserView, UserSearch } from '@carpal/api-contracts';
import { toLatinDigits } from '@/lib/format';

export const USER_STATUSES = ['pending_verification', 'active', 'suspended', 'deactivated', 'deleted'] as const;
export const PLATFORM_ROLES = ['platform_admin', 'platform_moderator', 'platform_support', 'platform_community_reviewer'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];
export const LOOKUP_KINDS = ['email', 'phone', 'name', 'user_id'] as const;
export type LookupKind = (typeof LOOKUP_KINDS)[number];
export const ONBOARDING_FLOWS = ['individual', 'fleet', 'provider', 'vendor'] as const;
export type OnboardingFlow = (typeof ONBOARDING_FLOWS)[number];
export type StatusChange = 'suspend' | 'reactivate';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const isUserId = (v: string) => UUID.test(v.trim());

/** The search body for one identifier, or the problem with the input (Docs/40 UserSearch: exactly one). */
export function lookupBody(kind: LookupKind, raw: string): { body: UserSearch } | { problem: 'required' | 'invalid' } {
  const v = toLatinDigits(raw).trim();
  if (!v) return { problem: 'required' };
  switch (kind) {
    case 'email':
      return EMAIL.test(v) && v.length <= 254 ? { body: { email: v.toLowerCase() } } : { problem: 'invalid' };
    case 'phone': {
      // E.164: a leading + and 8-15 digits; spaces, dashes and brackets are dropped; 09… becomes +989….
      let p = v.replace(/[\s\-().]/g, '');
      if (/^0\d{10}$/.test(p)) p = `+98${p.slice(1)}`;
      if (/^00\d+$/.test(p)) p = `+${p.slice(2)}`;
      return /^\+[1-9]\d{7,14}$/.test(p) ? { body: { phone: p } } : { problem: 'invalid' };
    }
    case 'name':
      return v.length >= 2 && v.length <= 100 ? { body: { name: v } } : { problem: 'invalid' };
    case 'user_id':
      return isUserId(v) ? { body: { user_id: v.toLowerCase() } } : { problem: 'invalid' };
  }
}

export interface RoleState {
  role: PlatformRole;
  status: Membership['status'];
}

/** The user's platform roles (active and suspended; removed ones are history). */
export function platformRoles(memberships: readonly Membership[]): RoleState[] {
  return PLATFORM_ROLES.flatMap((role) => {
    const m = memberships.find((x) => x.organization === null && x.role === role && x.status !== 'removed');
    return m ? [{ role, status: m.status }] : [];
  });
}

/** Roles an admin can still grant (not held in any live state). */
export function grantableRoles(memberships: readonly Membership[]): PlatformRole[] {
  const held = new Set(platformRoles(memberships).map((r) => r.role));
  return PLATFORM_ROLES.filter((r) => !held.has(r));
}

/** Business memberships (with an organization), for the Roles & organizations section. */
export function businessMemberships(memberships: readonly Membership[]): Membership[] {
  return memberships.filter((m) => m.organization !== null);
}

/** Onboarding flows that can be reset for this user: their own, and the business kinds they own or run. */
export function onboardingFlows(memberships: readonly Membership[]): OnboardingFlow[] {
  const flows = new Set<OnboardingFlow>(['individual']);
  for (const m of memberships) {
    if (m.status === 'removed') continue;
    if (m.role === 'fleet_owner' || m.role === 'fleet_manager') flows.add('fleet');
    if (m.role === 'provider_owner' || m.role === 'provider_manager') flows.add('provider');
    if (m.role === 'vendor_owner') flows.add('vendor');
  }
  return ONBOARDING_FLOWS.filter((f) => flows.has(f));
}

/** Account status changes offered for a status (deleted and deactivated accounts are not changed here). */
export function statusChanges(status: StaffUserView['status']): StatusChange[] {
  if (status === 'active' || status === 'pending_verification') return ['suspend'];
  if (status === 'suspended') return ['reactivate'];
  return [];
}

/** A deleted account, or one whose deletion is running, takes no actions. */
export function isGone(status: StaffUserView['status']): boolean {
  return status === 'deleted';
}
