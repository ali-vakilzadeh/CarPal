// W3 trust scoring (41 §2.4; 54): recomputes one organization from its
// evidence in the worker's system context — capability evidence (54 §1, no
// double counting), capability confidence (§2.1), the provider / vendor /
// hybrid trust score with penalties (§3), trust signals, badges (§4) and the
// staleness rule (§6). Idempotent: every run derives everything from the
// current records, so events, the nightly sweep and redeliveries all converge.
// A score change of more than 5 points and every badge award or revocation
// are audited (54 §9.4) and published (trust.score.changed, badge.awarded,
// badge.revoked: the W2 indexer rebuilds the organization).
import { Injectable, Optional } from '@nestjs/common';
import { sql } from 'kysely';
import { writeAudit } from '#libs/audit/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import { TxRunner, type TxScope } from '#libs/tenancy/index.js';
import { ModerationLog } from '#modules/admin/interface/admin.js';
import { AppointmentFacts, type ProviderAppointmentStats } from '#modules/appointment/interface/appointments.js';
import { ProviderCapabilities } from '#modules/organization/interface/provider-capabilities.js';
import { TrustFigures, type EvidenceItem, type OrgTrustFacts } from '#modules/organization/interface/trust-figures.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { VehicleCards } from '#modules/vehicle/interface/vehicles.js';
import { arr } from '../api/projections.js';
import {
  badgeDecisions,
  confidenceLevel,
  countedReviews,
  EVIDENCE_WEIGHTS,
  freshness,
  hybridScore,
  isStale,
  JOB_TYPES,
  LEVEL_RANK,
  moderationPenalties,
  providerTrustScore,
  reviewEvidenceWeight,
  RULE_VERSION,
  vendorTrustScore,
  weightedRating,
  type BadgeDecision,
  type ConfidenceLevel,
  type CountedReview,
  type IntegrityInputs,
  type ModerationPenaltyInput,
  type ScoreBreakdown,
} from '../domain/scoring.js';

type ReviewFact = CountedReview & {
  id: string;
  subjectType: string;
  contextAppointmentId: string | null;
  contextServiceRecordId: string | null;
  contextVehicleId: string | null;
  serviceTaskNodeId: string | null;
};

const day = (d: Date) => d.toISOString().slice(0, 10);

@Injectable()
export class TrustScorer {
  #evSystem: string | null | undefined;

  constructor(
    private readonly tx: TxRunner,
    private readonly figures: TrustFigures,
    private readonly capabilities: ProviderCapabilities,
    private readonly appointments: AppointmentFacts,
    private readonly vehicles: VehicleCards,
    private readonly taxonomy: TaxonomyResolver,
    @Optional() private readonly moderation?: ModerationLog,
  ) {}

  /** Recomputes an organization in its own system transaction; returns the new trust score (null when not scored). */
  async recompute(orgId: string, now = new Date(), requestId?: string): Promise<number | null> {
    return this.tx.run({ actorType: 'system', ...(requestId ? { requestId } : {}) }, (scope) => this.recomputeIn(scope, orgId, now));
  }

