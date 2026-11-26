// Rules of the compact onboarding (provider plan PW2, PW-ONB-01..04) without React: the steps, where a returning
// owner resumes, which business is being set up, the publish requirements in the owner's words, and the working-hours
// preset. The server decides what is publishable (Docs/56 §2.10, backend providerPublishUnmet); nothing here is
// copied as a rule, it only says which step fixes what the server reported (PRV-GD-03).
import type { AvailabilityRuleWrite, HoursSpec, ProviderType, ServiceMode } from '@carpal/api-contracts';
import type { Business } from './model';

/** The four screens; their keys are what onboarding.update saves as current_step (flow_type 'provider'). */
export const ONB_STEPS = ['business', 'location', 'services', 'hours'] as const;
export type OnbStep = (typeof ONB_STEPS)[number];

export const isOnbStep = (v: unknown): v is OnbStep => typeof v === 'string' && (ONB_STEPS as readonly string[]).includes(v);

/** What the server already holds for the business being set up (read when an owner comes back). */
export interface SetupFacts {
  hasProfile: boolean;
  locations: number;
  categories: number;
  brands: number;
}

/** The first step whose required data is missing; 'hours' when everything the profile needs exists. */
export function dataStep(f: SetupFacts): OnbStep {
  if (!f.hasProfile) return 'business';
  if (f.locations === 0) return 'location';
  if (f.categories === 0 || f.brands === 0) return 'services';
  return 'hours';
}

/**
 * Where a returning owner continues: the saved step (onboarding.update current_step), but never past the first step
 * whose data is missing. The saved step can be stale (one flow row per user, shared by every business they set up,
 * and a completed row keeps current_step 'done'), so without a usable saved step the data decides.
 */
export function resumeStep(saved: string | null | undefined, facts: SetupFacts | null): OnbStep {
  if (!facts) return 'business';
  const fromData = dataStep(facts);
  if (!isOnbStep(saved)) return fromData;
  return ONB_STEPS.indexOf(saved) < ONB_STEPS.indexOf(fromData) ? saved : fromData;
}

/**
 * The business being set up: an unpublished business (organization still 'draft') the user owns. The active business
 * of the switch wins when it is one; otherwise the first. null: a new business starts at step 1.
 */
export function pickDraft(businesses: readonly Business[], activeId: string | null): Business | null {
  const drafts = businesses.filter((b) => b.orgStatus === 'draft' && b.role === 'provider_owner');
  return drafts.find((b) => b.orgId === activeId) ?? drafts[0] ?? null;
}

/**
 * Publish requirements (Problem.requirements of PUBLISH_REQUIREMENTS_UNMET, backend profile-rules.ts) → the step that
 * fixes each; null for those the owner cannot fix here (dictionary provider.onboarding.unmet.<key>).
 */
export const REQUIREMENT_STEP: Readonly<Record<string, OnbStep | null>> = {
  provider_profile: 'business',
  active_location: 'location',
  service_category: 'services',
  supported_brand: 'services',
  organization_active: null,
  profile_not_suspended: null,
};

export const KNOWN_REQUIREMENTS = Object.keys(REQUIREMENT_STEP);

/** The requirements in display order, unknown keys last (shown as the generic line). */
export function unmetItems(requirements: readonly string[]): { key: string; step: OnbStep | null; known: boolean }[] {
  return [...new Set(requirements)]
    .map((key) => ({ key, step: REQUIREMENT_STEP[key] ?? null, known: key in REQUIREMENT_STEP }))
    .sort((a, b) => (a.step ? ONB_STEPS.indexOf(a.step) : 9) - (b.step ? ONB_STEPS.indexOf(b.step) : 9));
}

// ---------------------------------------------------------------- step 1

/** Business types offered on the phone, most common first (ProviderType; the rest in the Web UI). */
export const QUICK_TYPES = [
  'independent_mechanic',
  'garage',
  'mobile_mechanic',
  'body_shop',
  'tire_wheel_specialist',
  'diagnostics_specialist',
  'ev_hybrid_specialist',
  'transmission_specialist',
] as const satisfies readonly ProviderType[];

/** A mobile mechanic goes to the customer; everyone else works in the shop (changed later in the Web UI). */
export const serviceModesFor = (t: ProviderType): ServiceMode[] => (t === 'mobile_mechanic' ? ['mobile'] : ['in_shop']);

/** Country of a location from the region key ('ir-pilot' → 'IR') when the map gave no address. */
export const regionCountry = (regionKey: string) => (regionKey.split('-')[0] ?? '').toUpperCase();

/** Default radius of a mobile mechanic (Docs/56 §2.11: the circle replaces the street address). */
export const DEFAULT_RADIUS_KM = 10;

// ---------------------------------------------------------------- step 4

export interface DayHours {
  /** 0 = Sunday … 6 = Saturday (backend availability rules, getUTCDay). */
  day: number;
  open: boolean;
  start: string;
  end: string;
}

/**
 * The one preset (PW-ONB-04): Saturday to Wednesday 08:00-18:00, Thursday 08:00-13:00, Friday closed: the usual week
 * of an Iranian workshop (the pilot region).
 */
export function presetHours(): DayHours[] {
  return [0, 1, 2, 3, 4, 5, 6].map((day) =>
    day === 5
      ? { day, open: false, start: '08:00', end: '13:00' }
      : day === 4
        ? { day, open: true, start: '08:00', end: '13:00' }
        : { day, open: true, start: '08:00', end: '18:00' },
  );
}

/** Days in the order of the week of the language: Saturday first in Persian, Monday first in English. */
export function weekOrder(locale: string): number[] {
  return locale === 'fa' ? [6, 0, 1, 2, 3, 4, 5] : [1, 2, 3, 4, 5, 6, 0];
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Days whose times cannot be saved: a bad time or a close that is not after the open. */
export function badDays(hours: readonly DayHours[]): number[] {
  return hours.filter((h) => h.open && (!HHMM.test(h.start) || !HHMM.test(h.end) || h.end <= h.start)).map((h) => h.day);
}

export const openDays = (hours: readonly DayHours[]) => hours.filter((h) => h.open);

/** The location's opening hours (Location.hours: what customers see and what completeness 'hours_set' reads). */
export function hoursSpec(hours: readonly DayHours[]): HoursSpec {
  return { weekly: openDays(hours).map((h) => ({ day_of_week: h.day, open: h.start, close: h.end })) };
}

/** Slot length of the bookable hours: one hour (changed later in the Web UI). */
export const SLOT_MINUTES = 60;

/**
 * One availability rule per open day: capacity 1 and the server's default buffer (a buffer above 0 or a capacity above
 * 1 needs the plan's capacity tools, appointment_capacity_tools_enabled).
 */
export function availabilityRules(hours: readonly DayHours[], locationId: string): AvailabilityRuleWrite[] {
  return openDays(hours).map((h) => ({
    location_id: locationId,
    day_of_week: h.day,
    start_time: h.start,
    end_time: h.end,
    slot_duration_minutes: SLOT_MINUTES,
    max_concurrent_appointments: 1,
  }));
}

/** The If-Match of a versioned record (SEC-IC-3: ETag "v<version>"), for records read from a list. */
export const ifMatchOf = (version: number) => `"v${version}"`;
