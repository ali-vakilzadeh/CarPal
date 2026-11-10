// Feature flag rules of the console (AC6.T2, Docs/40 §23.5 admin.flag_update, Appendix B, SEC-AI-6). Targeting is
// edited as a draft (lists typed as text, chosen roles and plans) and sent as the contract's object, or null when
// nothing is chosen (everyone). The four-eyes cases mirror the server's (turning the AI kill switch off, turning
// featured.enabled on); the server decides, the console only says so before sending.
import type { FeatureFlag, Role } from '@carpal/api-contracts';
import { PLAN_KEYS, planLabel, type PlanKey } from '@/lib/config/plans';
import { toLatinDigits } from '@/lib/format';
import type { MessageKey, Translate } from '@/lib/i18n/keys';

export const KILL_SWITCH = 'ai.automation.kill_switch';
export const FEATURED = 'featured.enabled';

export type Targeting = NonNullable<FeatureFlag['targeting']>;
export { PLAN_KEYS, planLabel, type PlanKey };

export const FLAG_TYPES = ['release', 'beta', 'ai_feature', 'kill_switch'] as const;

export const TARGET_ROLES: readonly Role[] = [
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
  'platform_admin',
  'platform_moderator',
  'platform_support',
  'platform_community_reviewer',
];

/** Contract limits of FeatureFlag.targeting. */
export const MAX_REGIONS = 50;
export const MAX_ORGS = 500;

/** 4EYES(kill switch off, featured.enabled on), as the server applies it. */
export function needsSecondApprover(key: string, current: boolean, next: boolean): boolean {
  if (next === current) return false;
  return (key === KILL_SWITCH && !next) || (key === FEATURED && next);
}

export interface TargetingDraft {
  roles: Role[];
  regions: string;
  organizationIds: string;
  planKeys: PlanKey[];
  percentage: string;
}

export function draftOf(t: FeatureFlag['targeting']): TargetingDraft {
  return {
    roles: [...(t?.roles ?? [])],
    regions: (t?.regions ?? []).join(', '),
    organizationIds: (t?.organization_ids ?? []).join('\n'),
    planKeys: [...(t?.plan_keys ?? [])],
    percentage: typeof t?.percentage === 'number' ? String(t.percentage) : '',
  };
}

export type TargetingProblems = { regions?: 'format' | 'too_many'; organizationIds?: 'format' | 'too_many'; percentage?: 'format' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const splitList = (s: string) =>
  toLatinDigits(s)
    .split(/[\s,،;]+/)
    .map((x) => x.trim())
    .filter(Boolean);

/** The draft as the contract's targeting (null = everyone), or what is wrong with it. */
export function targetingOf(d: TargetingDraft): { value: FeatureFlag['targeting'] } | { problems: TargetingProblems } {
  const problems: TargetingProblems = {};
  const regions = [...new Set(splitList(d.regions).map((r) => r.toUpperCase()))];
  if (regions.some((r) => !/^[A-Z]{2}$/.test(r))) problems.regions = 'format';
  else if (regions.length > MAX_REGIONS) problems.regions = 'too_many';
  const orgs = [...new Set(splitList(d.organizationIds).map((r) => r.toLowerCase()))];
  if (orgs.some((o) => !UUID.test(o))) problems.organizationIds = 'format';
  else if (orgs.length > MAX_ORGS) problems.organizationIds = 'too_many';
  const pctText = toLatinDigits(d.percentage).trim();
  const pct = pctText === '' ? null : Number(pctText);
  if (pct !== null && !(Number.isInteger(pct) && pct >= 0 && pct <= 100 && /^\d{1,3}$/.test(pctText))) problems.percentage = 'format';
  if (Object.keys(problems).length) return { problems };
  const t: Targeting = {};
  if (d.roles.length) t.roles = TARGET_ROLES.filter((r) => d.roles.includes(r));
  if (regions.length) t.regions = regions;
  if (orgs.length) t.organization_ids = orgs;
  if (d.planKeys.length) t.plan_keys = PLAN_KEYS.filter((p) => d.planKeys.includes(p));
  if (pct !== null) t.percentage = pct;
  return { value: Object.keys(t).length ? t : null };
}

/** Same targeting? (order of lists does not matter; null and {} both mean everyone). */
export function sameTargeting(a: FeatureFlag['targeting'], b: FeatureFlag['targeting']): boolean {
  const norm = (t: FeatureFlag['targeting']) =>
    JSON.stringify({
      roles: [...(t?.roles ?? [])].sort(),
      regions: [...(t?.regions ?? [])].sort(),
      organization_ids: [...(t?.organization_ids ?? [])].sort(),
      plan_keys: [...(t?.plan_keys ?? [])].sort(),
      percentage: t?.percentage ?? null,
    });
  return norm(a) === norm(b);
}

/** One line per criterion, in words ("Everyone" when there is none). */
export function targetingSummary(t: FeatureFlag['targeting'], tr: Translate, digits: (s: string) => string): string[] {
  const out: string[] = [];
  if (t?.roles?.length) out.push(tr('admin.flags.target.rolesList', { list: t.roles.map((r) => roleLabel(r, tr)).join(', ') }));
  if (t?.regions?.length) out.push(tr('admin.flags.target.regionsList', { list: t.regions.join(', ') }));
  if (t?.organization_ids?.length) out.push(tr('admin.flags.target.orgsCount', { count: t.organization_ids.length }));
  if (t?.plan_keys?.length) out.push(tr('admin.flags.target.plansList', { list: t.plan_keys.map((p) => planLabel(p, tr)).join(', ') }));
  if (typeof t?.percentage === 'number') out.push(tr('admin.flags.target.percentOf', { n: digits(String(t.percentage)) }));
  return out.length ? out : [tr('admin.flags.target.everyone')];
}

export function roleLabel(role: string, t: Translate): string {
  return (TARGET_ROLES as readonly string[]).includes(role)
    ? t(`admin.flags.roles.${role}` as MessageKey)
    : t('admin.kit.unknown', { value: role });
}

export function flagTypeLabel(type: string, t: Translate): string {
  return (FLAG_TYPES as readonly string[]).includes(type)
    ? t(`admin.flags.types.${type}` as MessageKey)
    : t('admin.kit.unknown', { value: type });
}

export function environmentLabel(env: string, t: Translate): string {
  return ['dev', 'staging', 'prod'].includes(env) ? t(`admin.flags.envs.${env}` as MessageKey) : t('admin.kit.unknown', { value: env });
}
