// Role checks over the generated role table (GD-09). Navigation and action buttons are shown only when one of the
// caller's staff roles may call the operation; the server always decides (a 403 still renders the no-permission
// state). Qualified roles (e.g. MOD on four_eyes_decide: "moderation changes only") count as allowed here and are
// narrowed by the server.
import { ADMIN_OPERATIONS, STAFF_ROLES, type AdminOperationId, type StaffRole } from '@/lib/api/generated';

const MEMBERSHIP_TO_ROLE = new Map<string, StaffRole>(Object.entries(STAFF_ROLES).map(([code, role]) => [role, code as StaffRole]));

/** Staff roles from RoleMembership.role values (platform_admin …); other roles are ignored. */
export function staffRolesOf(memberships: readonly string[]): StaffRole[] {
  return [...new Set(memberships.map((m) => MEMBERSHIP_TO_ROLE.get(m)).filter((r): r is StaffRole => r !== undefined))];
}

export function canCall(opId: AdminOperationId, roles: readonly StaffRole[]): boolean {
  // Widened on purpose: contract 1.3.0 has no GD-07 api read (AC2, BR-18), but one may come back.
  const op: { readonly plane: 'admin' | 'api-read'; readonly roles: readonly string[] } = ADMIN_OPERATIONS[opId];
  // GD-07 api reads carry no STF(...) set: any signed-in staff member.
  if (op.plane === 'api-read') return roles.length > 0;
  return (op.roles as readonly StaffRole[]).some((r) => roles.includes(r));
}

/** True when the caller may call at least one of the operations (a navigation section is visible). */
export function canCallAny(opIds: readonly AdminOperationId[], roles: readonly StaffRole[]): boolean {
  return opIds.some((id) => canCall(id, roles));
}
