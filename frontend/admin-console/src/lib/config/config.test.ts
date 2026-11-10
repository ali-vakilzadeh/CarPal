// AC5.T2/T7 unit tests: reason codes (compose, check, parse; SEC-ADM-3 limits) and SLA timers (OQ-05 targets,
// working days in the staff member's time zone, colours).
import { describe, expect, it } from 'vitest';
import { REASON_SETS, checkReason, composeReason, isValidReason, noteLimit, parseReason, reasonReady, REASON_CODES } from './reasons';
import { addWorkingDays, dueAt, slaState, weekdayIn, worse, SLA_TARGETS } from './sla';
import en from '@/lib/i18n/locales/en.json';

describe('reasons (AC5.T2)', () => {
  it('needs a code from the list of the action kind', () => {
    expect(checkReason('approve_change', { code: '', note: '' })).toEqual({ code: 'required' });
    expect(checkReason('approve_change', { code: 'fraud', note: '' }).code).toBe('required');
    expect(reasonReady('approve_change', { code: 'checked_and_correct', note: '' })).toBe(true);
  });

  it('requires a note for rejections, removals and suspensions, and for "other"', () => {
    for (const kind of ['reject_change', 'rejection', 'removal', 'suspension'] as const) {
      expect(REASON_SETS[kind].noteRequired).toBe(true);
      expect(checkReason(kind, { code: REASON_SETS[kind].codes[0]!, note: '  ' }).note).toBe('required');
    }
    expect(checkReason('approve_change', { code: 'other', note: '' }).note).toBe('required');
    expect(reasonReady('approve_change', { code: 'other', note: 'see ticket 12' })).toBe(true);
  });

  it('composes "<code>: <note>" within the contract limit of 500 characters', () => {
    expect(composeReason({ code: 'values_incorrect', note: ' rate  is\n off ' })).toBe('values_incorrect: rate  is off');
    expect(composeReason({ code: 'planned_change', note: '' })).toBe('planned_change');
    const limit = noteLimit('values_incorrect');
    expect(limit).toBe(500 - 'values_incorrect: '.length);
    expect(checkReason('reject_change', { code: 'values_incorrect', note: 'x'.repeat(limit + 1) }).note).toBe('too_long');
    expect(composeReason({ code: 'values_incorrect', note: 'x'.repeat(limit) })).toHaveLength(500);
  });

  it('accepts only reasons of 3–500 characters (the kit sends nothing else)', () => {
    expect(isValidReason('ab')).toBe(false);
    expect(isValidReason('   abc   ')).toBe(true);
    expect(isValidReason('x'.repeat(501))).toBe(false);
    expect(isValidReason(undefined)).toBe(false);
  });

  it('parses stored reasons back into code and note; foreign text stays a note', () => {
    expect(parseReason('values_incorrect: rate is off')).toEqual({ code: 'values_incorrect', note: 'rate is off' });
    expect(parseReason('planned_change')).toEqual({ code: 'planned_change', note: '' });
    expect(parseReason('دلیل آزاد')).toEqual({ code: null, note: 'دلیل آزاد' });
    expect(parseReason('unknown_code: x')).toEqual({ code: null, note: 'unknown_code: x' });
  });

  it('has an English label for every code', () => {
    const labels = (en.admin.reasons.codes as Record<string, string>) ?? {};
    for (const code of REASON_CODES) expect(labels[code], code).toBeTruthy();
  });
});

describe('SLA timers (AC5.T7, OQ-05)', () => {
  const TZ = 'Asia/Tehran';
  // 2026-11-11 is a Wednesday; Thursday 12, Friday 13 (weekend in Iran), Saturday 14.
  const wed = Date.parse('2026-11-11T06:00:00Z');

  it('knows the weekday in the staff member’s time zone', () => {
    expect(weekdayIn(wed, TZ)).toBe(3);
    // 22:00 UTC on Thursday is already Friday in Tehran (+03:30).
    expect(weekdayIn(Date.parse('2026-11-12T22:00:00Z'), TZ)).toBe(5);
  });

  it('skips the weekend when adding working days', () => {
    expect(new Date(addWorkingDays(wed, 1, TZ)).toISOString()).toBe('2026-11-12T06:00:00.000Z');
    // Thursday, then Friday is skipped, Saturday counts.
    expect(new Date(addWorkingDays(wed, 2, TZ)).toISOString()).toBe('2026-11-14T06:00:00.000Z');
    expect(new Date(addWorkingDays(wed, 2, TZ, [])).toISOString()).toBe('2026-11-13T06:00:00.000Z');
  });

  it('computes targets in hours or working days', () => {
    expect(dueAt(wed, SLA_TARGETS.reportUrgent, TZ) - wed).toBe(4 * 3_600_000);
    expect(dueAt(wed, SLA_TARGETS.dispute, TZ)).toBe(Date.parse('2026-11-17T06:00:00Z'));
  });

  it('turns amber at 75 % of the window and red at the target', () => {
    const start = 0;
    const due = 100;
    expect(slaState(start, due, 10)).toBe('ok');
    expect(slaState(start, due, 75)).toBe('warn');
    expect(slaState(start, due, 100)).toBe('breach');
    expect(slaState(start, start, 0)).toBe('breach');
    expect(worse('ok', 'warn')).toBe('warn');
    expect(worse('breach', 'warn')).toBe('breach');
  });
});
