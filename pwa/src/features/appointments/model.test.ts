// P10.T4/T3 (unit): appointment segments and actions, the status timeline, the check-in window, calendar files, and the
// preferred-time windows (14-day grid, up to 3 choices, wall-clock times at the shop).
import type { Appointment, AppointmentStatusHistory, Slot } from '@carpal/api-contracts';
import { describe, expect, it } from 'vitest';
import {
  actionNeeded,
  actionsOf,
  calendarEvent,
  checkInLater,
  checkInOpen,
  googleCalendarUrl,
  icsFile,
  isSegment,
  lateCancellation,
  outlookCalendarUrl,
  pollInterval,
  reference,
  segmentOf,
  timeline,
  visitSoon,
  visitTime,
} from './model';
import { choiceFromSlot, choiceKey, slotGrid, toggleChoice, windowsOf, zonedToUtc, type WindowChoice } from './times';

const NOW = Date.parse('2026-10-30T08:00:00Z');
const H = 3_600_000;

function appt(o: Partial<Appointment> = {}): Appointment {
  return {
    id: '0195f3b1-6a2b-7c3d-8e4f-00000000a1b2',
    created_at: '2026-10-29T10:00:00Z',
    updated_at: '2026-10-29T10:00:00Z',
    version: 1,
    requester_type: 'user',
    requester_display: 'Sara M.',
    requester_organization_id: null,
    provider: {
      id: 'org-1',
      slug: 'reza-auto',
      name: 'Reza Auto Suspension',
      organization_type: 'provider',
      roles: ['provider'],
      verified: true,
      overall_rating: '4.8',
      review_count: 12,
      top_badges: [],
      price_tier: null,
      measured_response_time_minutes: 120,
      logo_url: null,
      portfolio_thumbnail_url: null,
    },
    provider_location: null,
    provider_location_exact: null,
    vehicle: {
      id: 'v1',
      brand: { text: 'BMW', locale: 'en' },
      model: { text: '320i', locale: 'en' },
      series: null,
      year: 2012,
      nickname: 'Silver',
    },
    source: 'direct_search',
    match_result_id: null,
    related_issue_id: null,
    triage_session_id: null,
    triage_status: 'not_provided',
    safety_flag: false,
    fleet_approval_id: null,
    appointment_type: 'repair',
    service_mode: 'in_shop',
    service_system: null,
    service_task: null,
    symptom: null,
    description: 'Clunk from the front right over bumps',
    content_locale: 'en',
    urgency_level: 'medium',
    customer_expectations: null,
    preferred_contact_channel: 'in_app',
    time_windows: [],
    proposed_start_at: null,
    proposed_end_at: null,
    confirmed_start_at: null,
    confirmed_end_at: null,
    estimated_duration_minutes: null,
    estimated_completion_from: null,
    estimated_completion_to: null,
    parts_availability_note: null,
    checked_in_at: null,
    customer_delay_minutes: null,
    cost_estimate: null,
    consent_to_share_history: false,
    status: 'requested',
    cancelled_by: null,
    cancellation_reason: null,
    completed_at: null,
    service_record_id: null,
    can_review: false,
    allowed_transitions: ['cancelled'],
    requester_contact: null,
    ...o,
  };
}

