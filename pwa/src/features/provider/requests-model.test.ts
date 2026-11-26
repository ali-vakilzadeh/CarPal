// PW3 requests model: segments from one group=new read, safety first, answers from allowed_transitions only, 'My jobs'
// from participants (never the requester), the decline text, durations, the 14 days at the shop, the day's load and
// the AI slot payload.
import type { AiInsight, Appointment, CalendarView, Participant } from '@carpal/api-contracts';
import { describe, expect, it } from 'vitest';
import {
  answersOf,
  cardTime,
  dayLoad,
  declineText,
  defaultDuration,
  isDeclined,
  isMyJob,
  parseTime,
  proposeDays,
  requestSubject,
  segmentGroup,
  segmentItems,
  shouldStartReview,
  slotSuggestion,
  wallDate,
  wallTime,
} from './requests-model';

const apt = (o: Partial<Appointment>): Appointment =>
  ({
    id: 'a',
    status: 'requested',
    safety_flag: false,
    urgency_level: 'medium',
    created_at: '2026-11-25T06:00:00Z',
    confirmed_start_at: null,
    proposed_start_at: null,
    time_windows: [],
    allowed_transitions: [],
    service_task: null,
    service_system: null,
    symptom: null,
    description: 'Knock from the front right over bumps',
    ...o,
  }) as Appointment;

describe('segments (PW-REQ-01)', () => {
  const page = [
    apt({ id: 'p', status: 'alternative_proposed' }),
    apt({ id: 'r', status: 'requested', created_at: '2026-11-25T05:00:00Z' }),
    apt({ id: 's', status: 'provider_reviewing', urgency_level: 'safety_critical', created_at: '2026-11-25T09:00:00Z' }),
  ];

  it('splits the group=new page into New and Proposed, safety-critical first', () => {
    expect(segmentGroup('new')).toBe('new');
    expect(segmentGroup('proposed')).toBe('new');
    expect(segmentGroup('upcoming')).toBe('upcoming');
    expect(segmentItems('new', page).map((a) => a.id)).toEqual(['s', 'r']);
    expect(segmentItems('proposed', page).map((a) => a.id)).toEqual(['p']);
  });

  it('shows the time that matters for the status', () => {
    const now = Date.parse('2026-11-26T00:00:00Z');
    const windows = [
      { id: 'w2', start_at: '2026-11-28T05:30:00Z', end_at: '2026-11-28T08:30:00Z', priority: 2 },
      { id: 'w1', start_at: '2026-11-27T05:30:00Z', end_at: '2026-11-27T08:30:00Z', priority: 1 },
      { id: 'old', start_at: '2026-11-20T05:30:00Z', end_at: '2026-11-20T08:30:00Z', priority: 0 },
    ];
    expect(cardTime(apt({ time_windows: windows }), now)).toEqual({
      kind: 'preferred',
      start: windows[1]!.start_at,
      end: windows[1]!.end_at,
    });
    expect(cardTime(apt({ status: 'alternative_proposed', proposed_start_at: 'X' }), now)?.kind).toBe('proposed');
    expect(cardTime(apt({ status: 'confirmed', confirmed_start_at: 'Y' }), now)?.kind).toBe('confirmed');
    expect(cardTime(apt({}), now)).toBeNull();
  });

  it('names the request by task, service or symptom, else the start of the description', () => {
    expect(requestSubject(apt({ service_task: { text: 'Control arm', locale: 'en' } }))).toBe('Control arm');
    expect(requestSubject(apt({ description: 'x'.repeat(100) }))).toHaveLength(80);
  });
});

