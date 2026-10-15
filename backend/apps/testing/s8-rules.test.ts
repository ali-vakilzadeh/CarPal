// Pure S8 rules across the admin plane: the four-eyes flag rule (40
// admin.flag_update), moderation penalties (54 §3.3), dispute outcomes,
// Path 2 stages and fleet report ranges.
import { describe, expect, it } from 'vitest';
import { GROUPINGS, reportRange } from '#modules/fleet/application/reports.js';
import { approvalStage, outcomeAction } from '#modules/trust/application/admin-ops.js';
import { moderationPenalties } from '#modules/trust/domain/scoring.js';
import { flagNeedsSecondApprover } from '#modules/admin/application/platform-ops.js';

describe('flag four-eyes rule (40 admin.flag_update)', () => {
  it('kill switch on is immediate, off needs a second admin; featured.enabled on needs a second admin', () => {
    expect(flagNeedsSecondApprover('ai.automation.kill_switch', false, true)).toBe(false);
    expect(flagNeedsSecondApprover('ai.automation.kill_switch', true, false)).toBe(true);
    expect(flagNeedsSecondApprover('featured.enabled', false, true)).toBe(true);
    expect(flagNeedsSecondApprover('featured.enabled', true, false)).toBe(false);
    expect(flagNeedsSecondApprover('map.enabled', true, false)).toBe(false);
    expect(flagNeedsSecondApprover('ai.automation.kill_switch', true, undefined)).toBe(false);
  });
});

describe('moderation penalties (54 §3.3)', () => {
  it('adds admin points (≤ 100), −20 once for violations, −50 and all badges for a fake review', () => {
    expect(moderationPenalties([])).toEqual({ penalties: {}, revokeAllBadges: false });
    expect(
      moderationPenalties([
        { kind: 'admin_trust_penalty', points: 70 },
        { kind: 'admin_trust_penalty', points: 50 },
        { kind: 'content_violation', points: 20 },
        { kind: 'content_violation', points: 20 },
      ]),
    ).toEqual({ penalties: { admin_trust_penalty: -100, policy_violation: -20 }, revokeAllBadges: false });
    expect(moderationPenalties([{ kind: 'fake_review', points: 50 }])).toEqual({ penalties: { fake_review: -50 }, revokeAllBadges: true });
  });
});

describe('disputes and Path 2 stages', () => {
  it('records an action only when an outcome changes the target', () => {
    expect(outcomeAction('review_approval_objection', true)).toBe('confirm_review_approval');
    expect(outcomeAction('review_approval_objection', false)).toBe('reject_review_approval');
    expect(outcomeAction('fake_review', true)).toBe('remove');
    expect(outcomeAction('fake_review', false)).toBeNull();
    expect(outcomeAction('badge_challenge', true)).toBe('revoke_badge');
    expect(outcomeAction('moderation_appeal', true)).toBe('restore');
    expect(outcomeAction('mediation_request', true)).toBeNull();
  });

  it('derives the reviewer queue stage', () => {
    expect(approvalStage({ business_confirmation_status: 'pending', reviewer_decision: 'pending' })).toBe('awaiting_business');
    expect(approvalStage({ business_confirmation_status: 'no_response', reviewer_decision: 'pending' })).toBe('awaiting_reviewer');
    expect(approvalStage({ business_confirmation_status: 'pending', reviewer_decision: 'evidence_requested' })).toBe('evidence_requested');
  });
});

describe('fleet report ranges (40 fleet.report)', () => {
  it('accepts up to 366 days in order', () => {
    expect(reportRange('2026-01-01', '2026-12-31').to.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(() => reportRange('2026-02-01', '2026-01-01')).toThrow();
    expect(() => reportRange('2025-01-01', '2026-06-01')).toThrow();
    for (const groupings of Object.values(GROUPINGS)) expect(groupings.length).toBeGreaterThan(0);
  });
});
