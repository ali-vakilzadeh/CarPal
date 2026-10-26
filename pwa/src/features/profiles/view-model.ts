// Pure view-model helpers of the public profile, part and showcase pages (P5): opening-hours rows in the region's
// week order (BA-28), the capability matrix (Docs/22 W-PUB-02 "rows: brand/series; columns: service systems"), the
// "Fit for your car" line, rating counts and the before/after pairing of showcase media. No React, no I/O.
import type {
  ConfidenceLevel,
  FitmentConfidence,
  HoursSpec,
  MediaAttachmentView,
  PublicCapability,
  PublicLocation,
  PublicOrgProfile,
  RatingSummary,
  Slot,
} from '@carpal/api-contracts';
import type { BadgeTone } from '@/components/ds/badge';
import type { Locale } from '@/lib/i18n/locales';

// ---------- Opening hours ----------

/** Weekday indices (0 = Sunday, the backend's rule) in display order: Saturday first in fa and the ir-pilot region. */
export function weekOrder(locale: Locale, regionKey: string): number[] {
  if (locale === 'fa' || regionKey === 'ir-pilot') return [6, 0, 1, 2, 3, 4, 5];
  type WeekInfo = { firstDay: number }; // Intl: 1 = Monday … 7 = Sunday
  const loc = new Intl.Locale(locale) as Intl.Locale & { getWeekInfo?: () => WeekInfo; weekInfo?: WeekInfo };
  const info = loc.getWeekInfo?.() ?? loc.weekInfo; // older engines have the getter, or neither (Monday)
  const first = info ? info.firstDay % 7 : 1;
  return Array.from({ length: 7 }, (_, i) => (first + i) % 7);
}

/** Weekday (0 = Sunday) and HH:MM of `now` in a time zone. */
export function localNow(timeZone: string, now: number = Date.now()): { day: number; time: string; date: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday!);
  return { day, time: `${parts.hour}:${parts.minute}`, date: `${parts.year}-${parts.month}-${parts.day}` };
}

export interface HoursRow {
  day: number;
  ranges: { open: string; close: string }[];
  today: boolean;
}

/** One row per weekday in display order; a date exception for today replaces today's ranges. */
export function hoursRows(hours: HoursSpec | null, order: readonly number[], today: { day: number; date: string } | null): HoursRow[] {
  return order.map((day) => {
    let ranges = (hours?.weekly ?? [])
      .filter((h) => h.day_of_week === day)
      .map((h) => ({ open: h.open.slice(0, 5), close: h.close.slice(0, 5) }))
      .sort((a, b) => a.open.localeCompare(b.open));
    const isToday = today?.day === day;
    const exception = isToday ? hours?.exceptions?.find((e) => e.date === today!.date) : undefined;
    if (exception)
      ranges =
        exception.closed || !exception.open || !exception.close
          ? []
          : [{ open: exception.open.slice(0, 5), close: exception.close.slice(0, 5) }];
    return { day, ranges, today: isToday };
  });
}

/** The primary public location: the first one with a point, else the first one. */
export function primaryLocation(p: Pick<PublicOrgProfile, 'locations'>): PublicLocation | null {
  return p.locations.find((l) => l.point) ?? p.locations[0] ?? null;
}

// ---------- Ratings ----------

export function reviewTotal(s: RatingSummary): number {
  return s.count_visit_verified + s.count_approved_without_visit;
}

/** Share (0-100, whole) of each star value in the distribution. */
export function distributionShares(s: RatingSummary): { stars: 1 | 2 | 3 | 4 | 5; count: number; share: number }[] {
  const total = ([1, 2, 3, 4, 5] as const).reduce((n, k) => n + s.distribution[k], 0);
  return ([5, 4, 3, 2, 1] as const).map((stars) => ({
    stars,
    count: s.distribution[stars],
    share: total ? Math.round((s.distribution[stars] / total) * 100) : 0,
  }));
}

// ---------- Capabilities ----------

const LEVEL_RANK: Record<ConfidenceLevel, number> = {
  self_declared: 0,
  low_evidence: 1,
  moderate_evidence: 2,
  strong_evidence: 3,
  verified_expert: 4,
};

export function confidenceTone(level: ConfidenceLevel): BadgeTone {
  return level === 'verified_expert' || level === 'strong_evidence' ? 'accent' : level === 'moderate_evidence' ? 'success' : 'neutral';
}

export function fitmentTone(c: FitmentConfidence): BadgeTone {
  return c === 'confirmed' ? 'success' : 'neutral';
}

export interface MatrixCell {
  level: ConfidenceLevel;
  evidence: number;
}
export interface CapabilityMatrix {
  /** Service systems (columns), by best evidence first. */
  systems: string[];
  rows: { vehicle: string; brand: string | null; cells: Record<string, MatrixCell> }[];
}

