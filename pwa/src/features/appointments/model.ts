// W-APP-01 view model (P10.T4; Docs/21 C-APP-01..04, Docs/40 §16.1-16.2): list segments, what needs the requester,
// the actions their side may take (allowed_transitions is the server's word, SEC-IC-5), the status timeline from
// appointments.history, the check-in window, polling and the calendar files (.ics, Google and Outlook links).
// Pure functions.
import type { Appointment, AppointmentStatus, AppointmentStatusHistory } from '@carpal/api-contracts';
import type { BadgeTone } from '@/components/ds/badge';
import type { IconName } from '@/components/ds/icon';

/** The list segments of appointments.list (group); "Needs your action" is drawn from Requested and Upcoming. */
export const SEGMENTS = ['upcoming', 'requested', 'past', 'cancelled'] as const;
export type Segment = (typeof SEGMENTS)[number];

export function isSegment(v: string | null | undefined): v is Segment {
  return (SEGMENTS as readonly string[]).includes(v ?? '');
}

/** The backend's REQUESTER_GROUPS (modules/appointment/domain/rules.ts). */
const SEGMENT_OF: Record<AppointmentStatus, Segment> = {
  draft: 'requested',
  requested: 'requested',
  provider_reviewing: 'requested',
  alternative_proposed: 'requested',
  confirmed: 'upcoming',
  checked_in: 'upcoming',
  in_progress: 'upcoming',
  awaiting_parts: 'upcoming',
  ready_for_pickup: 'upcoming',
  completed: 'past',
  no_show: 'past',
  cancelled: 'cancelled',
};

export function segmentOf(status: AppointmentStatus): Segment {
  return SEGMENT_OF[status];
}

export const TERMINAL: readonly AppointmentStatus[] = ['completed', 'cancelled', 'no_show'];

export function isTerminal(status: AppointmentStatus): boolean {
  return TERMINAL.includes(status);
}

export const STATUS_STYLE: Record<AppointmentStatus, { tone: BadgeTone; icon: IconName }> = {
  draft: { tone: 'neutral', icon: 'edit' },
  requested: { tone: 'neutral', icon: 'clock' },
  provider_reviewing: { tone: 'neutral', icon: 'eye' },
  alternative_proposed: { tone: 'signal', icon: 'calendar' },
  confirmed: { tone: 'success', icon: 'check' },
  checked_in: { tone: 'accent', icon: 'pin' },
  in_progress: { tone: 'accent', icon: 'wrench' },
  awaiting_parts: { tone: 'signal', icon: 'part' },
  ready_for_pickup: { tone: 'success', icon: 'car' },
  completed: { tone: 'success', icon: 'check' },
  cancelled: { tone: 'neutral', icon: 'close' },
  no_show: { tone: 'danger', icon: 'alert' },
};

/** 40 appointments.check_in: from 2 hours before to 2 hours after the confirmed start. */
export const CHECK_IN_WINDOW_MS = 2 * 3_600_000;

export function checkInOpensAt(a: Pick<Appointment, 'confirmed_start_at'>): number | null {
  return a.confirmed_start_at ? Date.parse(a.confirmed_start_at) - CHECK_IN_WINDOW_MS : null;
}

/** "I've arrived" works now (the server checks the same window again). */
export function checkInOpen(a: Pick<Appointment, 'status' | 'confirmed_start_at' | 'allowed_transitions'>, now = Date.now()): boolean {
  if (a.status !== 'confirmed' || !a.allowed_transitions.includes('checked_in') || !a.confirmed_start_at) return false;
  const start = Date.parse(a.confirmed_start_at);
  return now >= start - CHECK_IN_WINDOW_MS && now <= start + CHECK_IN_WINDOW_MS;
}

/** A confirmed visit whose check-in window has not opened yet. */
export function checkInLater(a: Pick<Appointment, 'status' | 'confirmed_start_at'>, now = Date.now()): boolean {
  const opens = checkInOpensAt(a);
  return a.status === 'confirmed' && opens !== null && opens > now;
}

