// Staff role names for display (AC4, GD-09): the contract's four roles in a fixed order, translated.
import type { StaffRole } from '@/lib/api/generated';
import type { Translate } from '@/lib/i18n/keys';

export const STAFF_ROLE_ORDER: readonly StaffRole[] = ['ADM', 'MOD', 'SUP', 'CRV'];

export function roleNames(roles: readonly StaffRole[], t: Translate): string {
  return STAFF_ROLE_ORDER.filter((r) => roles.includes(r))
    .map((r) => t(`admin.roles.${r}`))
    .join(' · ');
}