describe('answers (PW-REQ-03)', () => {
  it('comes from allowed_transitions only', () => {
    expect(
      answersOf(apt({ status: 'provider_reviewing', allowed_transitions: ['confirmed', 'alternative_proposed', 'cancelled'] })),
    ).toEqual({
      accept: true,
      propose: true,
      decline: true,
      ask: true,
    });
    expect(answersOf(apt({ status: 'provider_reviewing', allowed_transitions: ['cancelled'] }))).toMatchObject({
      accept: false,
      propose: false,
    });
    // A proposal waits for the customer: only a decline (withdraw) remains.
    expect(answersOf(apt({ status: 'alternative_proposed', allowed_transitions: ['cancelled'] }))).toEqual({
      accept: false,
      propose: false,
      decline: true,
      ask: false,
    });
    // A booked visit's cancel belongs to PW4, not to the request answers.
    expect(answersOf(apt({ status: 'confirmed', allowed_transitions: ['cancelled', 'checked_in'] }))).toEqual({
      accept: false,
      propose: false,
      decline: false,
      ask: false,
    });
  });

  it('starts the review only for a new request the server lets move', () => {
    expect(shouldStartReview(apt({ status: 'requested', allowed_transitions: ['provider_reviewing', 'confirmed'] }))).toBe(true);
    expect(shouldStartReview(apt({ status: 'requested', allowed_transitions: [] }))).toBe(false);
    expect(shouldStartReview(apt({ status: 'provider_reviewing', allowed_transitions: ['confirmed'] }))).toBe(false);
  });

  it('writes the decline message: reason in words, with the note, within 500 characters (PRV-BR-05 fallback)', () => {
    expect(isDeclined({ status: 'cancelled', cancelled_by: 'provider', cancellation_reason: 'declined' })).toBe(true);
    expect(isDeclined({ status: 'cancelled', cancelled_by: 'requester', cancellation_reason: 'declined' })).toBe(false);
    expect(declineText('Fully booked', '  ')).toBe('Fully booked');
    expect(declineText('Fully booked', 'Try us next month')).toBe('Fully booked: Try us next month');
    expect([...declineText('Other reason', 'x'.repeat(600))]).toHaveLength(500);
  });

  it('prefills a duration from the estimate, then the AI draft, rounded to an offered one', () => {
    expect(defaultDuration(null)).toBe(60);
    expect(defaultDuration(110)).toBe(120);
    expect(defaultDuration(null, 170)).toBe(180);
    // The AI draft the shop chose wins over the estimate.
    expect(defaultDuration(45, 240)).toBe(240);
  });
});

describe('My jobs (PRV-GD-07)', () => {
  const p = (o: Partial<Participant>): Participant =>
    ({
      id: 'x',
      user_id: 'u1',
      display_name: 'N',
      organization_id: null,
      participant_role: 'technician',
      status: 'active',
      ...o,
    }) as Participant;
  it('counts an active technician or service advisor, never the requester or a removed one', () => {
    expect(isMyJob([p({})], 'u1')).toBe(true);
    expect(isMyJob([p({ participant_role: 'service_advisor' })], 'u1')).toBe(true);
    expect(isMyJob([p({ participant_role: 'requester' })], 'u1')).toBe(false);
    expect(isMyJob([p({ status: 'removed' })], 'u1')).toBe(false);
    expect(isMyJob([p({ user_id: 'u2' })], 'u1')).toBe(false);
  });
});

describe('times at the shop', () => {
  it('lists 14 days from today in the shop time zone', () => {
    // 22:00 UTC on 26 Nov is already 27 Nov in Tehran (UTC+3:30).
    const days = proposeDays('Asia/Tehran', Date.parse('2026-11-26T22:00:00Z'));
    expect(days).toHaveLength(14);
    expect(days[0]).toBe('2026-11-27');
    expect(days[13]).toBe('2026-12-10');
  });

  it('reads wall-clock day and time at the shop', () => {
    expect(wallTime('2026-11-27T10:30:00Z', 'Asia/Tehran')).toBe('14:00');
    expect(wallDate('2026-11-26T21:00:00Z', 'Asia/Tehran')).toBe('2026-11-27');
    expect(parseTime('14:00')).toEqual([14, 0]);
    expect(parseTime('25:00')).toBeNull();
  });

  it("sums the day's load without the request itself", () => {
    const cal = {
      from: '2026-11-27',
      to: '2026-11-27',
      appointments: [apt({ id: 'a', status: 'confirmed' }), apt({ id: 'b', status: 'requested' }), apt({ id: 'me', status: 'confirmed' })],
      time_off: [],
      capacity: [
        { location_id: 'l', start_at: '', end_at: '', used: 1, max: 1 },
        { location_id: 'l', start_at: '', end_at: '', used: 0, max: 1 },
      ],
    } as unknown as CalendarView;
    expect(dayLoad(cal, 'me')).toEqual({ visits: 1, used: 1, max: 2, timeOff: false });
    expect(dayLoad({ ...cal, capacity: [], time_off: [{}] } as unknown as CalendarView)).toMatchObject({
      used: null,
      max: null,
      timeOff: true,
    });
  });
});

describe('AI slot suggestion', () => {
  it('reads the duration payload and nothing it does not carry', () => {
    const insight = {
      structured_payload: {
        suggested_duration_minutes: 120,
        longer_than_requested: true,
        conflict_count: 1,
        customer_need: 'Inspect first',
      },
    } as unknown as AiInsight;
    expect(slotSuggestion(insight)).toEqual({
      suggested_duration_minutes: 120,
      longer_than_requested: true,
      conflict_count: 1,
      customer_need: 'Inspect first',
    });
    expect(slotSuggestion({ structured_payload: { summary: 'x' } } as unknown as AiInsight)).toBeNull();
    expect(slotSuggestion(null)).toBeNull();
  });
});
