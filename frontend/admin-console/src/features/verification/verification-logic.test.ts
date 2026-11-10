// AC9 unit tests of the verification rules: the checklist per check type, when Approve is blocked, the checklist at
// the end of the reason (never past 500 characters), the rejection message and the SLA timer.
import { describe, expect, it } from 'vitest';
import { REASON_MAX } from '@/lib/config/reasons';
import { approveBlock, checklistFor, oldestFirst, rejectionProblem, verificationTimer, withChecklist } from './verification-logic';

describe('verification rules (AC9)', () => {
  it('asks the Docs/23 checklist items that fit the check', () => {
    expect(checklistFor('business_identity')).toEqual(['details_match', 'contact_verified', 'taxonomy_consistent', 'no_duplicate']);
    expect(checklistFor('location')).toEqual(['address_matches_pin', 'reports_checked']);
    expect(checklistFor('address')).toEqual(['address_matches_pin', 'reports_checked']);
    expect(checklistFor('phone')).toEqual(['contact_verified']);
    expect(checklistFor('a_new_type')).toEqual(['details_match']);
  });

  it('blocks Approve for a far pin, an open checklist or a decided check', () => {
    const all = checklistFor('location');
    expect(approveBlock({ status: 'pending', type: 'location', farApart: true, ticked: all })).toBe('far_apart');
    expect(approveBlock({ status: 'pending', type: 'location', farApart: false, ticked: all.slice(1) })).toBe('checklist');
    expect(approveBlock({ status: 'pending', type: 'location', farApart: false, ticked: all })).toBeNull();
    // A far pin does not block a business identity check.
    expect(
      approveBlock({ status: 'pending', type: 'business_identity', farApart: true, ticked: checklistFor('business_identity') }),
    ).toBeNull();
    expect(approveBlock({ status: 'verified', type: 'phone', farApart: false, ticked: ['contact_verified'] })).toBe('not_pending');
  });

  it('puts the checklist at the end of the reason and never passes 500 characters', () => {
    expect(withChecklist('documents_match', ['details_match', 'no_duplicate'])).toBe(
      'documents_match [checklist: details_match, no_duplicate]',
    );
    expect(withChecklist('details_mismatch: wrong name', [])).toBe('details_mismatch: wrong name [checklist: none]');
    const long = withChecklist(`other: ${'x'.repeat(493)}`, ['details_match']);
    expect(long.length).toBeLessThanOrEqual(REASON_MAX);
    expect(long.endsWith('… [checklist: details_match]')).toBe(true);
  });

  it('needs a message for the business on rejection', () => {
    expect(rejectionProblem('  ')).toBe('required');
    expect(rejectionProblem('x'.repeat(501))).toBe('too_long');
    expect(rejectionProblem('Upload a readable licence')).toBeNull();
  });

  it('times a check from submission over 2 working days and lists oldest first', () => {
    // Wednesday 10:00 Tehran → Saturday 10:00 (Friday is not a working day).
    const t = verificationTimer({ created_at: '2026-11-04T06:30:00Z' }, 'Asia/Tehran');
    expect(new Date(t.due).toISOString()).toBe('2026-11-07T06:30:00.000Z');
    expect(oldestFirst([{ created_at: '2026-11-05' }, { created_at: '2026-11-03' }]).map((x) => x.created_at)).toEqual([
      '2026-11-03',
      '2026-11-05',
    ]);
  });
});
