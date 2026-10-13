// Appointment rules (40 §16.1, 52 §12, §21): the transition table per side
// (the same table as appointment.transition_allowed in the database, which
// enforces it again by trigger, SEC-IC-5), list groups, time-window and
// check-in rules, and slot computation for public.availability and the
// calendar. Pure functions.
import type { FieldError } from '#libs/contract/index.js';
import { addDays, localParts, zonedToUtc } from '#libs/geo/index.js';

export type Side = 'requester' | 'provider';

export type AppointmentStatus =
  | 'draft'
  | 'requested'
  | 'provider_reviewing'
  | 'alternative_proposed'
  | 'confirmed'
  | 'checked_in'
  | 'in_progress'
  | 'awaiting_parts'
  | 'ready_for_pickup'
  | 'completed'
  | 'cancelled'
  | 'no_show';

const TRANSITIONS: Record<Side, Partial<Record<AppointmentStatus, AppointmentStatus[]>>> = {
  requester: {
    draft: ['requested', 'cancelled'],
    requested: ['cancelled'],
    provider_reviewing: ['cancelled'],
    alternative_proposed: ['confirmed', 'requested', 'cancelled'],
    confirmed: ['cancelled', 'checked_in'],
  },
  provider: {
    requested: ['provider_reviewing', 'confirmed', 'alternative_proposed', 'cancelled'],
    provider_reviewing: ['confirmed', 'alternative_proposed', 'cancelled'],
    alternative_proposed: ['cancelled'],
    confirmed: ['checked_in', 'no_show', 'cancelled'],
    checked_in: ['in_progress', 'cancelled'],
    in_progress: ['awaiting_parts', 'ready_for_pickup', 'completed'],
    awaiting_parts: ['in_progress', 'cancelled'],
    ready_for_pickup: ['completed'],
  },
};

export function transitionAllowed(side: Side, from: string, to: string): boolean {
  return (TRANSITIONS[side][from as AppointmentStatus] ?? []).includes(to as AppointmentStatus);
}

/** 40 Appointment.allowed_transitions for the caller's side. */
export function allowedTransitions(side: Side, status: string): AppointmentStatus[] {
  return [...(TRANSITIONS[side][status as AppointmentStatus] ?? [])];
}

/** Statuses that hold capacity (appointment.capacity_available, appointments_capacity_idx). */
export const CAPACITY_STATUSES = ['confirmed', 'checked_in', 'in_progress', 'awaiting_parts', 'ready_for_pickup'] as const;
/** Open requests (SEC-BF-3 caps). */
export const OPEN_REQUEST_STATUSES = ['requested', 'provider_reviewing', 'alternative_proposed'] as const;
export const TERMINAL = ['completed', 'cancelled', 'no_show'] as const;
/** Editable by the requester (40 appointments.update: draft, or requested before the provider started reviewing). */
export const REQUESTER_EDITABLE = ['draft', 'requested'] as const;

/** 40 appointments.list group (requester). */
export const REQUESTER_GROUPS: Record<'upcoming' | 'past' | 'requested' | 'cancelled', readonly string[]> = {
  upcoming: CAPACITY_STATUSES,
  past: ['completed', 'no_show'],
  requested: ['draft', ...OPEN_REQUEST_STATUSES],
  cancelled: ['cancelled'],
};

/** 40 provider.appointments_list group ("today" is the upcoming statuses on today's date). */
export const PROVIDER_GROUPS: Record<'new' | 'today' | 'upcoming' | 'in_progress' | 'closed', readonly string[]> = {
  new: OPEN_REQUEST_STATUSES,
  today: CAPACITY_STATUSES,
  upcoming: ['confirmed'],
  in_progress: ['checked_in', 'in_progress', 'awaiting_parts', 'ready_for_pickup'],
  closed: TERMINAL,
};

/** SEC-BF-3: open requests one requester may have with one provider, and in total (proposed launch values). */
export const MAX_OPEN_PER_PROVIDER = 3;
export const MAX_OPEN_TOTAL = 10;
/** SEC-BF-3: cooldown after a no_show before the same requester may request the same provider again. */
export const NO_SHOW_COOLDOWN_MS = 7 * 86_400_000;