describe('segments and actions', () => {
  it('maps statuses to the list groups of the backend', () => {
    expect(segmentOf('draft')).toBe('requested');
    expect(segmentOf('alternative_proposed')).toBe('requested');
    expect(segmentOf('awaiting_parts')).toBe('upcoming');
    expect(segmentOf('no_show')).toBe('past');
    expect(segmentOf('cancelled')).toBe('cancelled');
    expect(isSegment('past')).toBe(true);
    expect(isSegment('all')).toBe(false);
    expect(isSegment(null)).toBe(false);
  });

  it('knows what needs the requester', () => {
    expect(actionNeeded(appt({ status: 'alternative_proposed' }), NOW)).toBe('proposed');
    expect(actionNeeded(appt({ status: 'draft' }), NOW)).toBe('draft');
    const soon = appt({
      status: 'confirmed',
      confirmed_start_at: new Date(NOW + H).toISOString(),
      allowed_transitions: ['cancelled', 'checked_in'],
    });
    expect(actionNeeded(soon, NOW)).toBe('checkIn');
    expect(actionNeeded(appt(), NOW)).toBeNull();
  });

  it('offers only what allowed_transitions permits', () => {
    const proposed = actionsOf(appt({ status: 'alternative_proposed', allowed_transitions: ['confirmed', 'requested', 'cancelled'] }), NOW);
    expect(proposed).toMatchObject({ accept: true, counter: true, cancel: true, send: false, delay: false });
    const closed = actionsOf(appt({ status: 'completed', allowed_transitions: [] }), NOW);
    expect(closed).toMatchObject({ accept: false, cancel: false, note: false, editTimes: false });
    expect(actionsOf(appt({ status: 'draft', allowed_transitions: ['requested', 'cancelled'] }), NOW)).toMatchObject({
      send: true,
      note: false,
    });
  });

  it('opens check-in from 2 hours before to 2 hours after the confirmed start', () => {
    const at = (offsetH: number) =>
      appt({
        status: 'confirmed',
        confirmed_start_at: new Date(NOW + offsetH * H).toISOString(),
        allowed_transitions: ['cancelled', 'checked_in'],
      });
    expect(checkInOpen(at(2), NOW)).toBe(true);
    expect(checkInOpen(at(2.5), NOW)).toBe(false);
    expect(checkInOpen(at(-2), NOW)).toBe(true);
    expect(checkInOpen(at(-2.5), NOW)).toBe(false);
    expect(checkInLater(at(3), NOW)).toBe(true);
    expect(checkInLater(at(1), NOW)).toBe(false);
  });

  it('warns about late cancellations and finds visits in the next 24 hours', () => {
    const confirmed = (h: number) => appt({ status: 'confirmed', confirmed_start_at: new Date(NOW + h * H).toISOString() });
    expect(lateCancellation(confirmed(5), NOW)).toBe(true);
    expect(lateCancellation(confirmed(30), NOW)).toBe(false);
    expect(visitSoon(confirmed(5), NOW)).toBe(true);
    expect(visitSoon(confirmed(30), NOW)).toBe(false);
    expect(visitSoon(appt({ status: 'requested' }), NOW)).toBe(false);
  });

  it('polls open appointments only', () => {
    expect(pollInterval('requested')).toBe(30_000);
    expect(pollInterval('completed')).toBe(false);
    expect(pollInterval(undefined)).toBe(false);
  });

  it('shows the confirmed, else the proposed, else the first preferred time', () => {
    const windows = [
      { id: 'w2', start_at: '2026-11-02T06:00:00Z', end_at: '2026-11-02T07:00:00Z', priority: 2 },
      { id: 'w1', start_at: '2026-11-01T06:00:00Z', end_at: '2026-11-01T07:00:00Z', priority: 1 },
    ];
    expect(visitTime(appt({ time_windows: windows }))).toEqual({
      kind: 'preferred',
      start: '2026-11-01T06:00:00Z',
      end: '2026-11-01T07:00:00Z',
    });
    expect(visitTime(appt({ time_windows: windows, proposed_start_at: 'P', proposed_end_at: null }))?.kind).toBe('proposed');
    expect(visitTime(appt({ confirmed_start_at: 'C', confirmed_end_at: null }))?.kind).toBe('confirmed');
    expect(visitTime(appt())).toBeNull();
  });

  it('makes a short reference from the end of the id', () => {
    expect(reference('0195f3b1-6a2b-7c3d-8e4f-00000000a1b2')).toBe('#00A1B2');
  });
});

describe('timeline', () => {
  const h = (
    new_status: AppointmentStatusHistory['new_status'],
    changed_at: string,
    note: string | null = null,
  ): AppointmentStatusHistory => ({
    id: `${new_status}-${changed_at}`,
    old_status: null,
    new_status,
    changed_by_side: 'provider',
    note,
    changed_at,
  });

  it('marks done, now and next with the latest entry per status', () => {
    const history = [
      h('confirmed', '2026-10-29T12:00:00Z', 'Inspect first'),
      h('requested', '2026-10-29T10:00:00Z'),
      h('requested', '2026-10-29T11:00:00Z'),
    ];
    const steps = timeline(appt({ status: 'confirmed' }), history);
    expect(steps.map((s) => s.status)).toEqual(['requested', 'confirmed', 'checked_in', 'in_progress', 'ready_for_pickup', 'completed']);
    expect(steps[0]).toMatchObject({ state: 'done', at: '2026-10-29T11:00:00Z' });
    expect(steps[1]).toMatchObject({ state: 'now', note: 'Inspect first' });
    expect(steps[2]!.state).toBe('next');
  });

  it('shows Awaiting parts only once it happened, and the proposed time as still requested', () => {
    expect(timeline(appt({ status: 'awaiting_parts' }), []).some((s) => s.status === 'awaiting_parts')).toBe(true);
    const proposed = timeline(appt({ status: 'alternative_proposed' }), []);
    expect(proposed.find((s) => s.state === 'now')?.status).toBe('requested');
    expect(timeline(appt({ status: 'completed' }), []).every((s) => s.state === 'done')).toBe(true);
    expect(timeline(appt({ status: 'cancelled' }), [])).toEqual([]);
  });
});

