// Labels shared by the user screens (AC10). Unknown server values read "Unknown (<value>)" (PWA P13 rule).
import type { MessageKey, Translate } from '@/lib/i18n/keys';
import { ONBOARDING_FLOWS, PLATFORM_ROLES, USER_STATUSES } from './user-logic';

function label(list: readonly string[], prefix: string, value: string, t: Translate): string {
  return list.includes(value) ? t(`${prefix}.${value}` as MessageKey) : t('admin.kit.unknown', { value });
}

export const userStatus = (v: string, t: Translate) => label(USER_STATUSES, 'admin.users.status', v, t);
export const platformRole = (v: string, t: Translate) => label(PLATFORM_ROLES, 'admin.users.role', v, t);
export const onboardingFlow = (v: string, t: Translate) => label(ONBOARDING_FLOWS, 'admin.users.flow', v, t);

const MEMBERSHIP_ROLES = [
  'individual',
  'fleet_owner',
  'fleet_manager',
  'fleet_maintenance_coordinator',
  'fleet_driver',
  'fleet_viewer',
  'provider_owner',
  'provider_manager',
  'provider_staff',
  'vendor_owner',
  'vendor_staff',
] as const;
export const membershipRole = (v: string, t: Translate) => label(MEMBERSHIP_ROLES, 'admin.users.memberRole', v, t);
const MEMBERSHIP_STATUSES = ['invited', 'active', 'suspended', 'removed'] as const;
export const membershipStatus = (v: string, t: Translate) => label(MEMBERSHIP_STATUSES, 'admin.users.memberStatus', v, t);