  async recomputeIn(scope: TxScope, orgId: string, now: Date): Promise<number | null> {
    const facts = await this.figures.facts(scope, orgId);
    // 54 §3: fleet organizations have no trust score.
    if (!facts || facts.organizationType === 'fleet' || (!facts.provider && !facts.vendor)) return null;
    const reviews = await this.reviews(scope, orgId);
    const providerReviews = reviews.filter((r) => r.subjectType === 'provider');
    const vendorReviews = reviews.filter((r) => r.subjectType === 'vendor');
    const unanswered = await this.unansweredNegative(scope, orgId, now);
    const mod = moderationPenalties(await this.penaltyInputs(scope, orgId, now));
    // 54 §4: every badge goes when a fake review is confirmed or the organization is suspended.
    const revokeAllBadges = mod.revokeAllBadges || facts.status === 'suspended';
    const integrity: IntegrityInputs = {
      verified: facts.verificationStatus === 'verified',
      businessIdentityVerified: facts.verifiedTypes.includes('business_identity'),
      profileCompleteness: facts.provider?.profileCompleteness ?? facts.vendor?.profileCompleteness ?? 0,
      activeLocations: facts.activeLocations,
      verifiedLocations: facts.verifiedLocations,
      verifiedCertifications: facts.certifications.filter((c) => c.verified).length,
    };
    let provider: ScoreBreakdown | null = null;
    let stats: ProviderAppointmentStats | null = null;
    if (facts.provider) {
      stats = await this.appointments.stats(scope, orgId, now);
      const counted = await this.provider(scope, facts, providerReviews, stats, now, revokeAllBadges);
      provider = providerTrustScore(
        {
          reviews: providerReviews,
          stats,
          integrity,
          countedEvidence: counted,
          unansweredNegative: unanswered.provider,
          moderation: mod.penalties,
        },
        now,
      );
    }
    let vendor: ScoreBreakdown | null = null;
    if (facts.vendor)
      vendor = vendorTrustScore(
        {
          reviews: vendorReviews,
          measuredResponseTimeMinutes: facts.vendor.measuredResponseTimeMinutes,
          catalogQualityScore: facts.vendor.catalogQualityScore,
          integrity: { ...integrity, profileCompleteness: facts.vendor.profileCompleteness },
          unansweredNegative: unanswered.vendor,
          moderation: mod.penalties,
        },
        now,
      );
    const score =
      provider && vendor
        ? hybridScore(provider.score, countedReviews(providerReviews), vendor.score, countedReviews(vendorReviews))
        : (provider ?? vendor)!.score;
    await this.signals(
      scope,
      orgId,
      { reviews, stats, facts, provider, vendor, score, unanswered: unanswered.provider + unanswered.vendor },
      now,
    );
    const r = await this.figures.recordTrustScore(scope, orgId, score);
    if (r.changed) {
      if (r.previous === null || Math.abs(score - r.previous) > 5)
        await writeAudit(scope, {
          action: 'trust.score_changed',
          entityType: 'organization',
          entityId: orgId,
          previous: r.previous === null ? null : String(r.previous),
          next: `${score} (${RULE_VERSION})`,
        });
      await publishEvent(scope, {
        type: 'trust.score.changed',
        aggregateType: 'organization',
        aggregateId: orgId,
        payload: { organization_id: orgId, previous: r.previous, score, rule_version: RULE_VERSION },
      });
    }
    return score;
  }

  /** Published reviews of the organization that count (both paths, at their trust weight), with the communication sub-rating. */
  private async reviews(scope: TxScope, orgId: string): Promise<ReviewFact[]> {
    const rows = await scope.db
      .selectFrom('trust.reviews as r')
      .leftJoin('trust.review_sub_ratings as s', (j) =>
        j.onRef('s.review_id', '=', 'r.id').on('s.dimension', '=', 'communication').on('s.deleted_at', 'is', null),
      )
      .select([
        'r.id',
        'r.subject_type',
        'r.overall_rating',
        'r.trust_weight',
        'r.published_at',
        'r.service_system_node_id',
        'r.service_task_node_id',
        'r.context_appointment_id',
        'r.context_service_record_id',
        'r.context_vehicle_id',
        's.rating as communication',
      ])
      .where('r.subject_organization_id', '=', orgId)
      .where('r.status', '=', 'published')
      .where('r.counts_toward_core_score', '=', true)
      .where('r.deleted_at', 'is', null)
      .execute();
    return rows.map((r) => ({
      id: r.id,
      subjectType: r.subject_type,
      rating: Number(r.overall_rating),
      trustWeight: Number(r.trust_weight ?? 0),
      date: new Date(r.published_at!),
      serviceSystemNodeId: r.service_system_node_id,
      serviceTaskNodeId: r.service_task_node_id,
      communication: r.communication === null ? null : Number(r.communication),
      contextAppointmentId: r.context_appointment_id,
      contextServiceRecordId: r.context_service_record_id,
      contextVehicleId: r.context_vehicle_id,
    }));
  }

  /** 54 §3.3: published 1–2 star reviews unanswered for more than 7 days, per subject type. */
  private async unansweredNegative(scope: TxScope, orgId: string, now: Date): Promise<{ provider: number; vendor: number }> {
    const rows = await scope.db
      .selectFrom('trust.reviews as r')
      .select(['r.subject_type', sql<string>`count(*)`.as('n')])
      .where('r.subject_organization_id', '=', orgId)
      .where('r.status', '=', 'published')
      .where('r.overall_rating', '<=', 2)
      .where('r.published_at', '<', new Date(now.getTime() - 7 * 86_400_000))
      .where('r.deleted_at', 'is', null)
      .where(
        sql<boolean>`NOT EXISTS (SELECT 1 FROM trust.review_responses x WHERE x.review_id = r.id AND x.status = 'published' AND x.deleted_at IS NULL)`,
      )
      .groupBy('r.subject_type')
      .execute();
    const n = (t: string) => Number(rows.find((r) => r.subject_type === t)?.n ?? 0);
    return { provider: n('provider'), vendor: n('vendor') };
  }

