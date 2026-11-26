// CarPal Workshop requests (provider plan PW3: PW-REQ-01..03) without React: the list segments, what a card shows,
// which answers the server allows (Appointment.allowed_transitions, PRV-GD-03), the 'My jobs' filter from appointment
// participants (PRV-GD-07; PRV-BR-11 fallback), the decline text (PRV-BR-05 fallback), the 14 days of the Propose
// sheet in the shop's time zone, the day's load from provider.calendar and the AI slot suggestion's payload.
import type {
  AiInsight,
  Appointment,
  AppointmentStatus,
  CalendarView,
  InsightPayload_appointment_slot_suggestion,
  Participant,
} from '@carpal/api-contracts';
import { addDaysIso, todayIso } from '@/lib/format/jalali';
import type { Translate } from '@/lib/i18n/keys';
import { safetyFirst } from './model';

// ---------------------------------------------------------------- list

/**
 * PW-REQ-01 segments. 'new' and 'proposed' share one read (provider.appointments_list group=new holds requested,
 * provider_reviewing and alternative_proposed, backend PROVIDER_GROUPS) split in the browser; 'upcoming' is the
 * confirmed visits (group=upcoming).
 */
export const SEGMENTS = ['new', 'proposed', 'upcoming'] as const;
export type Segment = (typeof SEGMENTS)[number];

export const segmentGroup = (s: Segment): 'new' | 'upcoming' => (s === 'upcoming' ? 'upcoming' : 'new');

export const isSegment = (s: string | null): s is Segment => (SEGMENTS as readonly (string | null)[]).includes(s);

/** The requests of a segment from its group's page, safety-critical first (Docs/11 Ch.5). */
export function segmentItems<A extends Appointment>(segment: Segment, items: readonly A[]): A[] {
  const mine =
    segment === 'new'
      ? items.filter((a) => a.status === 'requested' || a.status === 'provider_reviewing')
      : segment === 'proposed'
        ? items.filter((a) => a.status === 'alternative_proposed')
        : items;
  return safetyFirst(mine);
}

/** "BMW 320i (E90) 2012" */
export function vehicleLine(v: Appointment['vehicle'], digits: (x: string | number) => string = String): string {
  return [v.brand.text, v.model.text, v.series ? `(${v.series.text})` : null, digits(v.year)].filter(Boolean).join(' ');
}

/** What the request is about in a few words: the task, the service, the symptom, else the start of the description. */
export function requestSubject(a: Pick<Appointment, 'service_task' | 'service_system' | 'symptom' | 'description'>): string {
  const named = a.service_task?.text ?? a.service_system?.text ?? a.symptom?.text;
  if (named) return named;
  const chars = [...a.description.trim()];
  return chars.length > 80 ? `${chars.slice(0, 79).join('')}…` : chars.join('');
}

/** The customer's preferred windows in their order of priority; past windows dropped. */
export function preferredWindows(a: Pick<Appointment, 'time_windows'>, now: number): Appointment['time_windows'] {
  return [...a.time_windows].filter((w) => Date.parse(w.end_at) > now).sort((x, y) => x.priority - y.priority);
}

/** The time a card shows: the confirmed visit, else the shop's proposal, else the customer's first preferred window. */
export function cardTime(
  a: Pick<Appointment, 'status' | 'confirmed_start_at' | 'proposed_start_at' | 'time_windows'>,
  now: number,
): { kind: 'confirmed' | 'proposed' | 'preferred'; start: string; end: string | null } | null {
  if (a.confirmed_start_at) return { kind: 'confirmed', start: a.confirmed_start_at, end: null };
  if (a.status === 'alternative_proposed' && a.proposed_start_at) return { kind: 'proposed', start: a.proposed_start_at, end: null };
  const w = preferredWindows(a, now)[0];
  return w ? { kind: 'preferred', start: w.start_at, end: w.end_at } : null;
}

/** The shop's time zone for an appointment: its location's, else the given fallback (the account's). */
export const shopTimeZone = (a: Pick<Appointment, 'provider_location'>, fallback: string) => a.provider_location?.timezone ?? fallback;

// ---------------------------------------------------------------- My jobs

const ASSIGNED_ROLES: readonly Participant['participant_role'][] = ['technician', 'service_advisor'];

/**
 * 'My jobs' (PRV-GD-07): the signed-in member is an active technician or service advisor of the appointment. The
 * requester is a participant too and never counts. Until PRV-BR-11 the participants are read per appointment.
 */
export function isMyJob(participants: readonly Participant[], userId: string): boolean {
  return participants.some((p) => p.user_id === userId && p.status === 'active' && ASSIGNED_ROLES.includes(p.participant_role));
}

// ---------------------------------------------------------------- detail and answers

export const OPEN_STATUSES: readonly AppointmentStatus[] = ['requested', 'provider_reviewing', 'alternative_proposed'];
export const isOpenRequest = (a: Pick<Appointment, 'status'>) => OPEN_STATUSES.includes(a.status);

/** Opening a new request moves it to provider_reviewing (Docs/11 Ch.5), when the server allows that move. */
export const shouldStartReview = (a: Pick<Appointment, 'status' | 'allowed_transitions'>) =>
  a.status === 'requested' && a.allowed_transitions.includes('provider_reviewing');

