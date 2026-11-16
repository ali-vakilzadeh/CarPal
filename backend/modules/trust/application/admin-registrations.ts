// Trust's plug-ins for the admin plane (S8): the purpose queues it owns
// (dispute:<id>, approval:<review id>) with their subjects (S14), the four-eyes executor of
// admin.review_move_to_approval_path, its moderation targets (review,
// review_response, badge) and its part of data subject requests (authored
// reviews and raised disputes; erasure keeps reviews under "former member").
// S20 (BR-15): reduce_weight and edit_request on reviews; a review hidden by an
// edit request returns to the case queue once edited or after 7 days.
import { Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import { publishEvent } from '#libs/outbox/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import {
  excerpt,
  FourEyesExecutors,
  ModerationLog,
  ModerationTargets,
  PurposeQueues,
  type ContentAction,
  type SubjectRef,
  type TargetAction,
  type TargetActionInput,
  type TargetActionResult,
  WorkQueues,
} from '#modules/admin/interface/admin.js';
import { MetricGauges } from '#modules/analytics/interface/analytics.js';
import { AppointmentFacts } from '#modules/appointment/interface/appointments.js';
import { VehicleCards } from '#modules/vehicle/interface/vehicles.js';
import { PersonalDataRegistry } from '#modules/identity/interface/identity.js';
import { repointColumns, TaxonomyReferences } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { TrustAdmin } from '../interface/trust.js';
import { applyApprovedResolution, DISPUTE_RESOLVE_OP, moveToApprovalPath } from './admin-ops.js';
import { registerTrustWork } from './work-queues.js';
import { OrganizationReferences } from '#modules/organization/interface/org-references.js';
import { trustOrgReferences } from './org-references.js';

const reviewPayload = (r: { subject_organization_id: string; author_user_id: string }) => ({
  organization_id: r.subject_organization_id,
  subject_organization_id: r.subject_organization_id,
  author_user_id: r.author_user_id,
});

/** The review's open or edited edit request (S20), if any. */
export async function liveEditRequest(scope: TxScope, reviewId: string, lock = false) {
  const q = scope.db
    .selectFrom('trust.review_edit_requests')
    .selectAll()
    .where('review_id', '=', reviewId)
    .where('status', 'in', ['open', 'edited'])
    .where('deleted_at', 'is', null);
  return (lock ? q.forUpdate() : q).executeTakeFirst();
}

async function closeEditRequest(scope: TxScope, id: string): Promise<void> {
  await scope.db
    .updateTable('trust.review_edit_requests')
    .set({ status: 'closed', closed_at: sql<Date>`now()` })
    .where('id', '=', id)
    .execute();
}

/** Days an author has to change a review after an edit request (Docs/23 A-REV-02). */
const EDIT_REQUEST_DAYS = 7;

/**
 * Moderator actions on a review: approve a held Path 1 review (or a review whose edit request a moderator checked),
 * hide or remove, restore a removed one.
 */