/** A confirmed visit in the next 24 hours (the home's Needs your attention). */
export function visitSoon(a: Pick<Appointment, 'status' | 'confirmed_start_at'>, now = Date.now()): boolean {
  if (a.status !== 'confirmed' || !a.confirmed_start_at) return false;
  const start = Date.parse(a.confirmed_start_at);
  return start > now - CHECK_IN_WINDOW_MS && start - now < 24 * 3_600_000;
}

export type ActionNeeded = 'proposed' | 'draft' | 'checkIn';

/** Why an appointment waits for the requester (the "Needs your action" group), or null. */
export function actionNeeded(a: Appointment, now = Date.now()): ActionNeeded | null {
  if (a.status === 'alternative_proposed') return 'proposed';
  if (a.status === 'draft') return 'draft';
  if (checkInOpen(a, now)) return 'checkIn';
  return null;
}

export interface Actions {
  accept: boolean;
  counter: boolean;
  cancel: boolean;
  /** Send a draft (draft → requested). */
  send: boolean;
  /** Change the preferred windows (appointments.update: draft, or requested before the shop starts reviewing). */
  editTimes: boolean;
  delay: boolean;
  checkIn: boolean;
  note: boolean;
}

export function actionsOf(a: Appointment, now = Date.now()): Actions {
  const can = (s: AppointmentStatus) => a.allowed_transitions.includes(s);
  return {
    accept: a.status === 'alternative_proposed' && can('confirmed'),
    counter: a.status === 'alternative_proposed' && can('requested'),
    cancel: can('cancelled'),
    send: a.status === 'draft' && can('requested'),
    editTimes: a.status === 'draft' || a.status === 'requested',
    delay: a.status === 'confirmed',
    checkIn: checkInOpen(a, now),
    note: !isTerminal(a.status) && a.status !== 'draft',
  };
}

/** The visit's time: confirmed, proposed by the shop, or the requester's first preferred window. */
export function visitTime(
  a: Pick<Appointment, 'confirmed_start_at' | 'confirmed_end_at' | 'proposed_start_at' | 'proposed_end_at' | 'time_windows'>,
): { kind: 'confirmed' | 'proposed' | 'preferred'; start: string; end: string | null } | null {
  if (a.confirmed_start_at) return { kind: 'confirmed', start: a.confirmed_start_at, end: a.confirmed_end_at };
  if (a.proposed_start_at) return { kind: 'proposed', start: a.proposed_start_at, end: a.proposed_end_at };
  const first = [...a.time_windows].sort((x, y) => x.priority - y.priority)[0];
  return first ? { kind: 'preferred', start: first.start_at, end: first.end_at } : null;
}

const STEPS: readonly AppointmentStatus[] = [
  'requested',
  'confirmed',
  'checked_in',
  'in_progress',
  'awaiting_parts',
  'ready_for_pickup',
  'completed',
];

/** Where a status sits on the timeline (statuses before confirmation count as "requested"). */
const POSITION: Partial<Record<AppointmentStatus, AppointmentStatus>> = {
  draft: 'requested',
  provider_reviewing: 'requested',
  alternative_proposed: 'requested',
};

export interface TimelineStep {
  status: AppointmentStatus;
  at: string | null;
  note: string | null;
  state: 'done' | 'now' | 'next';
}

/**
 * The status timeline of Docs/21 C-APP-02: Requested → Confirmed → Checked in → In progress → (Awaiting parts) →
 * Ready for pickup → Completed, each with the time and note of its latest history entry. Awaiting parts appears only
 * once it happened. Cancelled and no-show appointments have no timeline (the detail shows the reason instead).
 */
export function timeline(a: Pick<Appointment, 'status'>, history: readonly AppointmentStatusHistory[]): TimelineStep[] {
  if (a.status === 'cancelled' || a.status === 'no_show') return [];
  const sorted = [...history].sort((x, y) => Date.parse(x.changed_at) - Date.parse(y.changed_at));
  const reached = new Set(sorted.map((h) => h.new_status));
  const steps = STEPS.filter((s) => s !== 'awaiting_parts' || reached.has(s) || a.status === s);
  const current = POSITION[a.status] ?? a.status;
  const nowIndex = steps.indexOf(current);
  return steps.map((status, i) => {
    const last = [...sorted].reverse().find((h) => h.new_status === status);
    return {
      status,
      at: last?.changed_at ?? null,
      note: last?.note ?? null,
      state: i < nowIndex || (i === nowIndex && status === 'completed') ? 'done' : i === nowIndex ? 'now' : 'next',
    };
  });
}

