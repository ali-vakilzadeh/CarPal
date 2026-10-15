// Trust scoring protocol (54) as pure functions: evidence weights and
// freshness (§1, §6), review trust weight (§1.2), capability confidence
// (§2.1), organization trust score with penalties (§3) and badge rules (§4).
// Every value is a launch default (54 "Calibration"); a change gets a new
// RULE_VERSION. Inputs come from the trust scorer (W3), never from AI (§9).

/** 54 §9.5: written to TrustSignal.rule_version and ProviderBadge.rule_version. */
export const RULE_VERSION = '54-2026-10';

const DAY = 86_400_000;

/** 54 §6 freshness multiplier by age. */
export function freshness(date: Date | string, now: Date): number {
  const age = (now.getTime() - new Date(date).getTime()) / DAY;
  if (age <= 90) return 1.5;
  if (age <= 365) return 1.0;
  if (age <= 730) return 0.5;
  return 0.1;
}

export const PATH1_STATUSES = [
  'appointment_verified',
  'inquiry_verified',
  'service_record_verified',
  'invoice_verified',
  'fleet_confirmed',
  'admin_verified',
] as const;

/** 54 §1.2 Review.trust_weight by verified_status (Path 2 approved_without_visit: 0.6, launch default). */
export function reviewTrustWeight(verifiedStatus: string): number {
  if ((PATH1_STATUSES as readonly string[]).includes(verifiedStatus)) return 1;
  if (verifiedStatus === 'approved_without_visit') return 0.6;
  return 0;
}

/** 54 §1.1 verified_review base weight: 8 / 4 / 0 / −4 / −8 × trust weight. */
export function reviewEvidenceWeight(rating: number, trustWeight: number): number {
  const base: Record<number, number> = { 5: 8, 4: 4, 3: 0, 2: -4, 1: -8 };
  return (base[rating] ?? 0) * trustWeight;
}

export const EVIDENCE_WEIGHTS = { completed_appointment: 10, service_record: 3, job_log: 3, portfolio_item: 5, certification: 15 } as const;
/** Evidence types that are one real-world job each (54 §1.1 no double counting; §2.1 "counted jobs"). */
export const JOB_TYPES = ['completed_appointment', 'service_record', 'job_log'] as const;

export type ConfidenceLevel = 'self_declared' | 'low_evidence' | 'moderate_evidence' | 'strong_evidence' | 'verified_expert';
export const LEVEL_RANK: Record<ConfidenceLevel, number> = {
  self_declared: 0,
  low_evidence: 1,
  moderate_evidence: 2,
  strong_evidence: 3,
  verified_expert: 4,
};

/** 54 §2.1. */
export function confidenceLevel(score: number, countedJobs: number, categoryRating: number | null): ConfidenceLevel {
  if (score >= 200 && countedJobs >= 20 && categoryRating !== null && categoryRating >= 4.8) return 'verified_expert';
  if (score >= 80) return 'strong_evidence';
  if (score >= 30) return 'moderate_evidence';
  if (score >= 10) return 'low_evidence';
  return 'self_declared';
}

export interface CountedReview {
  rating: number;
  trustWeight: number;
  /** published_at (freshness). */
  date: Date;
  serviceSystemNodeId: string | null;
  communication: number | null;
}

/** Average weighted by trust weight and freshness (54 §1.2 "averages are always weighted"); null without reviews. */
export function weightedRating(reviews: readonly CountedReview[], now: Date): number | null {
  let num = 0;
  let den = 0;
  for (const r of reviews) {
    const w = r.trustWeight * freshness(r.date, now);
    num += r.rating * w;
    den += w;
  }
  return den > 0 ? num / den : null;
}

/** Counted reviews: each counts by its trust weight (54 §1.2 count thresholds). */
export const countedReviews = (reviews: readonly CountedReview[]): number => reviews.reduce((s, r) => s + r.trustWeight, 0);

// ------------------------------------------------------------ trust score (§3)