  /**
   * 54 §3.3 penalty inputs of the last 12 months: moderation actions on the
   * organization or its content (admin module), and upheld fake-review
   * disputes about its reviews.
   */
  private async penaltyInputs(scope: TxScope, orgId: string, now: Date): Promise<ModerationPenaltyInput[]> {
    const since = new Date(now.getTime() - 365 * 86_400_000);
    const out: ModerationPenaltyInput[] = (await this.moderation?.penalties(scope, orgId, since)) ?? [];
    const { rows } = await sql<{ n: string }>`
      SELECT count(*) AS n FROM trust.disputes d JOIN trust.reviews r ON r.id = d.target_entity_id
       WHERE d.target_entity_type = 'review' AND d.dispute_type = 'fake_review' AND d.status = 'resolved_upheld'
         AND d.resolved_at >= ${since} AND r.subject_organization_id = ${orgId}::uuid AND d.deleted_at IS NULL`.execute(scope.db);
    if (Number(rows[0]!.n) > 0) out.push({ kind: 'fake_review', points: 50 });
    return out;
  }

  /** Provider side: evidence sync, capability confidence, badges, response time and staleness. Returns the counted evidence. */
  private async provider(
    scope: TxScope,
    facts: OrgTrustFacts,
    reviews: ReviewFact[],
    stats: ProviderAppointmentStats,
    now: Date,
    revokeAllBadges = false,
  ): Promise<number> {
    const orgId = facts.orgId;
    const completed = await this.appointments.completed(scope, orgId);
    const vehicleIds = [...completed.map((a) => a.vehicleId), ...reviews.map((r) => r.contextVehicleId).filter((x): x is string => !!x)];
    const vehicles = await this.vehicles.cards(scope, vehicleIds);
    const items: EvidenceItem[] = [];
    const appointmentIds = new Set<string>();
    for (const a of completed) {
      // 54 §1.1: vehicle + service system (task if known).
      if (!a.serviceSystemNodeId || !a.completedAt) continue;
      const v = vehicles.get(a.vehicleId);
      appointmentIds.add(a.id);
      items.push({
        evidenceType: 'completed_appointment',
        referenceType: 'appointment',
        referenceId: a.id,
        baseWeight: EVIDENCE_WEIGHTS.completed_appointment,
        evidenceDate: day(a.completedAt),
        brandNodeId: v?.brandNodeId ?? null,
        modelNodeId: v?.modelNodeId ?? null,
        seriesNodeId: v?.seriesNodeId ?? null,
        serviceSystemNodeId: a.serviceSystemNodeId,
        serviceTaskNodeId: a.serviceTaskNodeId,
      });
    }
    // Reviews count once per job (54 §1.1): the newest review of an appointment or service record.
    const reviewByJob = new Map<string, ReviewFact>();
    for (const r of reviews) {
      if (!r.serviceSystemNodeId || r.trustWeight <= 0) continue;
      const job = r.contextAppointmentId ?? r.contextServiceRecordId ?? r.id;
      const prev = reviewByJob.get(job);
      if (!prev || prev.date < r.date) reviewByJob.set(job, r);
    }
    for (const r of reviewByJob.values()) {
      const v = r.contextVehicleId ? vehicles.get(r.contextVehicleId) : undefined;
      items.push({
        evidenceType: 'verified_review',
        referenceType: 'review',
        referenceId: r.id,
        baseWeight: Math.round(reviewEvidenceWeight(r.rating, r.trustWeight)),
        evidenceDate: day(r.date),
        brandNodeId: v?.brandNodeId ?? null,
        modelNodeId: v?.modelNodeId ?? null,
        seriesNodeId: v?.seriesNodeId ?? null,
        serviceSystemNodeId: r.serviceSystemNodeId,
        serviceTaskNodeId: r.serviceTaskNodeId,
      });
    }
    // Job logs describing a counted appointment are the same job: only the appointment (weight 10) counts.
    for (const e of await this.figures.ownEvidence(scope, orgId))
      if (!(e.evidenceType === 'job_log' && (e.sameJobAs ?? []).some((id) => appointmentIds.has(id)))) items.push(e);

    const linked = await this.figures.syncEvidence(scope, orgId, items);
    const caps = await this.capabilities.forProviders(scope, [orgId]);
    const levels = new Map<string, ConfidenceLevel>();
    const scores = caps.map((c) => {
      const ev = linked.filter((e) => e.capabilityId === c.id);
      const score = ev.reduce((s, e) => s + Math.max(-100, Math.min(100, Math.round(e.baseWeight))) * freshness(e.evidenceDate, now), 0);
      const jobs = ev.filter((e) => (JOB_TYPES as readonly string[]).includes(e.evidenceType)).length;
      const categoryRating = weightedRating(
        reviews.filter((r) => r.serviceSystemNodeId === c.serviceSystemNodeId),
        now,
      );
      const level = confidenceLevel(Math.max(0, score), jobs, categoryRating);
      levels.set(c.id, level);
      return {
        capabilityId: c.id,
        confidenceLevel: level,
        confidenceScore: Math.max(0, Math.min(999_999, score)),
        evidenceCount: ev.length,
        badgeEligible: LEVEL_RANK[level] >= 3,
      };
    });
    await this.figures.recordCapabilityScores(scope, orgId, scores);
    const lastReview = reviews.reduce<Date | null>((m, r) => (!m || r.date > m ? r.date : m), null);
    await this.figures.recordProviderFigures(scope, orgId, {
      measuredResponseTimeMinutes: stats.avgResponseMinutesAll === null ? undefined : stats.avgResponseMinutesAll,
      activityStatus: isStale(
        { profileCreatedAt: facts.provider!.createdAt, lastCompletedAt: stats.lastCompletedAt, lastCountedReviewAt: lastReview },
        now,
      )
        ? 'inactive'
        : 'active',
    });
    await this.badges(
      scope,
      orgId,
      revokeAllBadges
        ? []
        : badgeDecisions(
            {
              verifiedTypes: facts.verifiedTypes,
              capabilities: caps.map((c) => ({
                id: c.id,
                brandNodeId: c.brandNodeId,
                serviceSystemNodeId: c.serviceSystemNodeId,
                level: levels.get(c.id) ?? 'self_declared',
              })),
              reviews,
              stats,
              evVerifiedCertification: facts.certifications.some((c) => c.type === 'ev_high_voltage' && c.verified),
              evSystemNodeId: await this.evSystem(),
            },
            now,
          ),
    );
    return linked.filter((e) => e.baseWeight > 0).length;
  }