/** 40 appointments.check_in: from 2 hours before to 2 hours after the confirmed start. */
export const CHECK_IN_WINDOW_MS = 2 * 3_600_000;
/** SEC-LT-3 ci link: until confirmed_end_at + 12 h. */
export const CHECK_IN_LINK_GRACE_MS = 12 * 3_600_000;
/** 52 §21: a confirmed appointment whose time passed is Path 1 evidence 24 h after the scheduled time. */
export const PATH1_DELAY_MS = 24 * 3_600_000;
/** 40 Appointment.requester_contact: until 30 days after completion. */
export const CONTACT_DAYS_AFTER_COMPLETION = 30;
/** 40 TimeWindowInput: ≤ 30 days ahead. */
export const MAX_WINDOW_AHEAD_MS = 30 * 86_400_000;
/** Duration assumed for an appointment without confirmed_end_at or estimate (calendar, ci link expiry). */
export const DEFAULT_DURATION_MIN = 60;

export interface TimeWindowInput {
  start_at: string;
  end_at: string;
  priority: number;
}

/** 40 TimeWindowInput rules: future, end after start, ≤ 30 days ahead. Returns field errors (pointer suffixes). */
export function windowErrors(windows: readonly TimeWindowInput[], now: number, base = '/time_windows'): FieldError[] {
  const errors: FieldError[] = [];
  windows.forEach((w, i) => {
    const s = Date.parse(w.start_at);
    const e = Date.parse(w.end_at);
    if (s <= now) errors.push({ pointer: `${base}/${i}/start_at`, code: 'in_past' });
    else if (s > now + MAX_WINDOW_AHEAD_MS) errors.push({ pointer: `${base}/${i}/start_at`, code: 'out_of_range' });
    if (e <= s) errors.push({ pointer: `${base}/${i}/end_at`, code: 'out_of_range' });
  });
  return errors;
}

/** End of an appointment for capacity and links: confirmed end, else start + estimate, else start + default. */
export function effectiveEnd(a: {
  confirmed_start_at: Date | string | null;
  confirmed_end_at: Date | string | null;
  estimated_duration_minutes: number | null;
}): Date | null {
  if (!a.confirmed_start_at) return null;
  if (a.confirmed_end_at) return new Date(a.confirmed_end_at);
  return new Date(new Date(a.confirmed_start_at).getTime() + (a.estimated_duration_minutes ?? DEFAULT_DURATION_MIN) * 60_000);
}

export function withinCheckInWindow(start: Date | string | null, now: number): boolean {
  if (!start) return false;
  const s = new Date(start).getTime();
  return now >= s - CHECK_IN_WINDOW_MS && now <= s + CHECK_IN_WINDOW_MS;
}

/**
 * Path 1 eligibility of the requester's own appointment (52 §21
 * appointment_verified): it reached confirmed, was not cancelled or a no-show,
 * and either the shop completed it or 24 h passed since the scheduled time.
 */
export function visitTookPlace(
  a: { status: string; confirmed_start_at: Date | string | null; completed_at: Date | string | null },
  now: number,
): boolean {
  if (a.status === 'completed') return true;
  if (!(CAPACITY_STATUSES as readonly string[]).includes(a.status) || !a.confirmed_start_at) return false;
  return new Date(a.confirmed_start_at).getTime() + PATH1_DELAY_MS <= now;
}

// ------------------------------------------------------------------ slots

export interface AvailabilityRuleInput {
  location_id: string;
  day_of_week: number;
  /** HH:MM or HH:MM:SS (location time zone). */
  start_time: string;
  end_time: string;
  slot_duration_minutes: number;
  appointment_types: string[];
  max_concurrent_appointments: number;
  buffer_minutes: number;
  effective_from: string | null;
  effective_to: string | null;
}

export interface Interval {
  start: Date;
  end: Date;
}

export interface Slot {
  start_at: string;
  end_at: string;
  location_id: string;
  appointment_types: string[];
}

export interface CapacityCell {
  location_id: string;
  start_at: string;
  end_at: string;
  used: number;
  max: number;
}