export interface ProviderScoreInputs {
  reviews: readonly CountedReview[];
  stats: {
    requests90: number;
    respondedWithin24h90: number;
    avgResponseMinutesAll: number | null;
    confirmed90: number;
    providerCancelledAfterConfirm90: number;
    completed90: number;
  };
  integrity: IntegrityInputs;
  /** Active evidence rows with a positive weight. */
  countedEvidence: number;
  /** Published 1–2 star reviews older than 7 days without a published response. */
  unansweredNegative: number;
  /** §3.3 moderation penalties (moderationPenalties()), negative points by key. */
  moderation?: Record<string, number>;
}

export interface IntegrityInputs {
  verified: boolean;
  businessIdentityVerified: boolean;
  profileCompleteness: number;
  activeLocations: number;
  verifiedLocations: number;
  verifiedCertifications: number;
}

export interface ScoreBreakdown {
  score: number;
  components: Record<string, number>;
  penalties: Record<string, number>;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
/** Without data a component is neutral (OQ-14: 0.5). */
const NEUTRAL = 0.5;
const ratingScore = (avg: number | null) => (avg === null ? NEUTRAL : clamp01((avg - 1) / 4));
const responseTimeScore = (minutes: number | null) => (minutes === null ? NEUTRAL : clamp01(1 - minutes / (48 * 60)));

function integrity(i: IntegrityInputs): number {
  const verification = i.verified ? 1 : i.businessIdentityVerified ? 0.5 : 0;
  const locations = i.activeLocations ? i.verifiedLocations / i.activeLocations : 0;
  return (verification + clamp01(i.profileCompleteness / 100) + locations + (i.verifiedCertifications > 0 ? 1 : 0)) / 4;
}

/** 54 §3.1 provider trust score (0–100) with §3.3 penalties (floor 0). */
export function providerTrustScore(x: ProviderScoreInputs, now: Date): ScoreBreakdown {
  const s = x.stats;
  const review = ratingScore(weightedRating(x.reviews, now));
  const parts: number[] = [
    s.requests90 > 0 ? s.respondedWithin24h90 / s.requests90 : NEUTRAL,
    responseTimeScore(s.avgResponseMinutesAll),
    s.completed90 + s.providerCancelledAfterConfirm90 > 0 ? s.completed90 / (s.completed90 + s.providerCancelledAfterConfirm90) : NEUTRAL,
    s.confirmed90 > 0 ? 1 - s.providerCancelledAfterConfirm90 / s.confirmed90 : NEUTRAL,
  ];
  const operational = parts.reduce((a, b) => a + b, 0) / parts.length;
  const profile = integrity(x.integrity);
  const evidence = clamp01(x.countedEvidence / 50);
  const raw = 100 * (0.4 * review + 0.3 * operational + 0.15 * profile + 0.15 * evidence);
  const penalties: Record<string, number> = {};
  if (x.unansweredNegative > 0) penalties.unanswered_negative_reviews = -Math.min(20, 5 * x.unansweredNegative);
  if (s.confirmed90 > 0 && s.providerCancelledAfterConfirm90 / s.confirmed90 > 0.1) penalties.provider_cancellations = -10;
  Object.assign(penalties, x.moderation ?? {});
  const total = Object.values(penalties).reduce((a, b) => a + b, 0);
  return {
    score: Math.max(0, Math.round(raw + total)),
    components: { review_quality: review, operational_reliability: operational, profile_integrity: profile, evidence_volume: evidence },
    penalties,
  };
}

export interface VendorScoreInputs {
  reviews: readonly CountedReview[];
  measuredResponseTimeMinutes: number | null;
  catalogQualityScore: number;
  integrity: IntegrityInputs;
  unansweredNegative: number;
  moderation?: Record<string, number>;
}

/** 54 §3.2 vendor trust score; inquiry responsiveness from the measured response time (inquiry_fulfillment_rate: DI-40). */
export function vendorTrustScore(x: VendorScoreInputs, now: Date): ScoreBreakdown {
  const review = ratingScore(weightedRating(x.reviews, now));
  const inquiry = responseTimeScore(x.measuredResponseTimeMinutes);
  const catalog = clamp01(x.catalogQualityScore / 100);
  const profile = integrity(x.integrity);
  const raw = 100 * (0.4 * review + 0.25 * inquiry + 0.2 * catalog + 0.15 * profile);
  const penalties: Record<string, number> = {};
  if (x.unansweredNegative > 0) penalties.unanswered_negative_reviews = -Math.min(20, 5 * x.unansweredNegative);
  Object.assign(penalties, x.moderation ?? {});
  const total = Object.values(penalties).reduce((a, b) => a + b, 0);
  return {
    score: Math.max(0, Math.round(raw + total)),
    components: { review_quality: review, inquiry_responsiveness: inquiry, catalog_quality: catalog, profile_integrity: profile },
    penalties,
  };
}

/** A §3.3 penalty input from moderation (admin points, confirmed violations, confirmed fake reviews). */
export interface ModerationPenaltyInput {
  kind: 'admin_trust_penalty' | 'content_violation' | 'fake_review';
  points: number;
}

/**
 * 54 §3.3 from moderation within the last 12 months: manual admin penalties
 * add up (capped at 100), a confirmed content or policy violation is −20, a
 * confirmed fake or self-review is −50 and revokes every badge.
 */
export function moderationPenalties(inputs: readonly ModerationPenaltyInput[]): {
  penalties: Record<string, number>;
  revokeAllBadges: boolean;
} {
  const penalties: Record<string, number> = {};
  const admin = inputs.filter((i) => i.kind === 'admin_trust_penalty').reduce((a, i) => a + Math.max(0, i.points), 0);
  if (admin > 0) penalties.admin_trust_penalty = -Math.min(100, admin);
  if (inputs.some((i) => i.kind === 'content_violation')) penalties.policy_violation = -20;
  const fake = inputs.some((i) => i.kind === 'fake_review');
  if (fake) penalties.fake_review = -50;
  return { penalties, revokeAllBadges: fake };
}

/** 54 §3.2 hybrid: both scores weighted by each side's counted review volume (equal without reviews). */
export function hybridScore(provider: number, providerReviews: number, vendor: number, vendorReviews: number): number {
  const total = providerReviews + vendorReviews;
  return Math.round(total > 0 ? (provider * providerReviews + vendor * vendorReviews) / total : (provider + vendor) / 2);
}

// ------------------------------------------------------------------ badges (§4)

export interface BadgeCapability {
  id: string;
  brandNodeId: string | null;
  serviceSystemNodeId: string;
  level: ConfidenceLevel;
}

export interface BadgeInputs {
  verifiedTypes: string[];
  capabilities: readonly BadgeCapability[];
  reviews: readonly CountedReview[];
  stats: {
    requests90: number;
    respondedWithin24h90: number;
    responded30: number;
    avgResponseMinutes30: number | null;
    medianTurnaroundHours90: number | null;
    turnaroundSamples90: number;
    completed12m: number;
    repeatCompleted12m: number;
    fleetCompleted: number;
  };
  evVerifiedCertification: boolean;
  evSystemNodeId: string | null;
}

export interface BadgeDecision {
  badgeType: string;
  scope: string[];
  ruleKey: string;
  requiresAdminApproval: boolean;
  snapshot: Record<string, unknown>;
}

const round2 = (x: number | null) => (x === null ? null : Math.round(x * 100) / 100);

/** The badges a provider qualifies for now (54 §4); anything not listed is revoked by the caller. */
export function badgeDecisions(x: BadgeInputs, now: Date): BadgeDecision[] {
  const out: BadgeDecision[] = [];
  const add = (badgeType: string, scope: string[], snapshot: Record<string, unknown>, requiresAdminApproval = false) =>
    out.push({ badgeType, scope, ruleKey: `${badgeType}.v1`, requiresAdminApproval, snapshot });
  if (x.verifiedTypes.includes('business_identity') && x.verifiedTypes.includes('location'))
    add('verified_business', [], { verified: ['business_identity', 'location'] }, true);
  const strong = x.capabilities.filter((c) => LEVEL_RANK[c.level] >= 3);
  const brandSystem = new Map<string, BadgeCapability[]>();
  for (const c of strong) {
    if (!c.brandNodeId) continue;
    brandSystem.set(`${c.brandNodeId}|${c.serviceSystemNodeId}`, [
      ...(brandSystem.get(`${c.brandNodeId}|${c.serviceSystemNodeId}`) ?? []),
      c,
    ]);
  }
  for (const [k, caps] of brandSystem) {
    const [brand, system] = k.split('|') as [string, string];
    add('make_specialist', [brand, system], { capability_ids: caps.map((c) => c.id), threshold_level: 'strong_evidence' });
  }
  const byBrand = new Map<string, Set<string>>();
  for (const c of strong)
    if (c.brandNodeId) byBrand.set(c.brandNodeId, (byBrand.get(c.brandNodeId) ?? new Set()).add(c.serviceSystemNodeId));
  for (const [brand, systems] of byBrand)
    if (systems.size >= 3) add('make_specialist', [brand], { systems: [...systems], threshold_systems: 3 });
  const experts = new Set(x.capabilities.filter((c) => c.level === 'verified_expert').map((c) => c.serviceSystemNodeId));
  for (const system of experts) add('system_expert', [system], { threshold_level: 'verified_expert' });
  const avg = weightedRating(x.reviews, now);
  const counted = countedReviews(x.reviews);
  if (avg !== null && avg >= 4.8 && counted >= 20) add('highly_rated', [], { average: round2(avg), counted: round2(counted) });
  const s = x.stats;
  if (s.responded30 >= 5 && s.avgResponseMinutes30 !== null && s.avgResponseMinutes30 < 120)
    add('fast_responder', [], { average_minutes: round2(s.avgResponseMinutes30), requests: s.responded30 });
  if (s.requests90 >= 10 && s.respondedWithin24h90 / s.requests90 >= 0.9)
    add('high_response_rate', [], { rate: round2(s.respondedWithin24h90 / s.requests90), requests: s.requests90 });
  if (s.completed12m >= 20 && s.repeatCompleted12m / s.completed12m >= 0.25 && avg !== null && avg >= 4.5)
    add('repeat_customer_favorite', [], { repeat_share: round2(s.repeatCompleted12m / s.completed12m), completed: s.completed12m });
  if (s.turnaroundSamples90 >= 10 && s.medianTurnaroundHours90 !== null && s.medianTurnaroundHours90 <= 48)
    add('fast_appointment_turnaround', [], { median_hours: round2(s.medianTurnaroundHours90), samples: s.turnaroundSamples90 });
  const yearAgo = now.getTime() - 365 * DAY;
  const comm = x.reviews.filter((r) => r.communication !== null && r.date.getTime() >= yearAgo);
  const commCount = countedReviews(comm);
  if (commCount >= 15) {
    const commAvg = weightedRating(
      comm.map((r) => ({ ...r, rating: r.communication! })),
      now,
    );
    if (commAvg !== null && commAvg >= 4.8) add('excellent_communication', [], { average: round2(commAvg), counted: round2(commCount) });
  }
  if (s.fleetCompleted >= 5) add('fleet_friendly', [], { fleet_completed: s.fleetCompleted });
  if (x.evVerifiedCertification && x.evSystemNodeId) {
    const ev = x.capabilities.find((c) => c.serviceSystemNodeId === x.evSystemNodeId && LEVEL_RANK[c.level] >= 2);
    if (ev) add('ev_ready', [x.evSystemNodeId], { capability_id: ev.id, certification: 'ev_high_voltage' });
  }
  return out;
}

/** 54 §6 staleness: no completed appointment and no new counted review in 12 months (for profiles older than that). */
export function isStale(o: { profileCreatedAt: Date; lastCompletedAt: Date | null; lastCountedReviewAt: Date | null }, now: Date): boolean {
  const yearAgo = now.getTime() - 365 * DAY;
  if (o.profileCreatedAt.getTime() > yearAgo) return false;
  return (o.lastCompletedAt?.getTime() ?? 0) < yearAgo && (o.lastCountedReviewAt?.getTime() ?? 0) < yearAgo;
}
