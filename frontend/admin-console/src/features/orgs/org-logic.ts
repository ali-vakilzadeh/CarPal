// Rules of the organization screens (AC9, Docs/23 A-ORG-01/02, Docs/40 §7 and §23.2). Kept apart from the screens
// so they are unit-tested: the vocabularies (with "Unknown (…)" for values the console does not know), which status
// changes the backend accepts (admin.org_status), which onboarding flows an organization type can be assisted in
// (admin.assist_session_start), the purpose an organization can be read for (SEC-ADM-5: an open work item — a
// pending verification or an open case; the backend refuses anything else), the public profile link, the
// pin-versus-address verdict of a location and the fields a location correction sends.
import type { Location, OrgStatus, OrgType, StaffOrgView, VerificationStatus } from '@carpal/api-contracts';
import type { AccessPurpose } from '@/lib/api/client';
import { purposeOf } from '@/lib/api/client';
import type { GeoPoint } from '@/lib/config/geo';
import type { Translate, MessageKey } from '@/lib/i18n/keys';

export const ORG_TYPES: readonly OrgType[] = ['provider', 'vendor', 'fleet', 'hybrid_provider_vendor'];
export const ORG_STATUSES: readonly OrgStatus[] = ['draft', 'pending_verification', 'active', 'suspended', 'archived', 'merged'];
export const VERIFICATION_STATUSES: readonly VerificationStatus[] = [
  'unverified',
  'pending',
  'verified',
  'rejected',
  'expired',
  'suspended',
];
export const CHECK_TYPES = ['business_identity', 'address', 'phone', 'email', 'location'] as const;
export type CheckType = (typeof CHECK_TYPES)[number];
export const CHECK_STATUSES = ['pending', 'verified', 'rejected', 'expired'] as const;
export const GEO_SOURCES: readonly Location['geo_source'][] = ['user_pin', 'geocoded', 'admin_corrected'];
export const LOCATION_CHECKS: readonly Location['location_check_status'][] = ['not_checked', 'consistent', 'far_apart'];

/** A label for an enum value; values the console does not know render as "Unknown (<value>)" (PWA P13 rule). */
export function label(known: readonly string[], prefix: string, value: string | null | undefined, t: Translate): string {
  if (value == null) return '—';
  return known.includes(value) ? t(`${prefix}.${value}` as MessageKey) : t('admin.kit.unknown', { value });
}

// ---------------------------------------------------------------- status changes (admin.org_status)

export type StatusChange = 'suspend' | 'reactivate';

/** The backend's accepted transitions (organization admin-ops STATUS_FROM), limited to the two Docs/23 actions. */
export function statusChanges(status: string): StatusChange[] {
  if (['draft', 'pending_verification', 'active'].includes(status)) return ['suspend'];
  if (status === 'suspended' || status === 'archived') return ['reactivate'];
  return []; // merged, or a status the console does not know
}

export const STATUS_TARGET: Record<StatusChange, 'suspended' | 'active'> = { suspend: 'suspended', reactivate: 'active' };

// ---------------------------------------------------------------- assisted onboarding (DI-08)

export type FlowType = 'provider' | 'vendor' | 'fleet';

/** The onboarding flows staff may assist for an organization type (backend FLOW_TYPES); none for merged/archived. */
export function assistFlows(type: string, status: string): FlowType[] {
  if (status === 'merged' || status === 'archived') return [];
  if (type === 'provider') return ['provider'];
  if (type === 'vendor') return ['vendor'];
  if (type === 'hybrid_provider_vendor') return ['provider', 'vendor'];
  if (type === 'fleet') return ['fleet'];
  return [];
}

// ---------------------------------------------------------------- purposes (GD-10, SEC-ADM-5)

/** The work items an organization can be opened for: its pending verifications, oldest first. */
export function verificationPurposes(org: Pick<StaffOrgView, 'verifications'>): { purpose: AccessPurpose; type: string; at: string }[] {
  return org.verifications
    .filter((v) => v.status === 'pending')
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((v) => ({ purpose: purposeOf('verification', v.id), type: v.verification_type, at: v.created_at }));
}

/** The organization page for a work item. */
export function orgHref(orgId: string, purpose?: AccessPurpose | null, tab?: OrgTab): string {
  const q = new URLSearchParams();
  if (tab && tab !== 'profile') q.set('tab', tab);
  if (purpose) q.set('purpose', purpose);
  const s = q.toString();
  return `/orgs/${orgId}${s ? `?${s}` : ''}`;
}

export const ORG_TABS = ['profile', 'locations', 'verification', 'plan'] as const;
export type OrgTab = (typeof ORG_TABS)[number];

/** Docs/23 A-ORG-02 tabs the contract has no read for yet (DI-06, BR-16, BR-31). */
export const MISSING_TABS = ['badges', 'reviews', 'portfolio', 'inventory', 'members', 'cases'] as const;

// ---------------------------------------------------------------- public profile (GD-07)