  /** The EV battery/systems service system of 54 §4 ev_ready (taxonomy slug ev-hybrid-system). */
  private async evSystem(): Promise<string | null> {
    if (this.#evSystem === undefined) {
      const { nodes } = await this.taxonomy.catalog();
      this.#evSystem = nodes.find((n) => n.type === 'service_system' && n.slug === 'ev-hybrid-system' && n.status === 'active')?.id ?? null;
    }
    return this.#evSystem;
  }

  /** Awards what qualifies and revokes what no longer does (54 §4; only this worker awards badges, 52 ProviderBadge). */
  private async badges(scope: TxScope, orgId: string, decisions: BadgeDecision[]): Promise<void> {
    const current = await scope.db
      .selectFrom('trust.provider_badges')
      .selectAll()
      .where('provider_organization_id', '=', orgId)
      .where('status', 'in', ['pending_approval', 'active'])
      .where('deleted_at', 'is', null)
      .execute();
    const key = (type: string, scopeIds: string[]) => `${type}|${[...scopeIds].join(',')}`;
    const wanted = new Map(decisions.map((d) => [key(d.badgeType, d.scope), d]));
    for (const b of current) {
      const k = key(b.badge_type, arr(b.scope_taxonomy_node_ids));
      if (wanted.has(k)) {
        await scope.db
          .updateTable('trust.provider_badges')
          .set({ last_evaluated_at: sql`now()` })
          .where('id', '=', b.id)
          .execute();
        wanted.delete(k);
        continue;
      }
      // Badges granted by staff approval (verified_business) are revoked only when the rule stops holding too.
      await scope.db
        .updateTable('trust.provider_badges')
        .set({ status: 'revoked', revoked_reason: 'rule no longer met', last_evaluated_at: sql`now()` })
        .where('id', '=', b.id)
        .execute();
      await writeAudit(scope, {
        action: 'badge.revoked',
        entityType: 'provider_badge',
        entityId: b.id,
        previous: b.status,
        next: b.badge_type,
      });
      await publishEvent(scope, {
        type: 'badge.revoked',
        aggregateType: 'provider_badge',
        aggregateId: b.id,
        payload: { organization_id: orgId, badge_type: b.badge_type, rule_version: RULE_VERSION },
      });
    }
    for (const d of wanted.values()) {
      const row = await scope.db
        .insertInto('trust.provider_badges')
        .values({
          provider_organization_id: orgId,
          badge_type: d.badgeType,
          scope_taxonomy_node_ids: d.scope,
          rule_key: d.ruleKey,
          rule_version: RULE_VERSION,
          evaluation_snapshot: JSON.stringify(d.snapshot),
          requires_admin_approval: d.requiresAdminApproval,
          status: d.requiresAdminApproval ? 'pending_approval' : 'active',
        })
        .returning(['id', 'status'])
        .executeTakeFirstOrThrow();
      await writeAudit(scope, {
        action: 'badge.awarded',
        entityType: 'provider_badge',
        entityId: row.id,
        next: `${d.badgeType} ${row.status}`,
      });
      if (row.status === 'active')
        await publishEvent(scope, {
          type: 'badge.awarded',
          aggregateType: 'provider_badge',
          aggregateId: row.id,
          payload: { organization_id: orgId, badge_type: d.badgeType, scope_taxonomy_node_ids: d.scope, rule_version: RULE_VERSION },
        });
    }
  }

