import { describe, expect, it } from 'vitest';
import { autoCheck, dimensionAllowed, maskEmail } from './reviews.js';
import {
  badgeDecisions,
  confidenceLevel,
  freshness,
  isStale,
  providerTrustScore,
  reviewEvidenceWeight,
  reviewTrustWeight,
  weightedRating,
  type CountedReview,
} from './scoring.js';

const now = new Date('2026-10-13T00:00:00Z');
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
const review = (rating: number, o: Partial<CountedReview> = {}): CountedReview => ({
  rating,
  trustWeight: 1,
  date: daysAgo(10),
  serviceSystemNodeId: 'sys',
  communication: null,
  ...o,
});

describe('evidence and review weights (54 §1, §6)', () => {
  it('freshness steps and review trust weights', () => {
    expect(freshness(daysAgo(10), now)).toBe(1.5);
    expect(freshness(daysAgo(200), now)).toBe(1);
    expect(freshness(daysAgo(500), now)).toBe(0.5);
    expect(freshness(daysAgo(900), now)).toBe(0.1);
    expect(reviewTrustWeight('appointment_verified')).toBe(1);
    expect(reviewTrustWeight('approved_without_visit')).toBe(0.6);
    expect(reviewTrustWeight('pending_approval')).toBe(0);
    expect(reviewEvidenceWeight(5, 1)).toBe(8);
    expect(reviewEvidenceWeight(1, 0.6)).toBeCloseTo(-4.8);
    expect(reviewEvidenceWeight(3, 1)).toBe(0);
  });

  it('confidence levels need evidence, and verified_expert also jobs and a category rating', () => {
    expect(confidenceLevel(5, 0, null)).toBe('self_declared');
    expect(confidenceLevel(15, 1, null)).toBe('low_evidence');
    expect(confidenceLevel(45, 3, null)).toBe('moderate_evidence');
    expect(confidenceLevel(120, 8, 4.2)).toBe('strong_evidence');
    expect(confidenceLevel(250, 19, 4.9)).toBe('strong_evidence');
    expect(confidenceLevel(250, 20, 4.9)).toBe('verified_expert');
  });

  it('averages weight by trust weight and freshness', () => {
    expect(weightedRating([], now)).toBeNull();
    const avg = weightedRating([review(5), review(1, { trustWeight: 0.6, date: daysAgo(400) })], now)!;
    expect(avg).toBeCloseTo((5 * 1.5 + 1 * 0.6 * 0.5) / (1.5 + 0.3));
  });
});