/** The organization's public page in the public web app (a new tab; only while it is active and has a slug). */
export function publicProfileHref(
  o: Pick<StaffOrgView, 'slug' | 'status' | 'organization_type'>,
  base: string | undefined,
  locale: string,
): string | null {
  if (!base || !o.slug || o.status !== 'active') return null;
  const root = `${base.replace(/\/+$/, '')}/${locale}`;
  if (o.organization_type === 'provider' || o.organization_type === 'hybrid_provider_vendor') return `${root}/shop/${o.slug}`;
  if (o.organization_type === 'vendor') return `${root}/parts-seller/${o.slug}`;
  return null;
}

/** The city of the organization: its primary location's, else the first active one's. */
export function orgCity(o: Pick<StaffOrgView, 'locations' | 'primary_location_id'>): string | null {
  const primary = o.locations.find((l) => l.id === o.primary_location_id) ?? o.locations.find((l) => l.status !== 'inactive');
  return primary?.city ?? null;
}

// ---------------------------------------------------------------- locations

/** The owner's exact point (members and staff only, SEC-OUT-4), or null when the location has none. */
export function pinOf(l: Pick<Location, 'latitude' | 'longitude'>): GeoPoint | null {
  return l.latitude == null || l.longitude == null ? null : { lat: l.latitude, lng: l.longitude };
}

export type PinVerdict = 'far' | 'ok' | 'unchecked';

/** The server's pin-versus-address verdict (never recomputed in the browser). */
export function pinVerdict(l: Pick<Location, 'location_check_status'>): PinVerdict {
  if (l.location_check_status === 'far_apart') return 'far';
  if (l.location_check_status === 'consistent') return 'ok';
  return 'unchecked';
}

/** Active locations whose pin is far from the typed address: a location verification cannot be approved before. */
export function farLocations(o: Pick<StaffOrgView, 'locations'>): Location[] {
  return o.locations.filter((l) => l.status !== 'inactive' && l.location_check_status === 'far_apart');
}

export interface CorrectionDraft {
  lat: string;
  lng: string;
  address_line_1: string;
  address_line_2: string;
  city: string;
  region: string;
  postal_code: string;
}

export function draftOf(l: Location): CorrectionDraft {
  return {
    lat: l.latitude == null ? '' : String(l.latitude),
    lng: l.longitude == null ? '' : String(l.longitude),
    address_line_1: l.address_line_1,
    address_line_2: l.address_line_2 ?? '',
    city: l.city,
    region: l.region ?? '',
    postal_code: l.postal_code ?? '',
  };
}

/** A coordinate typed by staff (Latin or Persian digits, '.' or '٫'), within range and rounded to 6 decimals. */
export function parseCoord(v: string, max: number): number | null {
  const s = v
    .trim()
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace('٫', '.');
  if (!/^-?\d{1,3}(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Math.abs(n) <= max ? Math.round(n * 1e6) / 1e6 : null;
}

export type CorrectionProblem = Partial<Record<keyof CorrectionDraft | 'nothing', 'required' | 'invalid' | 'too_long'>>;

const LIMITS: Partial<Record<keyof CorrectionDraft, [number, number]>> = {
  address_line_1: [2, 160],
  address_line_2: [1, 160],
  city: [1, 100],
  region: [1, 100],
  postal_code: [1, 20],
};

/**
 * The body of admin.location_correct without the reason: only what changed (the pin, or address fields; a cleared
 * optional field is sent as null), or the problems that stop it. Nothing changed = a problem too.
 */
export function correctionBody(l: Location, d: CorrectionDraft): { body: Record<string, unknown>; problems: CorrectionProblem } {
  const problems: CorrectionProblem = {};
  const body: Record<string, unknown> = {};
  const lat = parseCoord(d.lat, 90);
  const lng = parseCoord(d.lng, 180);
  if (lat === null) problems.lat = d.lat.trim() ? 'invalid' : 'required';
  if (lng === null) problems.lng = d.lng.trim() ? 'invalid' : 'required';
  if (lat !== null && lng !== null && (lat !== l.latitude || lng !== l.longitude)) body.pin = { lat, lng };
  const required = new Set<keyof CorrectionDraft>(['address_line_1', 'city']);
  const was: Record<string, string> = draftOf(l) as unknown as Record<string, string>;
  for (const key of ['address_line_1', 'address_line_2', 'city', 'region', 'postal_code'] as const) {
    const v = d[key].replace(/\s+/g, ' ').trim();
    if (v === (was[key] ?? '').trim()) continue;
    const [min, max] = LIMITS[key]!;
    if (!v) {
      if (required.has(key)) problems[key] = 'required';
      else body[key] = null;
      continue;
    }
    if (v.length > max) problems[key] = 'too_long';
    else if (v.length < min) problems[key] = 'invalid';
    else body[key] = v;
  }
  if (!Object.keys(problems).length && !Object.keys(body).length) problems.nothing = 'required';
  return { body, problems };
}