/** "BMW 3 Series E90", "BMW", or null for capabilities without a vehicle. */
export function vehicleLabel(c: Pick<PublicCapability, 'brand' | 'model' | 'series'>): string | null {
  const parts = [c.brand?.text, c.model?.text, c.series?.text].filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

/**
 * Rows = vehicles (brand / model / series as published), columns = service systems; a cell keeps the strongest level
 * of its capabilities (tasks fold into their system). Capabilities without a vehicle form the `allModels` row.
 */
export function capabilityMatrix(caps: readonly PublicCapability[], allModels: string): CapabilityMatrix {
  const systemScore = new Map<string, number>();
  const rows = new Map<string, { vehicle: string; brand: string | null; cells: Record<string, MatrixCell> }>();
  for (const c of caps) {
    const system = c.service_system.text;
    const vehicle = vehicleLabel(c) ?? allModels;
    const row = rows.get(vehicle) ?? { vehicle, brand: c.brand?.text ?? null, cells: {} };
    const prev = row.cells[system];
    if (!prev || LEVEL_RANK[c.confidence_level] > LEVEL_RANK[prev.level])
      row.cells[system] = { level: c.confidence_level, evidence: c.evidence_count };
    else if (LEVEL_RANK[c.confidence_level] === LEVEL_RANK[prev.level]) prev.evidence = Math.max(prev.evidence, c.evidence_count);
    rows.set(vehicle, row);
    systemScore.set(system, (systemScore.get(system) ?? 0) + c.evidence_count + LEVEL_RANK[c.confidence_level] * 1000);
  }
  const systems = [...systemScore.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
  const sorted = [...rows.values()].sort((a, b) => {
    if (a.vehicle === allModels) return 1;
    if (b.vehicle === allModels) return -1;
    return a.vehicle.localeCompare(b.vehicle);
  });
  return { systems, rows: sorted };
}

/** The visitor's car as names (the taxonomy labels the profile also uses). */
export interface VehicleNames {
  brand: string;
  model?: string | null;
  series?: string | null;
}

const same = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.localeCompare(b, undefined, { sensitivity: 'base' }) === 0;

/** Capabilities that apply to this car: same brand, and same model/series where the capability names one. */
export function capabilitiesForVehicle(caps: readonly PublicCapability[], car: VehicleNames): PublicCapability[] {
  return caps.filter(
    (c) =>
      same(c.brand?.text, car.brand) &&
      (!c.model || !car.model || same(c.model.text, car.model)) &&
      (!c.series || !car.series || same(c.series.text, car.series)),
  );
}

/** The strongest capability for the car (most specific first on ties): the "Fit for your car" line. */
export function bestFit(caps: readonly PublicCapability[], car: VehicleNames): PublicCapability | null {
  const specificity = (c: PublicCapability) => (c.series ? 2 : c.model ? 1 : 0);
  return (
    [...capabilitiesForVehicle(caps, car)].sort(
      (a, b) =>
        LEVEL_RANK[b.confidence_level] - LEVEL_RANK[a.confidence_level] ||
        b.evidence_count - a.evidence_count ||
        specificity(b) - specificity(a),
    )[0] ?? null
  );
}

/** The strongest public capability overall (page title "BMW suspension specialist"). */
export function topCapability(caps: readonly PublicCapability[]): PublicCapability | null {
  return (
    [...caps].sort((a, b) => LEVEL_RANK[b.confidence_level] - LEVEL_RANK[a.confidence_level] || b.evidence_count - a.evidence_count)[0] ??
    null
  );
}

// ---------- Media ----------

export function servableImages(media: readonly MediaAttachmentView[]): MediaAttachmentView[] {
  return media.filter((m) => m.media_type === 'image').sort((a, b) => a.display_order - b.display_order);
}

/** The first before/after pair (same pair_group_key when given), plus the other images of the gallery. */
export function beforeAfter(media: readonly MediaAttachmentView[]): {
  before: MediaAttachmentView | null;
  after: MediaAttachmentView | null;
  rest: MediaAttachmentView[];
} {
  const images = servableImages(media);
  const after = images.find((m) => m.role === 'after') ?? null;
  const before =
    images.find((m) => m.role === 'before' && (!after?.pair_group_key || m.pair_group_key === after.pair_group_key)) ??
    images.find((m) => m.role === 'before') ??
    null;
  const rest = images.filter((m) => m !== before && m !== after);
  return { before, after, rest };
}

/** The preview image of a page: the after photo, a cover, else the first servable image. */
export function previewImage(media: readonly MediaAttachmentView[]): string | null {
  const images = servableImages(media).filter((m) => m.url);
  return (images.find((m) => m.role === 'after') ?? images.find((m) => m.role === 'cover') ?? images[0])?.url ?? null;
}

// ---------- Slots ----------

/** Slots grouped by their day label (in order), so each time button is short. */
export function slotDays(slots: readonly Slot[], dayLabel: (iso: string) => string): { label: string; slots: Slot[] }[] {
  const days: { label: string; slots: Slot[] }[] = [];
  for (const s of slots) {
    const label = dayLabel(s.start_at);
    const last = days.at(-1);
    if (last?.label === label) last.slots.push(s);
    else days.push({ label, slots: [s] });
  }
  return days;
}