async function applyToReview(scope: TxScope, id: string, action: ContentAction): Promise<boolean> {
  const r = await scope.db
    .selectFrom('trust.reviews')
    .selectAll()
    .where('id', '=', id)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  if (!r) return false;
  const edit = await liveEditRequest(scope, r.id, true);
  if (action === 'approve' && edit && r.status === 'pending_moderation' && edit.previous_status === 'published') {
    // S20: the edit was checked: the review is published again as it was (path, weight and verification unchanged).
    await scope.db
      .updateTable('trust.reviews')
      .set({ status: 'published', counts_toward_core_score: Number(r.trust_weight ?? 0) > 0 })
      .where('id', '=', r.id)
      .execute();
    await closeEditRequest(scope, edit.id);
    await publishEvent(scope, { type: 'review.published', aggregateType: 'review', aggregateId: r.id, payload: reviewPayload(r) });
    return true;
  }
  if (action === 'approve') {
    if (r.status !== 'pending_moderation' || r.confirmation_path !== 'visit_based') return false;
    if (edit) await closeEditRequest(scope, edit.id);
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
    if (edit) await closeEditRequest(scope, edit.id);
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

/** Characters of a review field (Postgres char_length counts code points); -1 when the field is empty. */
const chars = (t: string | null) => (t === null ? -1 : [...t].length);

/** reduce_weight and edit_request on a review (S20, BR-15). */
async function actOnReview(scope: TxScope, id: string, action: TargetAction, input: TargetActionInput): Promise<TargetActionResult> {
  const r = await scope.db
    .selectFrom('trust.reviews')
    .selectAll()
    .where('id', '=', id)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  if (!r) return { ok: false, transition: 'review gone' };
  const p = input.params;
  if (action === 'reduce_weight') {
    // The scorer counts the review at trust_weight x weight_factor from its next run (54 §3); 1 restores the full weight.
    if (p.weight_factor === undefined) return { ok: false, invalid: { pointer: '/params/weight_factor', code: 'conditional_required' } };
    const factor = Number(p.weight_factor);
    if (!(factor >= 0 && factor <= 1))
      return { ok: false, invalid: { pointer: '/params/weight_factor', code: 'out_of_range', limit: '1' } };
    if (['removed', 'rejected'].includes(r.status)) return { ok: false, transition: `review ${r.status}` };
    await scope.db
      .updateTable('trust.reviews')
      .set({ weight_factor: factor.toFixed(3) })
      .where('id', '=', r.id)
      .execute();
    return { ok: true, params: { weight_factor: factor.toFixed(3), previous_weight_factor: Number(r.weight_factor).toFixed(3) } };
  }
  if (action !== 'edit_request') return { ok: false, transition: `${action} does not apply to a review` };
  if (!p.edit_spans?.length) return { ok: false, invalid: { pointer: '/params/edit_spans', code: 'conditional_required' } };
  if (!p.edit_message) return { ok: false, invalid: { pointer: '/params/edit_message', code: 'conditional_required' } };
  if ([...p.edit_message.trim()].length < 3)
    return { ok: false, invalid: { pointer: '/params/edit_message', code: 'too_short', limit: '3' } };
  for (const [i, span] of p.edit_spans.entries()) {
    const len = chars(span.field === 'title' ? r.title : r.body);
    if (span.end <= span.start) return { ok: false, invalid: { pointer: `/params/edit_spans/${i}/end`, code: 'order' } };
    if (span.end > len) return { ok: false, invalid: { pointer: `/params/edit_spans/${i}/end`, code: 'out_of_range' } };
  }
  // A published review is hidden until a moderator checks the edit; one held for moderation stays held. Path 2 reviews
  // waiting for approval are handled by the reviewer (request_evidence, reject), not by an edit request.
  if (!['published', 'pending_moderation'].includes(r.status)) return { ok: false, transition: `review ${r.status}` };
  if (await liveEditRequest(scope, r.id)) return { ok: false, transition: 'edit request already open' };
  const dueAt = new Date(Date.now() + EDIT_REQUEST_DAYS * 86_400_000);
  const req = await scope.db
    .insertInto('trust.review_edit_requests')
    .values({
      review_id: r.id,
      moderation_case_id: input.caseId,
      requested_by: input.staffUserId,
      spans: JSON.stringify(p.edit_spans.map((x) => ({ field: x.field, start: x.start, end: x.end }))),
      message: p.edit_message,
      previous_status: r.status,
      due_at: dueAt,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  if (r.status === 'published') {
    await scope.db
      .updateTable('trust.reviews')
      .set({ status: 'pending_moderation', counts_toward_core_score: false })
      .where('id', '=', r.id)
      .execute();
    await publishEvent(scope, {
      type: 'review.removed',
      aggregateType: 'review',
      aggregateId: r.id,
      payload: { ...reviewPayload(r), reason: 'edit_requested' },
    });
  }
  return { ok: true, params: { edit_request_id: req.id, previous_status: r.status, due_at: dueAt.toISOString() } };
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
    @Optional() private readonly appointments?: AppointmentFacts,
    @Optional() private readonly vehicles?: VehicleCards,
    @Optional() private readonly moderation?: ModerationLog,
    @Optional() private readonly work?: WorkQueues,
    @Optional() private readonly orgRefs?: OrganizationReferences,
    @Optional() private readonly trustAdmin?: TrustAdmin,
  ) {}

  /** The parties of a dispute target, as disputes.create checks them (S14 purpose subjects). */
  async #targetParties(scope: TxScope, type: string, id: string): Promise<SubjectRef[]> {
    const out: SubjectRef[] = [];
    const user = (u: string | null | undefined) => u && out.push({ type: 'user', id: u });
    const org = (o: string | null | undefined) => o && out.push({ type: 'organization', id: o });
    if (type === 'review') {
      const r = await scope.db
        .selectFrom('trust.reviews')
        .select(['author_user_id', 'subject_organization_id'])
        .where('id', '=', id)
        .executeTakeFirst();
      user(r?.author_user_id);
      org(r?.subject_organization_id);
    } else if (type === 'badge') {
      const b = await scope.db
        .selectFrom('trust.provider_badges')
        .select('provider_organization_id')
        .where('id', '=', id)
        .executeTakeFirst();
      org(b?.provider_organization_id);
    } else if (type === 'appointment') {
      const a = (await this.appointments?.visits(scope, [id]))?.get(id);
      user(a?.requesterUserId);
      org(a?.requesterOrgId);
      org(a?.providerOrgId);
    } else if (type === 'service_record') {
      const p = await this.vehicles?.serviceRecordParties(scope, id);
      if (p) (p.ownerType === 'user' ? user : org)(p.ownerId);
      org(p?.providerOrgId);
    } else if (type === 'moderation_action') {
      const [affects, action] = await Promise.all([this.moderation?.affects(scope, id), this.moderation?.get(scope, id)]);
      user(affects?.userId);
      org(affects?.organizationId);
      if (action) out.push({ type: action.targetType, id: action.targetId });
    }
    return out;
  }

  onModuleInit(): void {
    // Backend S22 (BR-08): what an organization merge does to this module's references.
    this.orgRefs?.register('trust', trustOrgReferences());
    if (this.work) registerTrustWork(this.work);
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
    this.purposes?.register('dispute', {
      open: async (scope, staffUserId, id) => {
        const d = await scope.db
          .selectFrom('trust.disputes')
          .select(['status', 'assigned_to'])
          .where('id', '=', id)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        return !!d && ['open', 'in_mediation'].includes(d.status) && (d.assigned_to === null || d.assigned_to === staffUserId);
      },
      // S14 (BR-09): the raiser, the raising organization, the target and the target's parties.
      subjects: async (scope, id) => {
        const d = await scope.db
          .selectFrom('trust.disputes')
          .select(['raised_by_user_id', 'raised_by_organization_id', 'target_entity_type', 'target_entity_id'])
          .where('id', '=', id)
          .executeTakeFirst();
        if (!d) return [];
        // S20: the messages of the dispute (their evidence files are attached to them).
        const messages = await scope.db.selectFrom('trust.dispute_messages').select('id').where('dispute_id', '=', id).limit(400).execute();
        const out: SubjectRef[] = [
          { type: 'user', id: d.raised_by_user_id },
          ...(d.raised_by_organization_id ? [{ type: 'organization', id: d.raised_by_organization_id }] : []),
          { type: d.target_entity_type, id: d.target_entity_id },
          ...messages.map((m) => ({ type: 'dispute_message', id: m.id })),
        ];
        return [...out, ...(await this.#targetParties(scope, d.target_entity_type, d.target_entity_id))];
      },
    });
    // approval:<review id>: the review, its author and the reviewed organization.
    this.purposes?.register('approval', {
      open: async (scope, _staffUserId, id) => {
        const r = await scope.db
          .selectFrom('trust.reviews')
          .select(['status', 'confirmation_path'])
          .where('id', '=', id)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        return !!r && r.confirmation_path === 'approval_based' && r.status === 'pending_approval';
      },
      subjects: async (scope, id) => {
        const r = await scope.db
          .selectFrom('trust.reviews')
          .select(['author_user_id', 'subject_organization_id'])
          .where('id', '=', id)
          .executeTakeFirst();
        return r
          ? [
              { type: 'review', id },
              { type: 'user', id: r.author_user_id },
              { type: 'organization', id: r.subject_organization_id },
            ]
          : [];
      },
    });
    this.executors?.register('admin.review_move_to_approval_path', async (scope, c) => moveToApprovalPath(scope, c.targetId, c.reason));
    // S25a.T5 (DQ-22): an upheld dispute that removes something waits for a different administrator's approval.
    if (this.executors && this.moderation && this.targets && this.trustAdmin) {
      const deps = { log: this.moderation, targets: this.targets, trust: this.trustAdmin };
      this.executors.register(DISPUTE_RESOLVE_OP, async (scope, c) => applyApprovedResolution(scope, deps, c));
    }

    this.targets?.register('review', {
      exists: async (scope, id) =>
        !!(await scope.db.selectFrom('trust.reviews').select('id').where('id', '=', id).where('deleted_at', 'is', null).executeTakeFirst()),
      snapshot: async (scope, id) => {
        const r = await scope.db.selectFrom('trust.reviews').selectAll().where('id', '=', id).executeTakeFirst();
        return r
          ? {
              type: 'review',
              id: r.id,
              available: true,
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
      // S18 (BR-27): the title or the start of the text, and the rating.
      summaries: async (scope, ids) => {
        const rows = ids.length
          ? await scope.db
              .selectFrom('trust.reviews')
              .select(['id', 'title', 'body', 'overall_rating'])
              .where('id', 'in', [...ids])
              .where('deleted_at', 'is', null)
              .execute()
          : [];
        return new Map(rows.map((r) => [r.id, { excerpt: excerpt(r.title ?? r.body), rating: Number(r.overall_rating) }]));
      },
      // S18 (BR-33): reviews are written by members; the author's reviews published, and removed or rejected.
      authorOf: async (scope, id) => {
        const r = await scope.db.selectFrom('trust.reviews').select('author_user_id').where('id', '=', id).executeTakeFirst();
        if (!r) return null;
        const h = await scope.db
          .selectFrom('trust.reviews')
          .select([
            sql<string>`count(*) FILTER (WHERE status = 'published')`.as('published'),
            sql<string>`count(*) FILTER (WHERE status IN ('removed','rejected'))`.as('removed'),
          ])
          .where('author_user_id', '=', r.author_user_id)
          .where('deleted_at', 'is', null)
          .executeTakeFirstOrThrow();
        return { userId: r.author_user_id, organizationId: null, published: Number(h.published), removed: Number(h.removed) };
      },
      subjectOrganization: async (scope, id) =>
        (await scope.db.selectFrom('trust.reviews').select('subject_organization_id').where('id', '=', id).executeTakeFirst())
          ?.subject_organization_id ?? null,
      author: async (scope, id) =>
        (await scope.db.selectFrom('trust.reviews').select('author_user_id').where('id', '=', id).executeTakeFirst())?.author_user_id ??
        null,
      apply: applyToReview,
      act: actOnReview,
      // Path 1 reviews W4 held back (links, contact data): a moderator approves or removes them. S20: a review hidden by
      // an edit request waits for the author until it is edited or the 7 days have passed, then comes back to a moderator.
      pending: async (scope, limit) =>
        (
          await scope.db
            .selectFrom('trust.reviews')
            .select('id')
            .where('status', '=', 'pending_moderation')
            .where(
              sql<boolean>`((confirmation_path = 'visit_based' AND created_at < ${new Date(Date.now() - 60_000)}
                 AND NOT EXISTS (SELECT 1 FROM trust.review_edit_requests e
                   WHERE e.review_id = trust.reviews.id AND e.status IN ('open','edited') AND e.deleted_at IS NULL))
               OR EXISTS (SELECT 1 FROM trust.review_edit_requests e WHERE e.review_id = trust.reviews.id
                 AND e.deleted_at IS NULL AND (e.status = 'edited' OR (e.status = 'open' AND e.due_at < now()))))`,
            )
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
              available: true,
              review_id: r.review_id,
              organization_id: r.organization_id,
              response_text: r.response_text,
              status: r.status,
              created_at: r.created_at.toISOString(),
            }
          : null;
      },
      summaries: async (scope, ids) => {
        const rows = ids.length
          ? await scope.db
              .selectFrom('trust.review_responses')
              .select(['id', 'response_text'])
              .where('id', 'in', [...ids])
              .where('deleted_at', 'is', null)
              .execute()
          : [];
        return new Map(rows.map((r) => [r.id, { excerpt: excerpt(r.response_text), rating: null }]));
      },
      // S18 (BR-33): the member who answered for the business; their answers published, and removed.
      authorOf: async (scope, id) => {
        const r = await scope.db
          .selectFrom('trust.review_responses')
          .select(['responded_by_user_id', 'organization_id'])
          .where('id', '=', id)
          .executeTakeFirst();
        if (!r) return null;
        const h = await scope.db
          .selectFrom('trust.review_responses')
          .select([
            sql<string>`count(*) FILTER (WHERE status = 'published')`.as('published'),
            sql<string>`count(*) FILTER (WHERE status = 'removed')`.as('removed'),
          ])
          .where('responded_by_user_id', '=', r.responded_by_user_id)
          .where('deleted_at', 'is', null)
          .executeTakeFirstOrThrow();
        return {
          userId: r.responded_by_user_id,
          organizationId: r.organization_id,
          published: Number(h.published),
          removed: Number(h.removed),
        };
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
              available: true,
              provider_organization_id: b.provider_organization_id,
              badge_type: b.badge_type,
              status: b.status,
              rule_key: b.rule_key,
              rule_version: b.rule_version,
            }
          : null;
      },
      summaries: async (scope, ids) => {
        const rows = ids.length
          ? await scope.db
              .selectFrom('trust.provider_badges')
              .select(['id', 'badge_type'])
              .where('id', 'in', [...ids])
              .where('deleted_at', 'is', null)
              .execute()
          : [];
        return new Map(rows.map((r) => [r.id, { excerpt: r.badge_type, rating: null }]));
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
