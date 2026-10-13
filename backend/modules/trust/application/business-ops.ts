// Business operations on reviews (40 §15.3): the review inbox (published and
// removed reviews only: a Path 2 review waiting for approval is shown to the
// business as the relationship question alone, never its rating or text —
// MVP Module F), responses (one draft and one published at a time; AI drafts
// only through this human flow), the Path 2 approval answer (a rejection never
// removes the review: it opens a review_approval_objection dispute decided by
// CarPal), badges and the organization's own trust signals.
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { writeAudit } from '#libs/audit/index.js';
import { ApiError } from '#libs/contract/index.js';
import { registerConstraintErrors } from '#libs/db/index.js';
import { ACK, created, Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { AppointmentFacts } from '#modules/appointment/interface/appointments.js';
import { authorDisplayName, UserCards } from '#modules/identity/interface/identity.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { VehicleCards } from '#modules/vehicle/interface/vehicles.js';
import { toBadge, toOrgReview, toSignal, type ResponseRow, type ReviewRow } from '../api/projections.js';
import { afterId, member, notFoundAt, pageOf, ReviewViews } from './common.js';
import { visitContext } from './invitation-ops.js';

registerConstraintErrors({
  // 52 ReviewResponse: one draft per review (40 review_responses.create 409 DUPLICATE(draft_exists)).
  review_responses_draft_uq: { code: 'DUPLICATE', pointer: '/response_text', fieldCode: 'not_unique' },
  // 52 Dispute: one open dispute per raiser and target (40 disputes.create 409 DUPLICATE(open_dispute)).
  disputes_open_uq: { code: 'DUPLICATE', pointer: '/target', fieldCode: 'not_unique' },
});

async function loadSubjectReview(scope: TxScope, orgId: string, id: string, lock = false): Promise<ReviewRow> {
  const q = scope.db
    .selectFrom('trust.reviews')
    .selectAll()
    .where('id', '=', id)
    .where('subject_organization_id', '=', orgId)
    .where('status', 'in', ['published', 'removed'])
    .where('deleted_at', 'is', null);
  const row = await (lock ? q.forUpdate() : q).executeTakeFirst();
  if (!row) throw new ApiError('NOT_FOUND');
  return row;
}

@Injectable()
export class OrgReviewViews {
  constructor(private readonly views: ReviewViews) {}

  async many(scope: TxScope, rows: readonly ReviewRow[], locale: string) {
    const publicViews = await this.views.publicViews(scope, rows, locale as never, 'public');
    const drafts = await this.views.drafts(scope, rows, locale as never);
    return rows.map((r) => {
      const p = publicViews.get(r.id)!;
      // A removed review keeps its last publication time for the inbox.
      return toOrgReview(p, r, drafts.get(r.id) ?? null);
    });
  }
}

@Injectable()
@Operation('reviews.org_list')
export class ReviewsOrgListHandler implements OperationHandler {
  constructor(private readonly views: OrgReviewViews) {}

  async handle(
    ctx: OperationContext<undefined, { status?: 'published' | 'removed'; rating?: number; has_response?: boolean; limit: number }>,
  ): Promise<OperationResult> {
    const m = member(ctx);
    const q = ctx.query;
    const after = afterId(ctx);
    const body = await ctx.tx(
      async (scope) => {
        let s = scope.db
          .selectFrom('trust.reviews')
          .selectAll()
          .where('subject_organization_id', '=', m.orgId)
          .where('status', 'in', q.status ? [q.status] : ['published', 'removed'])
          .where('published_at', 'is not', null)
          .where('deleted_at', 'is', null);
        if (q.rating) s = s.where('overall_rating', '=', q.rating);
        if (q.has_response !== undefined) {
          const exists = sql<boolean>`EXISTS (SELECT 1 FROM trust.review_responses x WHERE x.review_id = trust.reviews.id AND x.status = 'published' AND x.deleted_at IS NULL)`;
          s = s.where(q.has_response ? exists : sql<boolean>`NOT ${exists}`);
        }
        if (after) s = s.where('id', '<', after);
        const rows = await s
          .orderBy('id', 'desc')
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
@Operation('reviews.org_get')
export class ReviewsOrgGetHandler implements OperationHandler {
  constructor(private readonly views: OrgReviewViews) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const m = member(ctx);
    const body = await ctx.tx(
      async (scope) => {
        const r = await loadSubjectReview(scope, m.orgId, ctx.params.review_id!);
        if (!r.published_at) throw new ApiError('NOT_FOUND');
        return (await this.views.many(scope, [r], ctx.locale))[0]!;
      },
      { readOnly: true },
    );
    return { body };
  }
}

async function loadResponse(scope: TxScope, orgId: string, reviewId: string, id: string): Promise<ResponseRow> {
  const r = await scope.db
    .selectFrom('trust.review_responses')
    .selectAll()
    .where('id', '=', id)
    .where('review_id', '=', reviewId)
    .where('organization_id', '=', orgId)
    .where('status', 'in', ['draft', 'published'])
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  if (!r) throw new ApiError('NOT_FOUND');
  return r;
}

@Injectable()
@Operation('review_responses.create')
export class ReviewResponsesCreateHandler implements OperationHandler {
  constructor(private readonly views: ReviewViews) {}

  async handle(ctx: OperationContext<{ response_text: string; content_locale: string; ai_draft_insight_id?: string }>) {
    const m = member(ctx);
    // AI response drafts arrive with the ai-mcp module (S9): no insight can be referenced yet.
    if (ctx.body.ai_draft_insight_id) throw notFoundAt('/ai_draft_insight_id');
    const body = await ctx.tx(async (scope) => {
      const review = await loadSubjectReview(scope, m.orgId, ctx.params.review_id!);
      if (review.status !== 'published') throw new ApiError('INVALID_TRANSITION', { detail: review.status });
      const row = await scope.db
        .insertInto('trust.review_responses')
        .values({
          review_id: review.id,
          organization_id: m.orgId,
          response_text: ctx.body.response_text,
          content_locale: ctx.body.content_locale,
          responded_by_user_id: m.userId,
          status: 'draft',
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return (await this.views.responses(scope, [row], ctx.locale)).get(row.id)!;
    });
    return created(body, `/v1/orgs/${m.orgId}/reviews/${ctx.params.review_id}/responses/${body.id}`) satisfies OperationResult;
  }
}

@Injectable()
@Operation('review_responses.update')
export class ReviewResponsesUpdateHandler implements OperationHandler {
  constructor(private readonly views: ReviewViews) {}

  async handle(ctx: OperationContext<{ response_text?: string; content_locale?: string }>): Promise<OperationResult> {
    const m = member(ctx);
    const body = await ctx.tx(async (scope) => {
      await loadSubjectReview(scope, m.orgId, ctx.params.review_id!);
      const r = await loadResponse(scope, m.orgId, ctx.params.review_id!, ctx.params.response_id!);
      if (ctx.ifMatch !== r.version) throw new ApiError('VERSION_MISMATCH');
      const row = await scope.db
        .updateTable('trust.review_responses')
        .set({
          ...(ctx.body.response_text !== undefined ? { response_text: ctx.body.response_text } : {}),
          ...(ctx.body.content_locale !== undefined ? { content_locale: ctx.body.content_locale } : {}),
          ...(r.ai_assisted ? { edited_after_ai: true } : {}),
          responded_by_user_id: m.userId,
        })
        .where('id', '=', r.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return (await this.views.responses(scope, [row], ctx.locale)).get(row.id)!;
    });
    return { body };
  }
}

@Injectable()
@Operation('review_responses.publish')
export class ReviewResponsesPublishHandler implements OperationHandler {
  constructor(private readonly views: ReviewViews) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const m = member(ctx);
    const body = await ctx.tx(async (scope) => {
      const review = await loadSubjectReview(scope, m.orgId, ctx.params.review_id!, true);
      if (review.status !== 'published') throw new ApiError('INVALID_TRANSITION', { detail: review.status });
      const r = await loadResponse(scope, m.orgId, review.id, ctx.params.response_id!);
      if (r.status !== 'draft') throw new ApiError('INVALID_TRANSITION', { detail: r.status });
      // At most one published response: the earlier one is replaced (kept as removed).
      await scope.db
        .updateTable('trust.review_responses')
        .set({ status: 'removed' })
        .where('review_id', '=', review.id)
        .where('status', '=', 'published')
        .execute();
      const row = await scope.db
        .updateTable('trust.review_responses')
        .set({ status: 'published', published_at: sql`now()` })
        .where('id', '=', r.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeAudit(scope, { action: 'review.response_published', entityType: 'review_response', entityId: row.id, next: 'published' });
      await publishEvent(scope, {
        type: 'review.response.published',
        aggregateType: 'review',
        aggregateId: review.id,
        payload: { organization_id: m.orgId, subject_organization_id: m.orgId, author_user_id: review.author_user_id, response_id: row.id },
      });
      return (await this.views.responses(scope, [row], ctx.locale)).get(row.id)!;
    });
    return { body };
  }
}

@Injectable()
@Operation('review_responses.delete')
export class ReviewResponsesDeleteHandler implements OperationHandler {
  async handle(ctx: OperationContext): Promise<OperationResult> {
    const m = member(ctx);
    await ctx.tx(async (scope) => {
      await loadSubjectReview(scope, m.orgId, ctx.params.review_id!);
      const r = await loadResponse(scope, m.orgId, ctx.params.review_id!, ctx.params.response_id!);
      await scope.db.updateTable('trust.review_responses').set({ status: 'removed' }).where('id', '=', r.id).execute();
      await writeAudit(scope, {
        action: 'review.response_removed',
        entityType: 'review_response',
        entityId: r.id,
        previous: r.status,
        next: 'removed',
      });
      if (r.status === 'published')
        await publishEvent(scope, {
          type: 'review.response.removed',
          aggregateType: 'review',
          aggregateId: r.review_id,
          payload: { organization_id: m.orgId, response_id: r.id },
        });
    });
    return { body: ACK };
  }
}

@Injectable()
@Operation('review_approvals.list')
export class ReviewApprovalsListHandler implements OperationHandler {
  constructor(
    private readonly users: UserCards,
    private readonly appointments: AppointmentFacts,
    private readonly vehicles: VehicleCards,
    private readonly taxonomy: TaxonomyResolver,
  ) {}

  async handle(ctx: OperationContext<undefined, { limit: number }>): Promise<OperationResult> {
    const m = member(ctx);
    const after = afterId(ctx);
    const body = await ctx.tx(
      async (scope) => {
        let q = scope.db
          .selectFrom('trust.reviews')
          // The relationship question only: rating and text are deliberately not read (MVP Module F).
          .select([
            'id',
            'author_user_id',
            'created_at',
            'business_confirmation_due_at',
            'context_appointment_id',
            'context_vehicle_id',
            'service_system_node_id',
            'service_task_node_id',
            'service_date',
            'subject_location_id',
          ])
          .where('subject_organization_id', '=', m.orgId)
          .where('status', '=', 'pending_approval')
          .where('business_confirmation_status', '=', 'pending')
          .where('business_confirmation_due_at', '>', sql<Date>`now()`)
          .where('deleted_at', 'is', null);
        if (after) q = q.where('id', '>', after);
        const rows = await q
          .orderBy('id')
          .limit(ctx.query.limit + 1)
          .execute();
        const page = rows.slice(0, ctx.query.limit);
        const users = await this.users.cards(
          scope,
          page.map((r) => r.author_user_id),
        );
        const items = [];
        for (const r of page)
          items.push({
            review_id: r.id,
            submitted_at: new Date(r.created_at).toISOString(),
            due_at: new Date(r.business_confirmation_due_at!).toISOString(),
            author_display_name: authorDisplayName(users.get(r.author_user_id), ctx.locale),
            visit_context: await visitContext(
              scope,
              r.context_appointment_id,
              ctx.locale,
              this.appointments,
              this.vehicles,
              this.taxonomy,
              {
                system: r.service_system_node_id,
                task: r.service_task_node_id,
                date: r.service_date ? new Date(r.service_date).toISOString().slice(0, 10) : null,
                vehicleId: r.context_vehicle_id,
                locationId: r.subject_location_id,
              },
            ),
          });
        return ctx.page(items, rows.length > ctx.query.limit ? { id: page.at(-1)!.id } : null);
      },
      { readOnly: true },
    );
    return { body };
  }
}

const DEFAULT_OBJECTION: Record<string, string> = {
  en: 'The business does not recognise this customer.',
  fa: 'کسب‌وکار این مشتری را نمی‌شناسد.',
};

@Injectable()
@Operation('review_approvals.answer')
export class ReviewApprovalsAnswerHandler implements OperationHandler {
  async handle(ctx: OperationContext<{ answer: 'confirmed' | 'rejected'; note?: string }>): Promise<OperationResult> {
    const m = member(ctx);
    const b = ctx.body;
    await ctx.tx(async (scope) => {
      const r = await scope.db
        .selectFrom('trust.reviews')
        .select(['id', 'status', 'business_confirmation_status', 'business_confirmation_due_at', 'author_user_id'])
        .where('id', '=', ctx.params.review_id!)
        .where('subject_organization_id', '=', m.orgId)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!r || r.status !== 'pending_approval') throw new ApiError('NOT_FOUND');
      if (r.business_confirmation_status !== 'pending' || new Date(r.business_confirmation_due_at!).getTime() <= Date.now())
        throw new ApiError('INVALID_TRANSITION', { detail: 'already_answered_or_deadline_passed' });
      await scope.db
        .updateTable('trust.reviews')
        .set({
          business_confirmation_status: b.answer,
          business_confirmed_at: sql`now()`,
          business_confirmed_by_user_id: m.userId,
          business_confirmation_source: 'business_answer',
          business_confirmation_note: b.note ?? null,
        })
        .where('id', '=', r.id)
        .execute();
      // 54 §9.7: the business's answer is audited (the note stays with CarPal staff).
      await writeAudit(scope, { action: `review.approval_${b.answer}`, entityType: 'review', entityId: r.id, next: b.answer });
      await publishEvent(scope, {
        type: 'review.approval.answered',
        aggregateType: 'review',
        aggregateId: r.id,
        payload: { subject_organization_id: m.orgId, answer: b.answer },
      });
      if (b.answer === 'rejected') {
        // Never removes the review: a review_approval_objection dispute decided by a CarPal reviewer (52 Review rules).
        const reason = b.note && [...b.note].length >= 10 ? b.note : (DEFAULT_OBJECTION[ctx.locale] ?? DEFAULT_OBJECTION.en!);
        const d = await scope.db
          .insertInto('trust.disputes')
          .values({
            target_entity_type: 'review',
            target_entity_id: r.id,
            dispute_type: 'review_approval_objection',
            raised_by_user_id: m.userId,
            raised_by_organization_id: m.orgId,
            reason,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await publishEvent(scope, {
          type: 'review.approval.objected',
          aggregateType: 'review',
          aggregateId: r.id,
          payload: { subject_organization_id: m.orgId, dispute_id: d.id, author_user_id: r.author_user_id },
        });
      }
    });
    return { body: ACK };
  }
}

@Injectable()
@Operation('badges.list')
export class BadgesListHandler implements OperationHandler {
  async handle(ctx: OperationContext<undefined, { status?: string; limit: number }>): Promise<OperationResult> {
    const m = member(ctx);
    const after = afterId(ctx);
    const body = await ctx.tx(
      async (scope) => {
        let q = scope.db
          .selectFrom('trust.provider_badges')
          .selectAll()
          .where('provider_organization_id', '=', m.orgId)
          .where('deleted_at', 'is', null);
        if (ctx.query.status) q = q.where('status', '=', ctx.query.status);
        if (after) q = q.where('id', '<', after);
        const rows = await q
          .orderBy('id', 'desc')
          .limit(ctx.query.limit + 1)
          .execute();
        return pageOf(ctx, rows, rows.slice(0, ctx.query.limit).map(toBadge));
      },
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('trust_signals.list')
export class TrustSignalsListHandler implements OperationHandler {
  async handle(ctx: OperationContext<undefined, { signal_group?: string; limit: number }>): Promise<OperationResult> {
    const m = member(ctx);
    const after = afterId(ctx);
    const body = await ctx.tx(
      async (scope) => {
        // The latest value per signal type and scope; risk and authenticity signals never (RLS subject_read too).
        let q = scope.db
          .selectFrom('trust.trust_signals as s')
          .selectAll()
          .where('s.subject_type', '=', 'organization')
          .where('s.subject_id', '=', m.orgId)
          .where('s.signal_type', 'not in', ['risk_fraud_flag', 'review_authenticity_score'])
          .where('s.deleted_at', 'is', null)
          .where(
            sql<boolean>`s.calculated_at = (SELECT max(x.calculated_at) FROM trust.trust_signals x
              WHERE x.subject_type = s.subject_type AND x.subject_id = s.subject_id AND x.signal_type = s.signal_type
                AND x.scope_taxonomy_node_id IS NOT DISTINCT FROM s.scope_taxonomy_node_id AND x.deleted_at IS NULL)`,
          );
        if (ctx.query.signal_group) q = q.where('s.signal_group', '=', ctx.query.signal_group);
        if (after) q = q.where('s.id', '>', after);
        const rows = await q
          .orderBy('s.id')
          .limit(ctx.query.limit + 1)
          .execute();
        return pageOf(ctx, rows, rows.slice(0, ctx.query.limit).map(toSignal));
      },
      { readOnly: true },
    );
    return { body };
  }
}