  /** Trust signals (52 TrustSignal), a new row only when a value changed. */
  private async signals(
    scope: TxScope,
    orgId: string,
    x: {
      reviews: ReviewFact[];
      stats: ProviderAppointmentStats | null;
      facts: OrgTrustFacts;
      provider: ScoreBreakdown | null;
      vendor: ScoreBreakdown | null;
      score: number;
      unanswered: number;
    },
    now: Date,
  ): Promise<void> {
    const out: { group: string; type: string; value: number | null; isPublic: boolean; details?: Record<string, unknown> }[] = [];
    const avg = weightedRating(x.reviews, now);
    out.push({ group: 'user_generated', type: 'avg_star_rating', value: avg, isPublic: true });
    out.push({ group: 'user_generated', type: 'review_count', value: countedReviews(x.reviews), isPublic: true });
    const s = x.stats;
    if (s) {
      out.push({
        group: 'platform_verified',
        type: 'request_response_rate',
        value: s.requests90 ? s.respondedWithin24h90 / s.requests90 : null,
        isPublic: false,
      });
      out.push({ group: 'provider_generated', type: 'avg_response_time', value: s.avgResponseMinutesAll, isPublic: false });
      const closed = s.completed90 + s.providerCancelledAfterConfirm90;
      out.push({ group: 'platform_verified', type: 'completion_rate', value: closed ? s.completed90 / closed : null, isPublic: false });
      out.push({
        group: 'platform_verified',
        type: 'provider_cancellation_rate',
        value: s.confirmed90 ? s.providerCancelledAfterConfirm90 / s.confirmed90 : null,
        isPublic: false,
      });
      // Informational only: never lowers the provider's score (54 §3.1).
      out.push({
        group: 'platform_verified',
        type: 'customer_no_show_rate',
        value: s.completed90 + s.noShow90 ? s.noShow90 / (s.completed90 + s.noShow90) : null,
        isPublic: false,
      });
      out.push({ group: 'platform_verified', type: 'confirmed_appointment_count', value: s.confirmed90, isPublic: false });
      out.push({ group: 'provider_generated', type: 'completed_job_count', value: s.completed12m, isPublic: false });
    }
    out.push({
      group: 'provider_generated',
      type: 'profile_completeness',
      value: x.facts.provider?.profileCompleteness ?? x.facts.vendor?.profileCompleteness ?? null,
      isPublic: false,
    });
    out.push({
      group: 'provider_generated',
      type: 'certification_count',
      value: x.facts.certifications.filter((c) => c.verified).length,
      isPublic: false,
    });
    if (x.facts.vendor)
      out.push({ group: 'composite', type: 'catalog_quality_score', value: x.facts.vendor.catalogQualityScore, isPublic: false });
    out.push({
      group: 'composite',
      type: 'overall_trust_score',
      value: x.score,
      isPublic: true,
      details: { provider: x.provider, vendor: x.vendor, unanswered_negative_reviews: x.unanswered },
    });
    for (const sig of out) {
      if (sig.value === null || !Number.isFinite(sig.value)) continue;
      const value = String(Math.round(sig.value * 10_000) / 10_000);
      const latest = await scope.db
        .selectFrom('trust.trust_signals')
        .select('value')
        .where('subject_type', '=', 'organization')
        .where('subject_id', '=', orgId)
        .where('signal_type', '=', sig.type)
        .where('scope_taxonomy_node_id', 'is', null)
        .where('deleted_at', 'is', null)
        .orderBy('calculated_at', 'desc')
        .orderBy('id', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (latest && Number(latest.value) === Number(value)) continue;
      await scope.db
        .insertInto('trust.trust_signals')
        .values({
          subject_type: 'organization',
          subject_id: orgId,
          signal_group: sig.group,
          signal_type: sig.type,
          value,
          value_details: sig.details ? JSON.stringify(sig.details) : null,
          rule_version: RULE_VERSION,
          is_public: sig.isPublic,
        })
        .execute();
    }
  }
}
