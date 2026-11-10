// AC7 unit tests of the review rules: the Path 2 stage (as the backend's queue filter), when Confirm is possible, the
// review a moderation case shows, the actions that apply to a review in its state, the move to Path 2, dispute
// outcomes and what each does, and "Unknown (<value>)" for values the console does not know.
import { describe, expect, it } from 'vitest';
import type { Review } from '@carpal/api-contracts';
import en from '@/lib/i18n/locales/en.json';
import type { MessageKey } from '@/lib/i18n/keys';
import {
  approvalStage,
  canMoveToApprovalPath,
  confirmBlock,
  disputeOutcomes,
  enumLabel,
  excerpt,
  outcomeEffect,
  reviewActions,
  reviewSnapshot,
  type ReviewSnapshot,
} from './review-logic';

const t = (key: MessageKey, vars?: Record<string, string | number>) => {
  const v = key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], { admin: en.admin });
  return typeof v === 'string' ? v.replace(/\{\{(\w+)\}\}/g, (_, n: string) => String(vars?.[n] ?? '')) : key;
};

const review = (o: Partial<Review>) => ({ review: { status: 'pending_approval', ...o } as Review });

describe('review rules (AC7)', () => {
  it('derives the Path 2 stage like the backend queue filter', () => {
    expect(approvalStage({ business_confirmation_status: 'pending', reviewer_decision: 'pending' })).toBe('awaiting_business');
    expect(approvalStage({ business_confirmation_status: 'confirmed', reviewer_decision: 'pending' })).toBe('awaiting_reviewer');
    expect(approvalStage({ business_confirmation_status: 'no_response', reviewer_decision: 'pending' })).toBe('awaiting_reviewer');
    expect(approvalStage({ business_confirmation_status: 'rejected', reviewer_decision: 'pending' })).toBe('awaiting_reviewer');
    expect(approvalStage({ business_confirmation_status: 'pending', reviewer_decision: 'evidence_requested' })).toBe('evidence_requested');
  });

  it('allows Confirm only after the business confirmed or let the deadline pass', () => {
    expect(confirmBlock(review({ business_confirmation_status: 'confirmed' }))).toBeNull();
    expect(confirmBlock(review({ business_confirmation_status: 'no_response' }))).toBeNull();
    expect(confirmBlock(review({ business_confirmation_status: 'pending' }))).toBe('business_pending');
    expect(confirmBlock(review({ business_confirmation_status: 'rejected' }))).toBe('business_rejected');
    expect(confirmBlock(review({ status: 'published', business_confirmation_status: 'confirmed' }))).toBe('not_pending');
  });

  it('shortens a review for the list, title first', () => {
    expect(excerpt({ title: 'Good  work', body: 'x' })).toBe('Good work');
    expect(excerpt({ body: 'a '.repeat(80) }, 20)).toHaveLength(20);
    expect(excerpt({ body: 'a '.repeat(80) }, 20).endsWith('…')).toBe(true);
  });

  it('reads the review snapshot of a case defensively', () => {
    expect(
      reviewSnapshot({
        type: 'review',
        id: 'r1',
        overall_rating: 2,
        body: 'Noise came back',
        status: 'published',
        confirmation_path: 'visit_based',
      }),
    ).toMatchObject({
      id: 'r1',
      rating: 2,
      body: 'Noise came back',
      status: 'published',
      path: 'visit_based',
    });
    expect(reviewSnapshot({ type: 'review', id: 'r1', available: false })).toBeNull();
    expect(reviewSnapshot({ type: 'post', id: 'p1' })).toBeNull();
    expect(reviewSnapshot(null)).toBeNull();
  });

  it('offers the actions that apply to the review in its state', () => {
    const snap = (o: Partial<ReviewSnapshot>): ReviewSnapshot => ({
      id: 'r',
      subjectOrganizationId: null,
      rating: 3,
      title: null,
      body: 'b',
      status: 'published',
      path: 'visit_based',
      verifiedStatus: 'appointment_verified',
      createdAt: null,
      ...o,
    });
    expect(reviewActions(snap({}))).toEqual(['remove', 'warn_user']);
    expect(reviewActions(snap({ status: 'pending_moderation' }))).toEqual(['approve', 'remove', 'warn_user']);
    expect(reviewActions(snap({ status: 'removed' }))).toEqual(['restore', 'warn_user']);
    expect(reviewActions(snap({ status: 'pending_moderation', path: 'approval_based' }))).toEqual(['remove', 'warn_user']);
    expect(canMoveToApprovalPath(snap({}))).toBe(true);
    expect(canMoveToApprovalPath(snap({ status: 'pending_moderation' }))).toBe(true);
    expect(canMoveToApprovalPath(snap({ status: 'removed' }))).toBe(false);
    expect(canMoveToApprovalPath(snap({ path: 'approval_based', status: 'pending_approval' }))).toBe(false);
    expect(canMoveToApprovalPath(null)).toBe(false);
  });

  it('lets staff mediate, uphold or reject an open dispute, and nothing once decided', () => {
    expect(disputeOutcomes({ status: 'open' })).toEqual(['in_mediation', 'resolved_upheld', 'resolved_rejected']);
    expect(disputeOutcomes({ status: 'in_mediation' })).toEqual(['resolved_upheld', 'resolved_rejected']);
    expect(disputeOutcomes({ status: 'resolved_upheld' })).toEqual([]);
    expect(disputeOutcomes({ status: 'withdrawn' })).toEqual([]);
  });

  it('says what an outcome does: an upheld objection keeps the review, published as disputed', () => {
    expect(t(outcomeEffect('review_approval_objection', 'resolved_upheld'))).toContain('Disputed by the business');
    expect(t(outcomeEffect('review_approval_objection', 'resolved_rejected'))).toContain('rejected and not published');
    expect(t(outcomeEffect('fake_review', 'resolved_upheld'))).toContain('removed as a confirmed fake');
    expect(t(outcomeEffect('badge_challenge', 'resolved_upheld'))).toBe('The badge is revoked.');
    expect(t(outcomeEffect('moderation_appeal', 'resolved_upheld'))).toContain('restored');
    expect(t(outcomeEffect('service_record_dispute', 'resolved_upheld'))).toContain('correct the record itself');
    expect(t(outcomeEffect('fake_review', 'resolved_rejected'))).toContain('Nothing changes');
    expect(t(outcomeEffect('fake_review', 'in_mediation'))).toContain('Both sides');
  });

  it('names unknown values instead of failing', () => {
    expect(enumLabel(['a'], 'admin.trust.business', 'future_value', t)).toBe('Unknown (future_value)');
    expect(enumLabel(['pending'], 'admin.trust.business', 'pending', t)).toBe('Waiting for the business');
    expect(enumLabel(['pending'], 'admin.trust.business', null, t)).toBe('—');
  });
});