describe('calendar', () => {
  const confirmed = appt({
    status: 'confirmed',
    confirmed_start_at: '2026-11-01T06:30:00Z',
    confirmed_end_at: null,
    estimated_duration_minutes: 90,
  });
  const e = calendarEvent(confirmed, {
    title: 'Car service at Reza, Auto; Suspension',
    location: 'No. 14, Sattarkhan St',
    description: 'Line one\nline two',
    url: 'https://carpal.app/en/appointments/x',
  })!;

  it('ends after the estimated duration when the shop set no end', () => {
    expect(e.end).toBe('2026-11-01T08:00:00.000Z');
    expect(calendarEvent(appt(), { title: '', location: '', description: '', url: '' })).toBeNull();
  });

  it('writes an escaped, CRLF iCalendar file with folded lines', () => {
    const ics = icsFile({ ...e, description: 'x'.repeat(100) }, NOW);
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('DTSTART:20261101T063000Z');
    expect(ics).toContain('DTEND:20261101T080000Z');
    expect(ics).toContain('SUMMARY:Car service at Reza\\, Auto\\; Suspension');
    expect(ics.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
    expect(icsFile(e, NOW)).toContain('DESCRIPTION:Line one\\nline two');
  });

  it('links to Google and Outlook with the same times', () => {
    expect(new URL(googleCalendarUrl(e)).searchParams.get('dates')).toBe('20261101T063000Z/20261101T080000Z');
    expect(new URL(outlookCalendarUrl(e)).searchParams.get('startdt')).toBe('2026-11-01T06:30:00.000Z');
  });
});

describe('time windows', () => {
  it('converts wall-clock time at the shop to an instant', () => {
    expect(zonedToUtc('2026-11-01', 9, 'Asia/Tehran')).toBe('2026-11-01T05:30:00.000Z');
    expect(zonedToUtc('2026-07-01', 9, 'Europe/Berlin')).toBe('2026-07-01T07:00:00.000Z');
  });

  it('lays out 14 days at the shop with future slots only', () => {
    const slot = (start: string): Slot => ({
      start_at: start,
      end_at: new Date(Date.parse(start) + H).toISOString(),
      location_id: 'l1',
      appointment_types: [],
    });
    const grid = slotGrid([slot('2026-10-30T07:00:00Z'), slot('2026-10-30T09:30:00Z'), slot('2026-10-31T05:30:00Z')], 'Asia/Tehran', NOW);
    expect(grid).toHaveLength(14);
    expect(grid[0]).toMatchObject({ date: '2026-10-30' });
    expect(grid[0]!.slots.map((s) => s.start_at)).toEqual(['2026-10-30T09:30:00Z']);
    expect(grid[1]!.slots).toHaveLength(1);
  });

  it('keeps at most 3 choices in the order picked and drops windows in the past', () => {
    const c = (h: number): WindowChoice => ({
      kind: 'slot',
      start: new Date(NOW + h * H).toISOString(),
      end: new Date(NOW + (h + 1) * H).toISOString(),
    });
    let list: WindowChoice[] = [];
    for (const x of [c(5), c(6), c(7), c(8)]) list = toggleChoice(list, x);
    expect(list.map(choiceKey)).toEqual([c(5), c(6), c(7)].map(choiceKey));
    list = toggleChoice(list, c(6));
    expect(list).toHaveLength(2);
    const part: WindowChoice = { kind: 'part', date: '2026-11-02', part: 'afternoon' };
    const windows = windowsOf([c(-1), part, c(5)], 'Asia/Tehran', NOW);
    expect(windows).toEqual([
      { start_at: '2026-11-02T08:30:00.000Z', end_at: '2026-11-02T12:30:00.000Z', priority: 1 },
      { start_at: new Date(NOW + 5 * H).toISOString(), end_at: new Date(NOW + 6 * H).toISOString(), priority: 2 },
    ]);
  });

  it('turns a slot picked on the profile into a choice', () => {
    const s: Slot = { start_at: '2026-11-01T06:00:00Z', end_at: '2026-11-01T06:45:00Z', location_id: 'l1', appointment_types: [] };
    expect(choiceFromSlot('2026-11-01T06:00:00.000Z', [s])).toEqual({
      kind: 'slot',
      start: '2026-11-01T06:00:00.000Z',
      end: '2026-11-01T06:45:00Z',
    });
    expect(choiceFromSlot('2026-11-01T07:00:00.000Z', [s])).toMatchObject({ end: '2026-11-01T08:00:00.000Z' });
  });
});