const APPOINTMENT_TYPES = ['diagnosis', 'repair', 'inspection', 'bodywork_estimate', 'parts_installation'];

const overlaps = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end;
const hhmm = (t: string) => t.slice(0, 5);

function ruleApplies(r: AvailabilityRuleInput, date: string, dow: number, type: string | undefined): boolean {
  if (r.day_of_week !== dow) return false;
  if (r.effective_from && date < r.effective_from) return false;
  if (r.effective_to && date > r.effective_to) return false;
  return !type || r.appointment_types.length === 0 || r.appointment_types.includes(type);
}

/**
 * Capacity cells of one location (the calendar's used versus maximum per
 * slot): every slot of every applying rule, with the appointments that
 * overlap it extended by the rule's buffer on both sides (the same overlap as
 * appointment.capacity_available).
 */
export function capacityCells(o: {
  rules: readonly AvailabilityRuleInput[];
  timezone: string;
  from: string;
  days: number;
  busy: readonly Interval[];
  type?: string;
}): (CapacityCell & { appointment_types: string[] })[] {
  const out: (CapacityCell & { appointment_types: string[] })[] = [];
  for (let i = 0; i < o.days; i++) {
    const date = addDays(o.from, i);
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    for (const r of o.rules) {
      if (!ruleApplies(r, date, dow, o.type)) continue;
      const step = r.slot_duration_minutes * 60_000;
      const dayEnd = zonedToUtc(date, hhmm(r.end_time), o.timezone).getTime();
      for (let s = zonedToUtc(date, hhmm(r.start_time), o.timezone).getTime(); s + step <= dayEnd; s += step) {
        const slot = { start: new Date(s), end: new Date(s + step) };
        const buffer = r.buffer_minutes * 60_000;
        const used = o.busy.filter((b) =>
          overlaps({ start: new Date(b.start.getTime() - buffer), end: new Date(b.end.getTime() + buffer) }, slot),
        ).length;
        out.push({
          location_id: r.location_id,
          start_at: slot.start.toISOString(),
          end_at: slot.end.toISOString(),
          used: Math.min(used, 100),
          max: r.max_concurrent_appointments,
          appointment_types: r.appointment_types.length ? [...r.appointment_types] : [...APPOINTMENT_TYPES],
        });
      }
    }
  }
  return out;
}

/**
 * 40 public.availability: open slots of one location for `days` days from
 * `from` (location dates), computed from availability rules, buffers,
 * capacity, time off and existing appointments; past slots are left out and
 * overlapping rules merge into one slot per start and end. ≤ 500 slots.
 */
export function openSlots(o: {
  rules: readonly AvailabilityRuleInput[];
  timezone: string;
  from: string;
  days: number;
  busy: readonly Interval[];
  timeOff: readonly Interval[];
  now: Date;
  type?: string;
}): Slot[] {
  const merged = new Map<string, Slot & { free: boolean }>();
  for (const c of capacityCells(o)) {
    const slot = { start: new Date(c.start_at), end: new Date(c.end_at) };
    if (slot.start <= o.now || o.timeOff.some((t) => overlaps(t, slot))) continue;
    const k = `${c.start_at}|${c.end_at}`;
    const free = c.used < c.max;
    const prev = merged.get(k);
    if (prev) {
      prev.free ||= free;
      for (const t of c.appointment_types) if (!prev.appointment_types.includes(t)) prev.appointment_types.push(t);
    } else
      merged.set(k, { start_at: c.start_at, end_at: c.end_at, location_id: c.location_id, appointment_types: c.appointment_types, free });
  }
  return [...merged.values()]
    .filter((s) => s.free)
    .sort((a, b) => a.start_at.localeCompare(b.start_at) || a.end_at.localeCompare(b.end_at))
    .slice(0, 500)
    .map(({ free: _free, ...s }) => ({ ...s, appointment_types: s.appointment_types.slice(0, 5) }));
}

/** Today's date in a time zone (the default `from` of slot reads). */
export const todayIn = (timezone: string, now: Date): string => localParts(now, timezone).date;
