// Pure rules of the organization module: opening hours (40 HoursSpec),
// profile completeness (MVP Module C criteria) and publish requirements
// (52 §21 Organization publish rules, 56 §2.10). The keys are the stable
// strings returned in ProviderProfile.completeness_gaps, PublishResult.unmet
// and Problem.requirements (DI-10).
import type { FieldError } from '#libs/contract/index.js';
import type { HoursSpec } from '#libs/geo/index.js';

export { openNow, type HoursSpec } from '#libs/geo/index.js';

/** close after open on every interval; exceptions: open/close only (and both) when not closed; one exception per date. */
export function validateHours(h: HoursSpec, pointer = '/hours'): FieldError[] {
  const errors: FieldError[] = [];
  h.weekly.forEach((w, i) => {
    if (w.close <= w.open) errors.push({ pointer: `${pointer}/weekly/${i}/close`, code: 'order' });
  });
  const dates = new Set<string>();
  (h.exceptions ?? []).forEach((e, i) => {
    const p = `${pointer}/exceptions/${i}`;
    if (dates.has(e.date)) errors.push({ pointer: `${p}/date`, code: 'not_unique' });
    dates.add(e.date);
    if (e.closed) {
      if (e.open !== undefined) errors.push({ pointer: `${p}/open`, code: 'conditional_forbidden' });
      if (e.close !== undefined) errors.push({ pointer: `${p}/close`, code: 'conditional_forbidden' });
      return;
    }
    if (e.open === undefined) errors.push({ pointer: `${p}/open`, code: 'conditional_required' });
    if (e.close === undefined) errors.push({ pointer: `${p}/close`, code: 'conditional_required' });
    if (e.open !== undefined && e.close !== undefined && e.close <= e.open) errors.push({ pointer: `${p}/close`, code: 'order' });
  });
  return errors;
}

/** Facts about a provider organization, gathered by the use case. */
export interface ProviderFacts {
  orgStatus: string;
  hasProfile: boolean;
  publicStatus: string | null;
  descriptionSet: boolean;
  contactChannels: number;
  activeLocations: number;
  verifiedLocations: number;
  hoursSet: boolean;
  activeServiceCategories: number;
  activeCoverage: number;
  portfolioItems: number;
  activeCertifications: number;
  appointmentCapacityEnabled: boolean;
  /** From other modules (trust S7, appointment S7); 0/null until they register. */
  reviewCount: number;
  responseRateKnown: boolean;
}

/** MVP Module C completeness criteria, equal weights until WP0 sets them. */
export const PROVIDER_COMPLETENESS: readonly [key: string, met: (f: ProviderFacts) => boolean][] = [
  ['business_info', (f) => f.hasProfile && f.descriptionSet && f.contactChannels > 0],
  ['location_verified', (f) => f.verifiedLocations > 0],
  ['hours_set', (f) => f.hoursSet],
  ['service_categories', (f) => f.activeServiceCategories > 0],
  ['portfolio_items', (f) => f.portfolioItems > 0],
  ['reviews_received', (f) => f.reviewCount > 0],
  ['response_rate', (f) => f.responseRateKnown],
  ['appointment_availability', (f) => f.appointmentCapacityEnabled],
  ['certifications', (f) => f.activeCertifications > 0],
];

export function completeness<F>(criteria: readonly [string, (f: F) => boolean][], facts: F): { score: number; gaps: string[] } {
  const gaps = criteria.filter(([, met]) => !met(facts)).map(([k]) => k);
  return { score: Math.round((100 * (criteria.length - gaps.length)) / criteria.length), gaps };
}

/** Organization statuses from which a profile may be published (a draft organization goes live with it, DI-18). */
const PUBLISHABLE_ORG = new Set(['draft', 'pending_verification', 'active']);

/** 52 §21: organization active; ≥1 active location; profile; ≥1 active service category; ≥1 supported brand. */
export function providerPublishUnmet(f: ProviderFacts): string[] {
  const unmet: string[] = [];
  if (!PUBLISHABLE_ORG.has(f.orgStatus)) unmet.push('organization_active');
  if (f.publicStatus === 'suspended') unmet.push('profile_not_suspended');
  if (!f.hasProfile) unmet.push('provider_profile');
  if (f.activeLocations === 0) unmet.push('active_location');
  if (f.activeServiceCategories === 0) unmet.push('service_category');
  if (f.activeCoverage === 0) unmet.push('supported_brand');
  return unmet;
}

export interface VendorFacts {
  orgStatus: string;
  hasProfile: boolean;
  publicStatus: string | null;
  descriptionSet: boolean;
  activeLocations: number;
  verifiedLocations: number;
  hoursSet: boolean;
  returnPolicySet: boolean;
  warrantyPolicySet: boolean;
  responseTargetSet: boolean;
  activeCoverage: number;
  catalogComingSoon: boolean;
  /** Active inventory items (inventory module, S5); 0 until it registers. */
  activeItems: number;
}

export const VENDOR_COMPLETENESS: readonly [key: string, met: (f: VendorFacts) => boolean][] = [
  ['business_info', (f) => f.hasProfile && f.descriptionSet],
  ['active_location', (f) => f.activeLocations > 0],
  ['location_verified', (f) => f.verifiedLocations > 0],
  ['hours_set', (f) => f.hoursSet],
  ['return_policy', (f) => f.returnPolicySet],
  ['warranty_policy', (f) => f.warrantyPolicySet],
  ['response_time_target', (f) => f.responseTargetSet],
  ['coverage', (f) => f.activeCoverage > 0],
];

/** 52 §21: organization active; ≥1 active location; profile; ≥1 active item or "catalog coming soon". */
export function vendorPublishUnmet(f: VendorFacts): string[] {
  const unmet: string[] = [];
  if (!PUBLISHABLE_ORG.has(f.orgStatus)) unmet.push('organization_active');
  if (f.publicStatus === 'suspended') unmet.push('profile_not_suspended');
  if (!f.hasProfile) unmet.push('vendor_profile');
  if (f.activeLocations === 0) unmet.push('active_location');
  if (f.activeItems === 0 && !f.catalogComingSoon) unmet.push('active_item_or_coming_soon');
  return unmet;
}

/** Inclusive date range of insights (q: from, to ≤ 366 days). */
export function insightsPeriod(from: string, to: string): FieldError[] {
  if (to < from) return [{ pointer: '/query/to', code: 'order' }];
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  return days > 366 ? [{ pointer: '/query/to', code: 'out_of_range', limit: '366' }] : [];
}

/** 52: dates that must not be in the future (job_date, issued_at), compared on the calendar date (UTC). */
export const isFutureDate = (date: string, now = new Date()): boolean => date > now.toISOString().slice(0, 10);

/**
 * S9b: the slug a published organization gets when it has none, so its
 * public profile (public.org_get by slug) is reachable. Latin letters and
 * digits of the name (diacritics dropped), then the last 12 hex digits of the
 * id for uniqueness; non-Latin names (Persian) give "org-<hex>". Matches the
 * Slug pattern (≤ 80 characters). Owners can change it with org.update.
 */
export function defaultSlug(name: string, orgId: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return `${base || 'org'}-${orgId.replace(/-/g, '').slice(-12)}`;
}
