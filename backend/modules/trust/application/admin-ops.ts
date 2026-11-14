// Trust on the admin plane (40 §23.4; 52 §11 Path 2, Dispute, ProviderBadge;
// 54 §3.3, §9.7). CarPal reviewers decide Path 2 reviews once the business
// step is confirmed or no_response; approval publishes the review as
// "Approved by the business and CarPal" (approved_without_visit, weight 0.6).
// Disputes are mediated and resolved by a staff member other than the one
// whose decision is disputed: an upheld approval objection publishes the
// review with disputed_by_business, an upheld fake-review dispute removes it
// and makes W3 apply the −50 penalty with every badge revoked. Badges that
// need staff approval (verified_business) become active here. Every decision
// is audited, logged as a moderation action and published, so W2 and W3
// converge.
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { writeAudit } from '#libs/audit/index.js';
import { ApiError } from '#libs/contract/index.js';
import { Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import type { Locale } from '#libs/i18n/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { auditStaffRead, FourEyes, ModerationLog, ModerationTargets, StaffNames, staffOf } from '#modules/admin/interface/admin.js';
import { AccountAdmin, authorDisplayName, UserCards } from '#modules/identity/interface/identity.js';
import { MediaService } from '#modules/media/interface/media.js';
import { OrgCards, toOrgSummary } from '#modules/organization/interface/org-cards.js';
import { toBadge, toDispute, type BadgeRow, type DisputeRow, type ReviewRow } from '../api/projections.js';
import { TrustAdmin } from '../interface/trust.js';
import { afterId, failIf, pageOf, ReviewViews } from './common.js';

const PATH2_WEIGHT = '0.600';
/** 52 §11, 54 §9.7: a rating is never a reason to reject. */
const RATING_REASONS = ['rating', 'low_rating', 'negative_rating', 'bad_rating', 'star_rating'];
const OPEN_DISPUTE = ['open', 'in_mediation'];

async function loadReview(scope: TxScope, id: string, lock = false): Promise<ReviewRow> {
  const q = scope.db.selectFrom('trust.reviews').selectAll().where('id', '=', id).where('deleted_at', 'is', null);
  const r = await (lock ? q.forUpdate() : q).executeTakeFirst();
  if (!r) throw new ApiError('NOT_FOUND');
  return r;
}

/** Path 2 stage of a pending review (40 admin.review_approvals_queue stage). */
export function approvalStage(r: Pick<ReviewRow, 'business_confirmation_status' | 'reviewer_decision'>): string {
  if (r.reviewer_decision === 'evidence_requested') return 'evidence_requested';
  if (r.business_confirmation_status === 'pending') return 'awaiting_business';
  return 'awaiting_reviewer';
}

/** 40 StaffReviewApprovalView: no author contact data, evidence attachments for staff. */
@Injectable()
export class ApprovalViews {
  constructor(
    private readonly reviews: ReviewViews,
    private readonly users: UserCards,
    private readonly accounts: AccountAdmin,
    private readonly orgs: OrgCards,
    private readonly media: MediaService,
    private readonly names: StaffNames,
  ) {}

  async many(scope: TxScope, rows: ReviewRow[], locale: Locale) {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const [views, authors, subjects, evidence, disputes] = await Promise.all([
      this.reviews.authorViews(scope, rows, locale, new Set()),
      this.users.cards(
        scope,
        rows.map((r) => r.author_user_id),
      ),
      this.orgs.cards(
        scope,
        rows.map((r) => r.subject_organization_id),
      ),
      this.media.attachmentViews(scope, 'review', ids),
      scope.db
        .selectFrom('trust.disputes')
        .select(['id', 'target_entity_id'])
        .where('target_entity_type', '=', 'review')
        .where('target_entity_id', 'in', ids)
        .where('dispute_type', '=', 'review_approval_objection')
        .where('status', 'in', OPEN_DISPUTE)
        .where('deleted_at', 'is', null)
        .execute(),
    ]);
    const deciders = await this.names.names(
      scope,
      rows.map((r) => r.reviewer_user_id),
      locale,
    );
    const out = [];
    for (const [i, r] of rows.entries()) {
      const facts = await this.accounts.facts(scope, r.author_user_id);
      const history = await scope.db
        .selectFrom('trust.reviews')
        .select([
          sql<string>`count(*) FILTER (WHERE status = 'published')`.as('published'),
          sql<string>`count(*) FILTER (WHERE status = 'rejected')`.as('rejected'),
        ])
        .where('author_user_id', '=', r.author_user_id)
        .where('deleted_at', 'is', null)
        .executeTakeFirstOrThrow();
      const subject = subjects.get(r.subject_organization_id);
      out.push({
        review: views[i]!,
        author_display_name: authorDisplayName(authors.get(r.author_user_id), locale),
        subject: subject
          ? toOrgSummary(subject)
          : {
              id: r.subject_organization_id,
              name: 'Unknown',
              organization_type: 'provider',
              slug: null,
              logo_url: null,
              status: 'archived',
              verification_status: 'unverified',
            },
        business_confirmation_source: r.business_confirmation_source,
        business_note: r.business_confirmation_note,
        business_confirmation_due_at: r.business_confirmation_due_at ? r.business_confirmation_due_at.toISOString() : null,
        author_history: {
          account_age_days: facts ? Math.max(0, Math.floor((Date.now() - facts.createdAt.getTime()) / 86_400_000)) : 0,
          published_reviews: Number(history.published),
          rejected_reviews: Number(history.rejected),
          verified_contact: facts?.verifiedContact ?? false,
        },
        evidence: (evidence.get(r.id) ?? []).filter((m) => m.role === 'evidence').slice(0, 20),
        // SEC-BF-1 fraud signals have no data source yet (S7 deviation): none are reported.
        fraud_signals: [] as { signal: string; score: number }[],
        dispute_id: disputes.find((d) => d.target_entity_id === r.id)?.id ?? null,
        first_decider_display: r.reviewer_user_id ? (deciders.get(r.reviewer_user_id) ?? null) : null,
        // S18 (BR-29): the queue's stage while pending, and when the business answered (or the deadline passed).
        stage: r.status === 'pending_approval' ? approvalStage(r) : null,
        business_answered_at: r.business_confirmed_at ? r.business_confirmed_at.toISOString() : null,
      });
    }
    return out;
  }
}

@Injectable()
@Operation('admin.review_approvals_queue')
export class ReviewApprovalsQueueHandler implements OperationHandler {
  constructor(private readonly views: ApprovalViews) {}

  async handle(ctx: OperationContext<undefined, { stage?: string; limit: number }>): Promise<OperationResult> {
    staffOf(ctx);
    const q = ctx.query;
    const after = afterId(ctx);
    const body = await ctx.tx(
      async (scope) => {
        // Oldest first (2-working-day target): ascending ids.
        let s = scope.db
          .selectFrom('trust.reviews')
          .selectAll()
          .where('status', '=', 'pending_approval')
          .where('confirmation_path', '=', 'approval_based')
          .where('deleted_at', 'is', null);
        if (q.stage === 'awaiting_business')
          s = s.where('business_confirmation_status', '=', 'pending').where('reviewer_decision', '<>', 'evidence_requested');
        else if (q.stage === 'awaiting_reviewer')
          s = s
            .where('business_confirmation_status', 'in', ['confirmed', 'no_response', 'rejected'])
            .where('reviewer_decision', '=', 'pending');
        else if (q.stage === 'evidence_requested') s = s.where('reviewer_decision', '=', 'evidence_requested');
        if (after) s = s.where('id', '>', after);
        const rows = await s
          .orderBy('id')
          .limit(q.limit + 1)
          .execute();
        return pageOf(ctx, rows, await this.views.many(scope, rows.slice(0, q.limit), ctx.locale));
      },
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('admin.review_approval_get')
export class ReviewApprovalGetHandler implements OperationHandler {
  constructor(private readonly views: ApprovalViews) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const s = staffOf(ctx);
    const body = await ctx.tx(async (scope) => {
      const r = await loadReview(scope, ctx.params.review_id!);
      if (r.confirmation_path !== 'approval_based') throw new ApiError('NOT_FOUND');
      await auditStaffRead(scope, s, 'review', r.id, 'path 2 approval view');
      return (await this.views.many(scope, [r], ctx.locale))[0]!;
    });
    return { body };
  }
}

/** Publishes a Path 2 review after the CarPal decision (status, weight and events in one place). */
async function publishApproved(scope: TxScope, r: ReviewRow, set: Record<string, unknown>): Promise<void> {
  await scope.db
    .updateTable('trust.reviews')
    .set({
      ...set,
      verified_status: 'approved_without_visit',
      status: 'published',
      published_at: sql<Date>`now()`,
      trust_weight: PATH2_WEIGHT,
      counts_toward_core_score: true,
    })
    .where('id', '=', r.id)
    .execute();
  const payload = {
    subject_organization_id: r.subject_organization_id,
    organization_id: r.subject_organization_id,
    subject_type: r.subject_type,
  };
  await publishEvent(scope, { type: 'review.approved', aggregateType: 'review', aggregateId: r.id, payload });
  await publishEvent(scope, {
    type: 'review.published',
    aggregateType: 'review',
    aggregateId: r.id,
    payload: { ...payload, author_user_id: r.author_user_id },
  });
}

type Decision = { decision: 'approved' | 'rejected' | 'evidence_requested'; reason_code: string; reason: string };
const ACTION_OF: Record<Decision['decision'], string> = {
  approved: 'confirm_review_approval',
  rejected: 'reject_review_approval',
  evidence_requested: 'request_evidence',
};

@Injectable()
@Operation('admin.review_approval_decide')
export class ReviewApprovalDecideHandler implements OperationHandler {
  constructor(
    private readonly views: ApprovalViews,
    private readonly log: ModerationLog,
  ) {}

  async handle(ctx: OperationContext<Decision>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const b = ctx.body;
    if (b.decision === 'rejected' && RATING_REASONS.includes(b.reason_code.toLowerCase()))
      failIf([{ pointer: '/reason_code', code: 'enum' }]);
    const body = await ctx.tx(async (scope) => {
      const r = await loadReview(scope, ctx.params.review_id!, true);
      if (r.confirmation_path !== 'approval_based') throw new ApiError('NOT_FOUND');
      if (r.author_user_id === s.userId) throw new ApiError('SELF_APPROVAL_FORBIDDEN', { detail: 'own review' });
      if (r.status !== 'pending_approval') throw new ApiError('INVALID_TRANSITION', { detail: r.status });
      if (b.decision === 'approved') {
        // The business step first: confirmed or no_response (a rejection is decided through its objection dispute).
        if (!['confirmed', 'no_response'].includes(r.business_confirmation_status ?? ''))
          throw new ApiError('INVALID_TRANSITION', { detail: 'business_step_pending' });
        await publishApproved(scope, r, {
          reviewer_decision: 'approved',
          reviewer_user_id: s.userId,
          reviewer_decided_at: sql<Date>`now()`,
          reviewer_reason_code: b.reason_code,
        });
      } else {
        await scope.db
          .updateTable('trust.reviews')
          .set({
            reviewer_decision: b.decision,
            reviewer_user_id: s.userId,
            reviewer_decided_at: sql<Date>`now()`,
            reviewer_reason_code: b.reason_code,
            ...(b.decision === 'rejected' ? { status: 'rejected', verified_status: 'rejected' } : {}),
          })
          .where('id', '=', r.id)
          .execute();
      }
      const actionId = await this.log.record(scope, {
        targetType: 'review',
        targetId: r.id,
        actionType: ACTION_OF[b.decision],
        reason: b.reason,
        params: { reason_code: b.reason_code, subject_organization_id: r.subject_organization_id },
        actorUserId: s.userId,
      });
      await writeAudit(scope, {
        action: 'review.reviewer_decided',
        entityType: 'review',
        entityId: r.id,
        reason: b.reason,
        previous: `${r.status}/${r.reviewer_decision}`,
        next: `${b.decision} (${b.reason_code})`,
        accessPurpose: s.purpose,
      });
      await publishEvent(scope, {
        type: 'moderation.action.taken',
        aggregateType: 'moderation_action',
        aggregateId: actionId,
        payload: { action_type: ACTION_OF[b.decision], target_type: 'review', target_id: r.id, organization_id: r.subject_organization_id },
      });
      return (await this.views.many(scope, [await loadReview(scope, r.id)], ctx.locale))[0]!;
    });
    return { body };
  }
}

@Injectable()
@Operation('admin.review_move_to_approval_path')
export class ReviewMoveToApprovalPathHandler implements OperationHandler {
  constructor(private readonly fourEyes: FourEyes) {}

  async handle(ctx: OperationContext<{ reason: string }>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const body = await ctx.tx(async (scope) => {
      const r = await loadReview(scope, ctx.params.review_id!);
      if (r.confirmation_path !== 'visit_based' || !['published', 'pending_moderation'].includes(r.status))
        throw new ApiError('INVALID_TRANSITION', { detail: `${r.confirmation_path} ${r.status}` });
      return this.fourEyes.request(
        scope,
        s.userId,
        {
          opId: 'admin.review_move_to_approval_path',
          targetType: 'review',
          targetId: r.id,
          payload: { review_id: r.id },
          summary: `Move review ${r.id} (${r.verified_status}) to the approval path`,
          reason: ctx.body.reason,
          requiredRole: 'platform_moderator',
        },
        ctx.locale,
      );
    });
    return { status: 202, body };
  }
}

/** Four-eyes executor of admin.review_move_to_approval_path: visit evidence proved invalid → Path 2 from the business step. */
export async function moveToApprovalPath(scope: TxScope, reviewId: string, reason: string): Promise<void> {
  const r = await loadReview(scope, reviewId, true);
  if (r.confirmation_path !== 'visit_based' || !['published', 'pending_moderation'].includes(r.status))
    throw new ApiError('INVALID_TRANSITION', { detail: `${r.confirmation_path} ${r.status}` });
  await scope.db
    .updateTable('trust.reviews')
    .set({
      confirmation_path: 'approval_based',
      verified_status: 'pending_approval',
      status: 'pending_approval',
      business_confirmation_status: 'pending',
      business_confirmation_due_at: sql<Date>`now() + interval '7 days'`,
      reviewer_decision: 'pending',
      published_at: null,
      counts_toward_core_score: false,
      trust_weight: null,
    })
    .where('id', '=', r.id)
    .execute();
  await writeAudit(scope, {
    action: 'review.moved_to_approval_path',
    entityType: 'review',
    entityId: r.id,
    reason,
    previous: `${r.verified_status} ${r.status}`,
    next: 'pending_approval',
  });
  const payload = { subject_organization_id: r.subject_organization_id, organization_id: r.subject_organization_id };
  if (r.status === 'published') await publishEvent(scope, { type: 'review.removed', aggregateType: 'review', aggregateId: r.id, payload });
  await publishEvent(scope, { type: 'review.approval.requested', aggregateType: 'review', aggregateId: r.id, payload });
}

/** The moderation action recorded for a resolved dispute, or null when the outcome changes nothing. */
export function outcomeAction(disputeType: string, upheld: boolean): string | null {
  if (disputeType === 'review_approval_objection') return upheld ? 'confirm_review_approval' : 'reject_review_approval';
  if (!upheld) return null;
  if (disputeType === 'fake_review') return 'remove';
  if (disputeType === 'badge_challenge') return 'revoke_badge';
  if (disputeType === 'moderation_appeal') return 'restore';
  return null;
}

/** 40 StaffDispute. */
@Injectable()
export class StaffDisputeViews {
  constructor(
    private readonly names: StaffNames,
    private readonly orgs: OrgCards,
  ) {}

  async many(scope: TxScope, rows: DisputeRow[], locale: string) {
    const names = await this.names.names(
      scope,
      rows.flatMap((d) => [d.raised_by_user_id, d.assigned_to]),
      locale,
    );
    const orgs = await this.orgs.cards(
      scope,
      rows.map((d) => d.raised_by_organization_id).filter((x): x is string => !!x),
    );
    return rows.map((d) => {
      const org = d.raised_by_organization_id ? orgs.get(d.raised_by_organization_id) : undefined;
      return {
        ...toDispute(d),
        raised_by_display: names.get(d.raised_by_user_id)!,
        raised_by_organization: org ? toOrgSummary(org) : null,
        assigned_to_display: d.assigned_to ? (names.get(d.assigned_to) ?? null) : null,
        moderator_notes: d.moderator_notes,
      };
    });
  }
}

@Injectable()
@Operation('admin.disputes_queue')
export class DisputesQueueHandler implements OperationHandler {
  constructor(private readonly views: StaffDisputeViews) {}

  async handle(ctx: OperationContext<undefined, { status?: string; dispute_type?: string; assigned_to_me?: boolean; limit: number }>) {
    const s = staffOf(ctx);
    const q = ctx.query;
    const after = afterId(ctx);
    const body = await ctx.tx(
      async (scope) => {
        let d = scope.db.selectFrom('trust.disputes').selectAll().where('deleted_at', 'is', null);
        if (q.status) d = d.where('status', '=', q.status);
        if (q.dispute_type) d = d.where('dispute_type', '=', q.dispute_type);
        if (q.assigned_to_me !== undefined)
          d = q.assigned_to_me ? d.where('assigned_to', '=', s.userId) : d.where('assigned_to', 'is', null);
        if (after) d = d.where('id', '>', after);
        const rows = await d
          .orderBy('id')
          .limit(q.limit + 1)
          .execute();
        return pageOf(ctx, rows, await this.views.many(scope, rows.slice(0, q.limit), ctx.locale));
      },
      { readOnly: true },
    );
    return { body };
  }
}

async function loadDispute(scope: TxScope, id: string, lock = false): Promise<DisputeRow> {
  const q = scope.db.selectFrom('trust.disputes').selectAll().where('id', '=', id).where('deleted_at', 'is', null);
  const d = await (lock ? q.forUpdate() : q).executeTakeFirst();
  if (!d) throw new ApiError('NOT_FOUND');
  return d;
}

@Injectable()
@Operation('admin.dispute_get')
export class DisputeGetHandler implements OperationHandler {
  constructor(private readonly views: StaffDisputeViews) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const s = staffOf(ctx);
    const body = await ctx.tx(async (scope) => {
      const d = await loadDispute(scope, ctx.params.dispute_id!);
      await auditStaffRead(scope, s, 'dispute', d.id, `dispute ${d.dispute_type}`);
      return (await this.views.many(scope, [d], ctx.locale))[0]!;
    });
    return { body };
  }
}

type Resolution = {
  status: 'in_mediation' | 'resolved_upheld' | 'resolved_rejected';
  resolution?: string;
  moderator_notes?: string;
  reason: string;
};

@Injectable()
@Operation('admin.dispute_resolve')
export class DisputeResolveHandler implements OperationHandler {
  constructor(
    private readonly views: StaffDisputeViews,
    private readonly log: ModerationLog,
    private readonly targets: ModerationTargets,
    private readonly trust: TrustAdmin,
  ) {}

  async handle(ctx: OperationContext<Resolution>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const b = ctx.body;
    const resolving = b.status !== 'in_mediation';
    if (resolving && !b.resolution) failIf([{ pointer: '/resolution', code: 'conditional_required' }]);
    const body = await ctx.tx(async (scope) => {
      const d = await loadDispute(scope, ctx.params.dispute_id!, true);
      if (!OPEN_DISPUTE.includes(d.status) || d.status === b.status) throw new ApiError('INVALID_TRANSITION', { detail: d.status });
      if (d.raised_by_user_id === s.userId) throw new ApiError('SELF_APPROVAL_FORBIDDEN', { detail: 'own dispute' });
      const review = d.target_entity_type === 'review' ? await loadReview(scope, d.target_entity_id, true) : null;
      // The decider differs from whoever made the decision under dispute (52 Dispute, SEC-AZ-10).
      if (review && review.reviewer_user_id === s.userId) throw new ApiError('SELF_APPROVAL_FORBIDDEN', { detail: 'first reviewer' });
      if (d.target_entity_type === 'moderation_action' && (await this.log.get(scope, d.target_entity_id))?.actorUserId === s.userId)
        throw new ApiError('SELF_APPROVAL_FORBIDDEN', { detail: 'own moderation action' });
      const row = await scope.db
        .updateTable('trust.disputes')
        .set({
          status: b.status,
          assigned_to: d.assigned_to ?? s.userId,
          ...(b.resolution !== undefined ? { resolution: b.resolution } : {}),
          ...(b.moderator_notes !== undefined ? { moderator_notes: b.moderator_notes } : {}),
          // S18 (BR-29): the decider, for admin.my_decisions_list.
          ...(resolving ? { resolved_at: sql<Date>`now()`, resolved_by: s.userId } : {}),
        })
        .where('id', '=', d.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      let subjectOrg: string | null = review?.subject_organization_id ?? null;
      if (resolving) subjectOrg = (await this.outcome(scope, d, review, b, s.userId)) ?? subjectOrg;
      // An outcome that changes the target is a moderation action (52 ModerationAction); the fake flag feeds 54 §3.3.
      const actionType = resolving ? outcomeAction(d.dispute_type, b.status === 'resolved_upheld') : null;
      const actionId = actionType
        ? await this.log.record(scope, {
            targetType: d.target_entity_type,
            targetId: d.target_entity_id,
            actionType,
            reason: b.reason,
            params: {
              dispute_id: d.id,
              dispute_type: d.dispute_type,
              outcome: b.status,
              ...(subjectOrg ? { subject_organization_id: subjectOrg } : {}),
              ...(actionType === 'remove' ? { fake: true } : {}),
            },
            actorUserId: s.userId,
          })
        : null;
      await writeAudit(scope, {
        action: 'dispute.status_changed',
        entityType: 'dispute',
        entityId: d.id,
        reason: b.reason,
        previous: d.status,
        next: `${b.status}${b.resolution ? `: ${b.resolution}` : ''}`.slice(0, 2000),
        accessPurpose: s.purpose,
      });
      await publishEvent(scope, {
        type: 'moderation.action.taken',
        aggregateType: actionId ? 'moderation_action' : 'dispute',
        aggregateId: actionId ?? d.id,
        payload: {
          action_type: actionType ?? 'dispute_update',
          dispute_id: d.id,
          outcome: b.status,
          target_type: d.target_entity_type,
          target_id: d.target_entity_id,
          organization_id: subjectOrg,
        },
      });
      return (await this.views.many(scope, [row], ctx.locale))[0]!;
    });
    return { body };
  }

  /** Effects of a resolved dispute on its target; returns the organization concerned. */
  private async outcome(scope: TxScope, d: DisputeRow, review: ReviewRow | null, b: Resolution, staffId: string): Promise<string | null> {
    const upheld = b.status === 'resolved_upheld';
    if (d.dispute_type === 'review_approval_objection' && review && review.status === 'pending_approval') {
      if (upheld)
        // 52 §11: upheld → published with "Disputed by the business" (the dispute decider is the second reviewer).
        await publishApproved(scope, review, {
          disputed_by_business: true,
          reviewer_decision: 'approved',
          reviewer_user_id: staffId,
          reviewer_decided_at: sql<Date>`now()`,
          reviewer_reason_code: 'objection_upheld',
        });
      else
        await scope.db
          .updateTable('trust.reviews')
          .set({
            status: 'rejected',
            verified_status: 'rejected',
            reviewer_decision: 'rejected',
            reviewer_user_id: staffId,
            reviewer_decided_at: sql<Date>`now()`,
            reviewer_reason_code: 'objection_sustained',
          })
          .where('id', '=', review.id)
          .execute();
      return review.subject_organization_id;
    }
    if (!upheld) return null;
    if (d.dispute_type === 'fake_review' && review) {
      await this.targets.get('review')?.apply?.(scope, review.id, 'remove');
      return review.subject_organization_id;
    }
    if (d.dispute_type === 'badge_challenge' && d.target_entity_type === 'badge') {
      const r = await this.trust.revokeBadge(scope, d.target_entity_id, `badge challenge upheld (dispute ${d.id})`);
      return r?.organizationId ?? null;
    }
    if (d.dispute_type === 'moderation_appeal' && d.target_entity_type === 'moderation_action') {
      const a = await this.log.get(scope, d.target_entity_id);
      if (a && ['hide', 'remove'].includes(a.actionType)) await this.targets.get(a.targetType)?.apply?.(scope, a.targetId, 'restore');
      return typeof a?.params.subject_organization_id === 'string' ? a.params.subject_organization_id : null;
    }
    return null;
  }
}

/** admin.my_decisions_list: the last 30 days, at most 200 decisions (40 §23.4). */
const DECISION_WINDOW_MS = 30 * 86_400_000;
const DECISIONS_MAX = 200;
const APPROVAL_DECISION: Record<string, 'approved' | 'rejected' | 'evidence_requested'> = {
  confirm_review_approval: 'approved',
  reject_review_approval: 'rejected',
  request_evidence: 'evidence_requested',
};

type Decision40 = {
  kind: 'approval' | 'dispute';
  decided_at: string;
  decision: string;
  reason_code: string | null;
  review_id: string | null;
  review_status: string | null;
  dispute_id: string | null;
  dispute_type: string | null;
  dispute_status: string | null;
  subject: ReturnType<typeof toOrgSummary> | null;
};

/**
 * admin.my_decisions_list (S18, BR-29, DI-25): the caller's own Path 2 decisions (from the moderation log) and dispute
 * resolutions (trust.disputes.resolved_by) of the last 30 days, newest first, as summaries without an access purpose:
 * no author, reporter or evidence data, only the decision and the business it concerned.
 */
@Injectable()
@Operation('admin.my_decisions_list')
export class MyDecisionsListHandler implements OperationHandler {
  constructor(
    private readonly log: ModerationLog,
    private readonly orgs: OrgCards,
  ) {}

  async handle(ctx: OperationContext<undefined, { kind?: 'approval' | 'dispute' }>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const kind = ctx.query.kind;
    const since = new Date(Date.now() - DECISION_WINDOW_MS);
    const body = await ctx.tx(
      async (scope) => {
        const approvals =
          kind === 'dispute' ? [] : await this.log.byActor(scope, s.userId, Object.keys(APPROVAL_DECISION), since, DECISIONS_MAX + 1);
        const disputes =
          kind === 'approval'
            ? []
            : await scope.db
                .selectFrom('trust.disputes')
                .selectAll()
                .where('resolved_by', '=', s.userId)
                .where('resolved_at', '>=', since)
                .where('status', 'in', ['resolved_upheld', 'resolved_rejected'])
                .where('deleted_at', 'is', null)
                .orderBy('resolved_at', 'desc')
                .orderBy('id', 'desc')
                .limit(DECISIONS_MAX + 1)
                .execute();
        const reviewIds = [
          ...approvals.filter((a) => a.targetType === 'review').map((a) => a.targetId),
          ...disputes.filter((d) => d.target_entity_type === 'review').map((d) => d.target_entity_id),
        ];
        const badgeIds = disputes.filter((d) => d.target_entity_type === 'badge').map((d) => d.target_entity_id);
        const [reviews, badges] = await Promise.all([
          reviewIds.length
            ? scope.db
                .selectFrom('trust.reviews')
                .select(['id', 'status', 'subject_organization_id'])
                .where('id', 'in', reviewIds)
                .execute()
            : [],
          badgeIds.length
            ? scope.db.selectFrom('trust.provider_badges').select(['id', 'provider_organization_id']).where('id', 'in', badgeIds).execute()
            : [],
        ]);
        const review = new Map(reviews.map((r) => [r.id, r]));
        const badgeOrg = new Map(badges.map((b) => [b.id, b.provider_organization_id]));
        const orgOf = (d: DisputeRow): string | null =>
          (d.target_entity_type === 'review' ? review.get(d.target_entity_id)?.subject_organization_id : undefined) ??
          (d.target_entity_type === 'badge' ? badgeOrg.get(d.target_entity_id) : undefined) ??
          d.raised_by_organization_id;
        const cards = await this.orgs.cards(scope, [
          ...new Set([...reviews.map((r) => r.subject_organization_id), ...disputes.map(orgOf)].filter((x): x is string => !!x)),
        ]);
        const summary = (id: string | null | undefined) => {
          const c = id ? cards.get(id) : undefined;
          return c ? toOrgSummary(c) : null;
        };
        const items: (Decision40 & { at: number })[] = [
          ...approvals.map((a) => {
            const r = review.get(a.targetId);
            return {
              at: a.createdAt.getTime(),
              kind: 'approval' as const,
              decided_at: a.createdAt.toISOString(),
              decision: APPROVAL_DECISION[a.actionType]!,
              reason_code: typeof a.params.reason_code === 'string' ? a.params.reason_code : null,
              review_id: a.targetType === 'review' ? a.targetId : null,
              review_status: r?.status ?? null,
              dispute_id: null,
              dispute_type: null,
              dispute_status: null,
              subject: summary(r?.subject_organization_id),
            };
          }),
          ...disputes.map((d) => ({
            at: d.resolved_at!.getTime(),
            kind: 'dispute' as const,
            decided_at: d.resolved_at!.toISOString(),
            decision: d.status,
            reason_code: null,
            review_id: d.target_entity_type === 'review' ? d.target_entity_id : null,
            review_status: d.target_entity_type === 'review' ? (review.get(d.target_entity_id)?.status ?? null) : null,
            dispute_id: d.id,
            dispute_type: d.dispute_type,
            dispute_status: d.status,
            subject: summary(orgOf(d)),
          })),
        ].sort((x, y) => y.at - x.at);
        return {
          items: items.slice(0, DECISIONS_MAX).map(({ at: _at, ...item }) => item),
          truncated: items.length > DECISIONS_MAX,
        };
      },
      { readOnly: true },
    );
    return { body };
  }
}

type BadgesQuery = { status?: string; organization_id?: string; badge_type?: string; limit: number };

/**
 * admin.badges_list (contract 1.4.0, admin console BR-31): badges with their organization, e.g. the Verified
 * Business badges waiting for approval (54 §4: the trust worker awards them pending_approval). Newest first.
 */
@Injectable()
@Operation('admin.badges_list')
export class BadgesListHandler implements OperationHandler {
  constructor(private readonly orgs: OrgCards) {}

  async handle(ctx: OperationContext<undefined, BadgesQuery>): Promise<OperationResult> {
    staffOf(ctx);
    const q = ctx.query;
    const after = afterId(ctx);
    const body = await ctx.tx(
      async (scope) => {
        let b = scope.db.selectFrom('trust.provider_badges').selectAll().where('deleted_at', 'is', null);
        if (q.status) b = b.where('status', '=', q.status);
        if (q.organization_id) b = b.where('provider_organization_id', '=', q.organization_id);
        if (q.badge_type) b = b.where('badge_type', '=', q.badge_type);
        if (after) b = b.where('id', '<', after);
        const rows = (await b
          .orderBy('id', 'desc')
          .limit(q.limit + 1)
          .execute()) as BadgeRow[];
        const cards = await this.orgs.cards(
          scope,
          rows.map((r) => r.provider_organization_id),
        );
        // A badge whose organization card is gone (deleted organization) is not listed.
        const items = rows.slice(0, q.limit).flatMap((r) => {
          const card = cards.get(r.provider_organization_id);
          return card ? [{ ...toBadge(r), organization: toOrgSummary(card) }] : [];
        });
        return ctx.page(items, rows.length > q.limit ? { id: rows[q.limit - 1]!.id } : null);
      },
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('admin.badge_approve')
export class BadgeApproveHandler implements OperationHandler {
  async handle(ctx: OperationContext<{ reason: string }>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const body = await ctx.tx(async (scope) => {
      const b = (await scope.db
        .selectFrom('trust.provider_badges')
        .selectAll()
        .where('id', '=', ctx.params.badge_id!)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst()) as BadgeRow | undefined;
      if (!b) throw new ApiError('NOT_FOUND');
      if (b.status !== 'pending_approval' || !b.requires_admin_approval) throw new ApiError('INVALID_TRANSITION', { detail: b.status });
      const row = await scope.db
        .updateTable('trust.provider_badges')
        .set({ status: 'active', approved_by: s.userId, awarded_at: sql<Date>`now()` })
        .where('id', '=', b.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeAudit(scope, {
        action: 'badge.approved',
        entityType: 'provider_badge',
        entityId: b.id,
        reason: ctx.body.reason,
        previous: 'pending_approval',
        next: `${b.badge_type} active`,
      });
      await publishEvent(scope, {
        type: 'badge.awarded',
        aggregateType: 'provider_badge',
        aggregateId: b.id,
        payload: {
          organization_id: b.provider_organization_id,
          badge_type: b.badge_type,
          scope_taxonomy_node_ids: b.scope_taxonomy_node_ids,
          rule_version: b.rule_version,
        },
      });
      return toBadge(row);
    });
    return { body };
  }
}

@Injectable()
export class DbTrustAdmin extends TrustAdmin {
  async revokeBadge(scope: TxScope, badgeId: string, reason: string): Promise<{ organizationId: string } | null> {
    const b = await scope.db
      .selectFrom('trust.provider_badges')
      .select(['id', 'status', 'badge_type', 'provider_organization_id'])
      .where('id', '=', badgeId)
      .where('deleted_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    if (!b || !['active', 'pending_approval'].includes(b.status)) return null;
    await scope.db
      .updateTable('trust.provider_badges')
      .set({ status: 'revoked', revoked_reason: reason.slice(0, 500) })
      .where('id', '=', b.id)
      .execute();
    await writeAudit(scope, {
      action: 'badge.revoked',
      entityType: 'provider_badge',
      entityId: b.id,
      reason,
      previous: b.status,
      next: `${b.badge_type} revoked`,
    });
    await publishEvent(scope, {
      type: 'badge.revoked',
      aggregateType: 'provider_badge',
      aggregateId: b.id,
      payload: { organization_id: b.provider_organization_id, badge_type: b.badge_type, by: 'moderation' },
    });
    return { organizationId: b.provider_organization_id };
  }

  async userCounts(scope: TxScope, userId: string): Promise<{ reviews: number; openDisputes: number }> {
    const { rows } = await sql<{ reviews: string; disputes: string }>`
      SELECT (SELECT count(*) FROM trust.reviews WHERE author_user_id = ${userId}::uuid AND deleted_at IS NULL) AS reviews,
             (SELECT count(*) FROM trust.disputes WHERE raised_by_user_id = ${userId}::uuid AND status IN ('open','in_mediation')
                AND deleted_at IS NULL) AS disputes`.execute(scope.db);
    return { reviews: Number(rows[0]!.reviews), openDisputes: Number(rows[0]!.disputes) };
  }
}