export interface Answers {
  accept: boolean;
  propose: boolean;
  decline: boolean;
  /** Ask for information: a customer-visible message; the status stays (provider_reviewing). */
  ask: boolean;
}

/** PW-REQ-03 answers from allowed_transitions only (global decision 2); none once the request is no longer open. */
export function answersOf(a: Pick<Appointment, 'status' | 'allowed_transitions'>): Answers {
  const open = isOpenRequest(a);
  const can = (s: AppointmentStatus) => open && a.allowed_transitions.includes(s);
  return {
    accept: can('confirmed'),
    propose: can('alternative_proposed'),
    decline: can('cancelled'),
    ask: open && a.status !== 'alternative_proposed',
  };
}

/** cancellation_reason of a shop's decline (Docs/40 AppointmentTransition; W-APP-01 says "Declined by the shop"). */
export const DECLINED = 'declined';

export const isDeclined = (a: Pick<Appointment, 'status' | 'cancelled_by' | 'cancellation_reason'>) =>
  a.status === 'cancelled' && a.cancelled_by === 'provider' && a.cancellation_reason?.trim().toLowerCase() === DECLINED;

/** Structured decline reasons (PRV-BR-05). */
export const DECLINE_REASONS = ['fully_booked', 'vehicle_not_covered', 'service_not_offered', 'other'] as const;
export type DeclineReason = (typeof DECLINE_REASONS)[number];

export const MAX_REASON = 500;
export const MAX_NOTE = 3000;

/**
 * The customer-visible message of a decline (PRV-BR-05 fallback): the reason in words, then the shop's note. Cut to 500
 * characters.
 */
export function declineText(reasonWords: string, note: string): string {
  const n = note.trim();
  return [...(n ? `${reasonWords}: ${n}` : reasonWords)].slice(0, MAX_REASON).join('');
}

/** "2 h 30 min" in the language's digits. */
export function durationText(t: Translate, minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return t('provider.requests.time.m', { m });
  if (m === 0) return t('provider.requests.time.h', { h });
  return t('provider.requests.time.hm', { h, m });
}

/** Durations offered by Accept and Propose time, in minutes. */
export const DURATIONS = [30, 60, 90, 120, 180, 240] as const;

/** Duration to prefill: the AI draft the shop chose to use, else the appointment's estimate, else one hour; rounded to an offered one. */
export function defaultDuration(estimate: number | null, ai: number | null = null): number {
  const want = ai ?? estimate ?? 60;
  return DURATIONS.reduce((best, d) => (Math.abs(d - want) < Math.abs(best - want) ? d : best), DURATIONS[0]);
}

/** The days of the Propose sheet: today and the next 13 days at the shop (Docs/90 PW-REQ-03 "chips for 14 days"). */
export function proposeDays(timeZone: string, now: number, days = 14): string[] {
  const today = todayIso(timeZone, now);
  return Array.from({ length: days }, (_, i) => addDaysIso(today, i));
}

/** "HH:MM" wall-clock time at the shop of an instant. */
export function wallTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

/** The calendar day at the shop of an instant. */
export const wallDate = (iso: string, timeZone: string) => todayIso(timeZone, Date.parse(iso));

/** "HH:MM" → [hours, minutes], or null. */
export function parseTime(v: string): [number, number] | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

// ---------------------------------------------------------------- the day's load

const HOLDS_CAPACITY: readonly AppointmentStatus[] = ['confirmed', 'checked_in', 'in_progress', 'awaiting_parts', 'ready_for_pickup'];

export interface DayLoad {
  /** Visits that hold capacity that day (other than this request). */
  visits: number;
  /** Capacity used and offered over the day's slots; null when the shop has no slots that day. */
  used: number | null;
  max: number | null;
  timeOff: boolean;
}

/** The day's load from provider.calendar (one day): booked visits, slot capacity used of offered, time off. */
export function dayLoad(cal: CalendarView, exceptId?: string): DayLoad {
  const visits = cal.appointments.filter((a) => a.id !== exceptId && HOLDS_CAPACITY.includes(a.status)).length;
  const max = cal.capacity.reduce((n, c) => n + c.max, 0);
  const used = cal.capacity.reduce((n, c) => n + c.used, 0);
  return { visits, used: max > 0 ? used : null, max: max > 0 ? max : null, timeOff: cal.time_off.length > 0 };
}

// ---------------------------------------------------------------- AI slot suggestion

/**
 * The AI slot suggestion's payload (Docs/40 ai.appointment_suggestions; insight appointment_slot_suggestion): a
 * duration, whether it is longer than asked, the number of conflicts and the customer's need. It names no start time:
 * the screen shows it as a labelled draft and only prefills the duration (MVP §7.3F: Neda decides).
 */
export function slotSuggestion(insight: AiInsight | null): InsightPayload_appointment_slot_suggestion | null {
  const p = insight?.structured_payload as Partial<InsightPayload_appointment_slot_suggestion> | null | undefined;
  if (!p || typeof p.suggested_duration_minutes !== 'number') return null;
  return {
    suggested_duration_minutes: p.suggested_duration_minutes,
    longer_than_requested: p.longer_than_requested === true,
    conflict_count: typeof p.conflict_count === 'number' ? p.conflict_count : 0,
    customer_need: typeof p.customer_need === 'string' ? p.customer_need : '',
  };
}