/** Live status while the page is open: every 30 s for open appointments (the client honours CarPal-Poll-After-Ms). */
export const POLL_MS = 30_000;

export function pollInterval(status: AppointmentStatus | undefined): number | false {
  return status && !isTerminal(status) ? POLL_MS : false;
}

/** Reasons offered when cancelling (C-APP-04); sent as the cancellation_reason text in the UI language. */
export const CANCEL_REASONS = ['cantMakeIt', 'fixedElsewhere', 'tooExpensive', 'problemGone', 'other'] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];

/** Late-arrival choices in minutes (40 appointments.delay: 5-240). */
export const DELAYS = [10, 15, 30, 45, 60, 90] as const;

/** A short reference for people to quote ("#4F2A9C"): the end of the id, which is random in UUIDv7. */
export function reference(id: string): string {
  return `#${id.replace(/-/g, '').slice(-6).toUpperCase()}`;
}

/** True when a late cancellation (< 24 h before a confirmed visit) is worth a warning (C-APP-04 "late"). */
export function lateCancellation(a: Pick<Appointment, 'status' | 'confirmed_start_at'>, now = Date.now()): boolean {
  if (a.status !== 'confirmed' || !a.confirmed_start_at) return false;
  const start = Date.parse(a.confirmed_start_at);
  return start > now && start - now < 24 * 3_600_000;
}

// ---------------------------------------------------------------- calendar

export interface CalendarEvent {
  uid: string;
  title: string;
  start: string;
  end: string;
  location: string;
  description: string;
  url: string;
}

const DEFAULT_MINUTES = 60;

/** The event of a confirmed (or proposed) visit, or null when no time is set yet. */
export function calendarEvent(
  a: Appointment,
  o: { title: string; location: string; description: string; url: string },
): CalendarEvent | null {
  const start = a.confirmed_start_at ?? a.proposed_start_at;
  if (!start) return null;
  const end =
    (a.confirmed_start_at ? a.confirmed_end_at : a.proposed_end_at) ??
    new Date(Date.parse(start) + (a.estimated_duration_minutes ?? DEFAULT_MINUTES) * 60_000).toISOString();
  return { uid: `${a.id}@carpal.app`, ...o, start, end };
}

/** 20261030T083000Z */
const icsTime = (iso: string) =>
  new Date(iso)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

/** RFC 5545 TEXT escaping. */
const icsText = (s: string) =>
  s
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/[,;]/g, (m) => `\\${m}`);

/** RFC 5545 line folding at 75 octets (UTF-8 aware, continuation lines start with a space). */
function fold(line: string): string {
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    if (bytes + n > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

/** A one-event iCalendar file (Add to calendar → .ics). */
export function icsFile(e: CalendarEvent, now = Date.now()): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//CarPal//Appointments//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${e.uid}`,
    `DTSTAMP:${icsTime(new Date(now).toISOString())}`,
    `DTSTART:${icsTime(e.start)}`,
    `DTEND:${icsTime(e.end)}`,
    `SUMMARY:${icsText(e.title)}`,
    `LOCATION:${icsText(e.location)}`,
    `DESCRIPTION:${icsText(e.description)}`,
    `URL:${e.url}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

export function googleCalendarUrl(e: CalendarEvent): string {
  const q = new URLSearchParams({
    action: 'TEMPLATE',
    text: e.title,
    dates: `${icsTime(e.start)}/${icsTime(e.end)}`,
    details: `${e.description}\n${e.url}`,
    location: e.location,
  });
  return `https://calendar.google.com/calendar/render?${q.toString()}`;
}

export function outlookCalendarUrl(e: CalendarEvent): string {
  const q = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: e.title,
    startdt: new Date(e.start).toISOString(),
    enddt: new Date(e.end).toISOString(),
    body: `${e.description}\n${e.url}`,
    location: e.location,
  });
  return `https://outlook.live.com/calendar/0/deeplink/compose?${q.toString()}`;
}
