// Trust's plug-ins for the admin plane (S8): the purpose queues it owns
// (dispute:<id>, approval:<review id>), the four-eyes executor of
// admin.review_move_to_approval_path, its moderation targets (review,
// review_response, badge) and its part of data subject requests (authored
// reviews and raised disputes; erasure keeps reviews under "former member").
import { Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import { publishEvent } from '#libs/outbox/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { FourEyesExecutors, ModerationTargets, PurposeQueues, type ContentAction } from '#modules/admin/interface/admin.js';
import { MetricGauges } from '#modules/analytics/interface/analytics.js';
import { PersonalDataRegistry } from '#modules/identity/interface/identity.js';
import { repointColumns, TaxonomyReferences } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { moveToApprovalPath } from './admin-ops.js';

const reviewPayload = (r: { subject_organization_id: string; author_user_id: string }) => ({
  organization_id: r.subject_organization_id,
  subject_organization_id: r.subject_organization_id,
  author_user_id: r.author_user_id,
});

/** Moderator actions on a review: approve a held Path 1 review, hide or remove, restore a removed one. */
async function applyToReview(scope: TxScope, id: string, action: ContentAction): Promise<boolean> {
  const r = await scope.db
    .selectFrom('trust.reviews')
    .selectAll()
    .where('id', '=', id)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  if (!r) return false;
  if (action === 'approve') {
    if (r.status !== 'pending_moderation' || r.confirmation_path !== 'visit_based') return false;
    await scope.db
      .updateTable('trust.reviews')
      .set({ status: 'published', published_at: sql<Date>`now()`, trust_weight: '1.000', counts_toward_core_score: true })
      .where('id', '=', r.id)
      .execute();
    await publishEvent(scope, { type: 'review.published', aggregateType: 'review', aggregateId: r.id, payload: reviewPayload(r) });
    return true;
  }
  if (action === 'hide' || action === 'remove') {
    if (r.status === 'removed' || r.status === 'rejected') return false;
    await scope.db
      .updateTable('trust.reviews')
      .set({ status: 'removed', counts_toward_core_score: false, report_status: r.report_status === 'none' ? 'none' : 'resolved' })
      .where('id', '=', r.id)
      .execute();
    await publishEvent(scope, {
      type: 'review.removed',
      aggregateType: 'review',
      aggregateId: r.id,
      payload: { ...reviewPayload(r), reason: 'moderation' },
    });
    return true;
  }
  if (action === 'restore') {
    if (r.status !== 'removed') return false;
    const republish =
      r.published_at !== null && r.confirmation_path !== null && !['pending_approval', 'rejected'].includes(r.verified_status);
    await scope.db
      .updateTable('trust.reviews')
      .set(
        republish ? { status: 'published', counts_toward_core_score: Number(r.trust_weight ?? 0) > 0 } : { status: 'pending_moderation' },
      )
      .where('id', '=', r.id)
      .execute();
    if (republish)
      await publishEvent(scope, { type: 'review.published', aggregateType: 'review', aggregateId: r.id, payload: reviewPayload(r) });
    return true;
  }
  return false;
}

async function applyToResponse(scope: TxScope, id: string, action: ContentAction): Promise<boolean> {
  const r = await scope.db
    .selectFrom('trust.review_responses')
    .selectAll()
    .where('id', '=', id)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  if (!r) return false;
  if ((action === 'hide' || action === 'remove') && r.status !== 'removed') {
    await scope.db.updateTable('trust.review_responses').set({ status: 'removed' }).where('id', '=', r.id).execute();
    await publishEvent(scope, {
      type: 'review.response.removed',
      aggregateType: 'review_response',
      aggregateId: r.id,
      payload: { review_id: r.review_id, organization_id: r.organization_id },
    });
    return true;
  }
  if (action === 'restore' && r.status === 'removed' && r.published_at) {
    const other = await scope.db
      .selectFrom('trust.review_responses')
      .select('id')
      .where('review_id', '=', r.review_id)
      .where('status', '=', 'published')
      .executeTakeFirst();
    if (other) return false;
    await scope.db.updateTable('trust.review_responses').set({ status: 'published' }).where('id', '=', r.id).execute();
    return true;
  }
  return false;
}

@Injectable()
export class TrustAdminRegistrations implements OnModuleInit {
  constructor(
    @Optional() private readonly purposes?: PurposeQueues,
    @Optional() private readonly executors?: FourEyesExecutors,
    @Optional() private readonly targets?: ModerationTargets,
    @Optional() private readonly personal?: PersonalDataRegistry,
    @Optional() private readonly taxonomyRefs?: TaxonomyReferences,
    @Optional() private readonly gauges?: MetricGauges,
  ) {}

  onModuleInit(): void {
    this.gauges?.register('gauge.review_approvals_pending', async (scope) =>
      Number(
        (
          await sql<{
            n: string;
          }>`SELECT count(*) AS n FROM trust.reviews WHERE status = 'pending_approval' AND deleted_at IS NULL`.execute(scope.db)
        ).rows[0]!.n,
      ),
    );
    // admin.taxonomy_merge: review categories follow a merged node (review tags are unique per review: duplicates stay).
    this.taxonomyRefs?.register('trust', (scope, from, into) =>
      repointColumns(
        scope,
        [
          ['trust.reviews', 'service_system_node_id'],
          ['trust.reviews', 'service_task_node_id'],
        ],
        from,
        into,
      ),
    );
    this.purposes?.register('dispute', async (scope, staffUserId, id) => {
      const d = await scope.db
        .selectFrom('trust.disputes')
        .select(['status', 'assigned_to'])
        .where('id', '=', id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      return !!d && ['open', 'in_mediation'].includes(d.status) && (d.assigned_to === null || d.assigned_to === staffUserId);
    });
    this.purposes?.register('approval', async (scope, _staffUserId, id) => {
      const r = await scope.db
        .selectFrom('trust.reviews')
        .select(['status', 'confirmation_path'])
        .where('id', '=', id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      return !!r && r.confirmation_path === 'approval_based' && r.status === 'pending_approval';
    });
    this.executors?.register('admin.review_move_to_approval_path', async (scope, c) => moveToApprovalPath(scope, c.targetId, c.reason));

    this.targets?.register('review', {
      exists: async (scope, id) =>
        !!(await scope.db.selectFrom('trust.reviews').select('id').where('id', '=', id).where('deleted_at', 'is', null).executeTakeFirst()),
      snapshot: async (scope, id) => {
        const r = await scope.db.selectFrom('trust.reviews').selectAll().where('id', '=', id).executeTakeFirst();
        return r
          ? {
              type: 'review',
              id: r.id,
              subject_organization_id: r.subject_organization_id,
              subject_type: r.subject_type,
              overall_rating: Number(r.overall_rating),
              title: r.title,
              body: r.body,
              status: r.status,
              confirmation_path: r.confirmation_path,
              verified_status: r.verified_status,
              created_at: r.created_at.toISOString(),
            }
          : null;
      },
      subjectOrganization: async (scope, id) =>
        (await scope.db.selectFrom('trust.reviews').select('subject_organization_id').where('id', '=', id).executeTakeFirst())
          ?.subject_organization_id ?? null,
      author: async (scope, id) =>
        (await scope.db.selectFrom('trust.reviews').select('author_user_id').where('id', '=', id).executeTakeFirst())?.author_user_id ??
        null,
      apply: applyToReview,
      // Path 1 reviews W4 held back (links, contact data): a moderator approves or removes them.
      pending: async (scope, limit) =>
        (
          await scope.db
            .selectFrom('trust.reviews')
            .select('id')
            .where('status', '=', 'pending_moderation')
            .where('confirmation_path', '=', 'visit_based')
            .where('created_at', '<', new Date(Date.now() - 60_000))
            .where('deleted_at', 'is', null)
            .orderBy('id')
            .limit(limit)
            .execute()
        ).map((r) => r.id),
    });
    this.targets?.register('review_response', {
      exists: async (scope, id) =>
        !!(await scope.db
          .selectFrom('trust.review_responses')
          .select('id')
          .where('id', '=', id)
          .where('deleted_at', 'is', null)
          .executeTakeFirst()),
      snapshot: async (scope, id) => {
        const r = await scope.db.selectFrom('trust.review_responses').selectAll().where('id', '=', id).executeTakeFirst();
        return r
          ? {
              type: 'review_response',
              id: r.id,
              review_id: r.review_id,
              organization_id: r.organization_id,
              response_text: r.response_text,
              status: r.status,
            }
          : null;
      },
      subjectOrganization: async (scope, id) =>
        (await scope.db.selectFrom('trust.review_responses').select('organization_id').where('id', '=', id).executeTakeFirst())
          ?.organization_id ?? null,
      author: async (scope, id) =>
        (await scope.db.selectFrom('trust.review_responses').select('responded_by_user_id').where('id', '=', id).executeTakeFirst())
          ?.responded_by_user_id ?? null,
      apply: applyToResponse,
    });
    this.targets?.register('badge', {
      exists: async (scope, id) =>
        !!(await scope.db
          .selectFrom('trust.provider_badges')
          .select('id')
          .where('id', '=', id)
          .where('deleted_at', 'is', null)
          .executeTakeFirst()),
      snapshot: async (scope, id) => {
        const b = await scope.db.selectFrom('trust.provider_badges').selectAll().where('id', '=', id).executeTakeFirst();
        return b
          ? {
              type: 'badge',
              id: b.id,
              provider_organization_id: b.provider_organization_id,
              badge_type: b.badge_type,
              status: b.status,
              rule_key: b.rule_key,
              rule_version: b.rule_version,
            }
          : null;
      },
      subjectOrganization: async (scope, id) =>
        (await scope.db.selectFrom('trust.provider_badges').select('provider_organization_id').where('id', '=', id).executeTakeFirst())
          ?.provider_organization_id ?? null,
    });

    this.personal?.register('trust', {
      async export(scope, userId) {
        const [reviews, disputes] = await Promise.all([
          scope.db
            .selectFrom('trust.reviews')
            .select(['id', 'subject_organization_id', 'overall_rating', 'title', 'body', 'status', 'created_at', 'published_at'])
            .where('author_user_id', '=', userId)
            .execute(),
          scope.db
            .selectFrom('trust.disputes')
            .select(['id', 'dispute_type', 'target_entity_type', 'status', 'reason', 'created_at'])
            .where('raised_by_user_id', '=', userId)
            .execute(),
        ]);
        return [
          {
            section: 'reviews',
            records: reviews.map((r) => ({
              id: r.id,
              fields: {
                subject_organization_id: r.subject_organization_id,
                overall_rating: Number(r.overall_rating),
                title: r.title,
                body: r.body,
                status: r.status,
                created_at: r.created_at.toISOString(),
                published_at: r.published_at ? r.published_at.toISOString() : null,
              },
            })),
          },
          {
            section: 'disputes',
            records: disputes.map((d) => ({
              id: d.id,
              fields: {
                dispute_type: d.dispute_type,
                target_type: d.target_entity_type,
                status: d.status,
                reason: d.reason,
                created_at: d.created_at.toISOString(),
              },
            })),
          },
        ];
      },
      // Published reviews stay (52 §11: kept for the business and other users); the author is shown as a former member.
      // Unpublished drafts and pending reviews of the user are removed.
      async erase(scope, userId) {
        const r = await sql`UPDATE trust.reviews SET status = 'removed', counts_toward_core_score = false,
                                   deletion_reason = 'data subject request'
                             WHERE author_user_id = ${userId}::uuid AND status IN ('draft','pending_moderation','pending_approval')`.execute(
          scope.db,
        );
        return Number(r.numAffectedRows ?? 0);
      },
    });
  }
}
