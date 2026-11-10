// Plan and subscription rules of the console (AC6.T3/T4, Docs/40 §10.1 and §23.2, MVP manual billing). Entitlements
// are booleans or whole numbers (null = unlimited); a plan edit sends only the entitlements that changed (the
// server waits for a second admin, 4EYES). A manual assignment names its subscriber by exact id; an individual takes
// an individual plan, an organization the plans of its type (a hybrid either side; the server checks). Dates are
// picked as days and sent as the end of that day in the staff member's time zone.
import type { EntitlementKey, EntitlementValue, Plan } from '@carpal/api-contracts';
import { toLatinDigits } from '@/lib/format';
import type { MessageKey, Translate } from '@/lib/i18n/keys';

export type PlanKey = Plan['plan_key'];
export type Audience = Plan['audience'];
export type OrgType = 'provider' | 'vendor' | 'fleet' | 'hybrid_provider_vendor';

export const ENTITLEMENT_KEYS: readonly EntitlementKey[] = [
  'max_vehicles',
  'max_fleet_users',
  'ai_tools_enabled',
  'ai_fleet_suggestions_enabled',
  'max_inventory_items',
  'inventory_bulk_import_enabled',
  'appointment_capacity_tools_enabled',
  'advanced_analytics_enabled',
  'fleet_reports_enabled',
  'fleet_approval_workflow_enabled',
  'featured_placement_eligible',
  'export_enabled',
];

export const AUDIENCES: readonly Audience[] = ['individual', 'fleet', 'provider', 'vendor'];

/** EntitlementValue integers: Int<0,10000000>. Limit overrides: Int<0,1000000>. */
export const ENTITLEMENT_MAX = 10_000_000;
export const LIMIT_MAX = 1_000_000;

export function entitlementLabel(key: string, t: Translate): string {
  return (ENTITLEMENT_KEYS as readonly string[]).includes(key)
    ? t(`admin.plans.ent.${key}` as MessageKey)
    : t('admin.kit.unknown', { value: key });
}

export function audienceLabel(a: string, t: Translate): string {
  return (AUDIENCES as readonly string[]).includes(a)
    ? t(`admin.plans.audiences.${a}` as MessageKey)
    : t('admin.kit.unknown', { value: a });
}

/** Number of things or "Unlimited". */
export function limitText(v: number | null, t: Translate, n: (x: number) => string): string {
  return v === null ? t('admin.plans.unlimited') : n(v);
}

export function valueText(v: EntitlementValue['value'], t: Translate, n: (x: number) => string): string {
  if (typeof v === 'boolean') return v ? t('admin.plans.yes') : t('admin.plans.no');
  return limitText(v, t, n);
}

/** A value being edited: a switch, or a number (text) that may be unlimited. */
export type EntDraft = { kind: 'bool'; value: boolean } | { kind: 'int'; text: string; unlimited: boolean };

export function draftOfValue(v: EntitlementValue['value']): EntDraft {
  if (typeof v === 'boolean') return { kind: 'bool', value: v };
  return { kind: 'int', text: v === null ? '' : String(v), unlimited: v === null };
}

/** A whole number in 0..max typed with any digits, or null when it is not one. */
export function parseCount(text: string, max: number): number | null {
  const s = toLatinDigits(text)
    .trim()
    .replace(/[,٬\s]/g, '');
  if (!/^\d{1,8}$/.test(s)) return null;
  const n = Number(s);
  return n <= max ? n : null;
}

/** The drafted value, or undefined when the number is not valid. */
export function valueOfDraft(d: EntDraft): EntitlementValue['value'] | undefined {
  if (d.kind === 'bool') return d.value;
  if (d.unlimited) return null;
  const n = parseCount(d.text, ENTITLEMENT_MAX);
  return n === null ? undefined : n;
}

export type EntDrafts = Partial<Record<EntitlementKey, EntDraft>>;

export function draftsOf(list: readonly EntitlementValue[]): EntDrafts {
  return Object.fromEntries(list.map((e) => [e.key, draftOfValue(e.value)]));
}

/** The entitlements that differ from the plan, or the keys whose number is not valid. */
export function changedEntitlements(plan: Plan, drafts: EntDrafts): { changes: EntitlementValue[] } | { invalid: EntitlementKey[] } {
  const changes: EntitlementValue[] = [];
  const invalid: EntitlementKey[] = [];
  for (const e of plan.entitlements) {
    const d = drafts[e.key];
    if (!d) continue;
    const v = valueOfDraft(d);
    if (v === undefined) invalid.push(e.key);
    else if (v !== e.value) changes.push({ key: e.key, value: v });
  }
  return invalid.length ? { invalid } : { changes };
}

/** Plan audiences an organization type may take (the server's ORG_AUDIENCES). */
export function audiencesOf(subscriber: { type: 'user' } | { type: 'organization'; orgType?: string | undefined }): Audience[] {
  if (subscriber.type === 'user') return ['individual'];
  switch (subscriber.orgType) {
    case 'provider':
      return ['provider'];
    case 'vendor':
      return ['vendor'];
    case 'fleet':
      return ['fleet'];
    case 'hybrid_provider_vendor':
      return ['provider', 'vendor'];
    default:
      return ['fleet', 'provider', 'vendor'];
  }
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseId(text: string): string | null {
  const s = toLatinDigits(text).trim().toLowerCase();
  return UUID.test(s) ? s : null;
}

/** "organization:<id>" or "user:<id>" from a link of another screen (AC9 organization, AC10 user detail). */
export function parseSubscriberParam(v: string | null): { type: 'user' | 'organization'; id: string } | null {
  const m = /^(user|organization):(.+)$/.exec(v ?? '');
  const id = m ? parseId(m[2]!) : null;
  return m && id ? { type: m[1] as 'user' | 'organization', id } : null;
}

/** Minutes east of UTC of a time zone at an instant (Intl "GMT+03:30"). */
export function zoneOffsetMinutes(at: Date, timeZone: string): number {
  const name =
    new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }).formatToParts(at).find((p) => p.type === 'timeZoneName')
      ?.value ?? 'GMT';
  const m = /GMT([+-])(\d{1,2}):?(\d{2})?/.exec(name);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
}

/** 23:59:59 of a day (YYYY-MM-DD) in the time zone, as an ISO instant; null for a malformed day. */
export function endOfDayIso(day: string, timeZone: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const naive = new Date(`${day}T23:59:59Z`);
  if (Number.isNaN(naive.getTime())) return null;
  return new Date(naive.getTime() - zoneOffsetMinutes(naive, timeZone) * 60_000).toISOString();
}

/** Today (YYYY-MM-DD) in the time zone, plus `days`. */
export function dayIn(timeZone: string, days = 0, now = Date.now()): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