describe('trust score and badges (54 §3, §4)', () => {
  const stats = {
    requests90: 10,
    respondedWithin24h90: 10,
    avgResponseMinutesAll: 30,
    confirmed90: 10,
    providerCancelledAfterConfirm90: 0,
    completed90: 10,
  };
  const integrity = {
    verified: true,
    businessIdentityVerified: true,
    profileCompleteness: 100,
    activeLocations: 1,
    verifiedLocations: 1,
    verifiedCertifications: 1,
  };

  it('scores 0–100 with penalties applied after the weighted score', () => {
    const good = providerTrustScore({ reviews: [review(5)], stats, integrity, countedEvidence: 50, unansweredNegative: 0 }, now);
    expect(good.score).toBeGreaterThan(95);
    const penalized = providerTrustScore(
      {
        reviews: [review(5)],
        stats: { ...stats, providerCancelledAfterConfirm90: 2 },
        integrity,
        countedEvidence: 50,
        unansweredNegative: 5,
      },
      now,
    );
    expect(penalized.penalties).toEqual({ unanswered_negative_reviews: -20, provider_cancellations: -10 });
    expect(penalized.score).toBeLessThan(good.score - 25);
    const empty = providerTrustScore(
      {
        reviews: [],
        stats: {
          requests90: 0,
          respondedWithin24h90: 0,
          avgResponseMinutesAll: null,
          confirmed90: 0,
          providerCancelledAfterConfirm90: 0,
          completed90: 0,
        },
        integrity: {
          ...integrity,
          verified: false,
          businessIdentityVerified: false,
          profileCompleteness: 0,
          verifiedLocations: 0,
          verifiedCertifications: 0,
        },
        countedEvidence: 0,
        unansweredNegative: 0,
      },
      now,
    );
    expect(empty.score).toBe(35);
  });

  it('awards rule badges with scopes and requires admin approval for verified_business', () => {
    const decisions = badgeDecisions(
      {
        verifiedTypes: ['business_identity', 'location'],
        capabilities: [
          { id: 'c1', brandNodeId: 'bmw', serviceSystemNodeId: 'brakes', level: 'strong_evidence' },
          { id: 'c2', brandNodeId: null, serviceSystemNodeId: 'ev', level: 'verified_expert' },
        ],
        reviews: Array.from({ length: 20 }, () => review(5, { communication: 5 })),
        stats: {
          requests90: 12,
          respondedWithin24h90: 12,
          responded30: 6,
          avgResponseMinutes30: 45,
          medianTurnaroundHours90: 30,
          turnaroundSamples90: 10,
          completed12m: 20,
          repeatCompleted12m: 6,
          fleetCompleted: 1,
        },
        evVerifiedCertification: true,
        evSystemNodeId: 'ev',
      },
      now,
    );
    const types = decisions.map((d) => d.badgeType).sort();
    expect(types).toEqual(
      [
        'verified_business',
        'make_specialist',
        'system_expert',
        'highly_rated',
        'fast_responder',
        'high_response_rate',
        'repeat_customer_favorite',
        'fast_appointment_turnaround',
        'excellent_communication',
        'ev_ready',
      ].sort(),
    );
    expect(decisions.find((d) => d.badgeType === 'verified_business')!.requiresAdminApproval).toBe(true);
    expect(decisions.find((d) => d.badgeType === 'make_specialist')!.scope).toEqual(['bmw', 'brakes']);
    // A Path 2 review counts as 0.6 of a review toward the 20-review threshold.
    const fewer = badgeDecisions(
      {
        verifiedTypes: [],
        capabilities: [],
        reviews: Array.from({ length: 20 }, (_, i) => review(5, { trustWeight: i < 5 ? 0.6 : 1 })),
        stats: {
          requests90: 0,
          respondedWithin24h90: 0,
          responded30: 0,
          avgResponseMinutes30: null,
          medianTurnaroundHours90: null,
          turnaroundSamples90: 0,
          completed12m: 0,
          repeatCompleted12m: 0,
          fleetCompleted: 0,
        },
        evVerifiedCertification: false,
        evSystemNodeId: null,
      },
      now,
    );
    expect(fewer.map((d) => d.badgeType)).not.toContain('highly_rated');
  });

  it('staleness: 12 months without a completed appointment or counted review, for profiles older than that', () => {
    expect(isStale({ profileCreatedAt: daysAgo(800), lastCompletedAt: daysAgo(400), lastCountedReviewAt: null }, now)).toBe(true);
    expect(isStale({ profileCreatedAt: daysAgo(800), lastCompletedAt: daysAgo(400), lastCountedReviewAt: daysAgo(30) }, now)).toBe(false);
    expect(isStale({ profileCreatedAt: daysAgo(100), lastCompletedAt: null, lastCountedReviewAt: null }, now)).toBe(false);
  });
});

describe('review rules', () => {
  it('holds text with links or contact data and never judges the rating', () => {
    expect(autoCheck('Great brake job, fair price and on time.').pass).toBe(true);
    expect(autoCheck('Call me on 0912 345 6789 for a cheaper deal').reason).toBe('phone');
    expect(autoCheck('see www.example.com').reason).toBe('link');
    expect(autoCheck('write to a@b.co please').reason).toBe('email');
    expect(autoCheck('شماره من ۰۹۱۲۳۴۵۶۷۸۹ است').reason).toBe('phone');
  });

  it('dimension sets per subject type and the masked contact', () => {
    expect(dimensionAllowed('provider', 'cleanliness')).toBe(true);
    expect(dimensionAllowed('vendor', 'cleanliness')).toBe(false);
    expect(dimensionAllowed('vendor', 'communication')).toBe(true);
    expect(maskEmail('alice@gmail.com')).toBe('a•••@g•••.com');
  });
});
