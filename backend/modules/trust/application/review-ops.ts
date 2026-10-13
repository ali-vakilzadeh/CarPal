// Author operations (40 §15.2) and the path decision (52 §11 Review rules,
// §21 review trust rules; 54 §1.2). The server chooses the path from the
// evidence: Path 1 (visit-based) for a visit of the author that took place —
// a confirmed appointment 24 h past its time or completed (inside the 7-day
// invitation window), a completed stock inquiry, a verified service record —
// published by W4 after the automatic checks; otherwise Path 2
// (approval-based, pending_approval) which needs the business's confirmation
// (or 7 days without an answer) and a CarPal reviewer (S8). A business-sent
// invitation for a job without an appointment is Path 2 with the business
// confirmation already given. Members of the subject cannot review it.
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { writeAudit } from '#libs/audit/index.js';
import { MembershipDirectory } from '#libs/authz/index.js';
import { ApiError, type FieldError } from '#libs/contract/index.js';
import { uuidv7 } from '#libs/crypto/index.js';
import { registerConstraintErrors } from '#libs/db/index.js';
import { ACK, created, Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import type { Infra } from '#libs/infra/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import { InjectInfra } from '#libs/runtime/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { AppointmentFacts, type AppointmentVisit } from '#modules/appointment/interface/appointments.js';
import { AccountFacts } from '#modules/identity/interface/identity.js';
import { InventoryRead } from '#modules/inventory/interface/inventory.js';
import { MediaService } from '#modules/media/interface/media.js';
import { PublicProfiles } from '#modules/organization/interface/public-profiles.js';
import { REVIEW_WINDOW_MS } from '../interface/trust.js';
import { VehicleCards } from '#modules/vehicle/interface/vehicles.js';
import type { RequestRow, ReviewRow } from '../api/projections.js';
import { BUSINESS_CONFIRMATION_MS, dimensionAllowed, MAX_REVIEWS_PER_DAY } from '../domain/reviews.js';
import { afterId, failIf, notFoundAt, pageOf, ReviewViews, signedIn } from './common.js';

registerConstraintErrors({
  // 52 Review: one review per user per appointment, service record or inquiry (40 reviews.create 409 DUPLICATE(context)).
  reviews_appointment_uq: { code: 'DUPLICATE', pointer: '/context_appointment_id', fieldCode: 'not_unique' },
  reviews_record_uq: { code: 'DUPLICATE', pointer: '/context_service_record_id', fieldCode: 'not_unique' },
  reviews_inquiry_uq: { code: 'DUPLICATE', pointer: '/context_stock_inquiry_id', fieldCode: 'not_unique' },
});

const DAY = 86_400_000;
const PATH1_DELAY_MS = DAY;
const CAPACITY = ['confirmed', 'checked_in', 'in_progress', 'awaiting_parts', 'ready_for_pickup'];

/** 52 §21: the appointment took place (completed, or confirmed and 24 h past the scheduled time). */
export function tookPlace(a: AppointmentVisit, now: number): Date | null {
  if (a.status === 'completed') return a.completedAt ?? a.confirmedStartAt;
  if (CAPACITY.includes(a.status) && a.confirmedStartAt && a.confirmedStartAt.getTime() + PATH1_DELAY_MS <= now)
    return new Date(a.confirmedStartAt.getTime() + PATH1_DELAY_MS);
  return null;
}

export interface Candidate {
  type: 'appointment' | 'stock_inquiry' | 'service_record';
  id: string;
  date: Date;
  withinWindow: boolean;
  verifiedStatus: 'appointment_verified' | 'inquiry_verified' | 'service_record_verified';
  vehicleId: string | null;
  serviceSystemNodeId: string | null;
  serviceTaskNodeId: string | null;
  locationId: string | null;
}

/** Review visits of the signed-in user at one organization, and the invitations that frame their windows. */
@Injectable()
export class ReviewPaths {
  constructor(
    private readonly appointments: AppointmentFacts,
    private readonly inventory: InventoryRead,
    private readonly vehicles: VehicleCards,
  ) {}

  /** Open invitations of the user for the subject (RLS invitee_all). */
  invitations(scope: TxScope, userId: string, subjectOrgId: string): Promise<RequestRow[]> {
    return scope.db
      .selectFrom('trust.review_requests')
      .selectAll()
      .where('invited_user_id', '=', userId)
      .where('subject_organization_id', '=', subjectOrgId)
      .where('status', 'in', ['sent', 'opened', 'reminded'])
      .where('expires_at', '>', sql<Date>`now()`)
      .where('deleted_at', 'is', null)
      .execute();
  }

  async candidates(scope: TxScope, userId: string, subjectOrgId: string, now: number): Promise<Candidate[]> {
    const [appointments, inquiries, records, invitations] = await Promise.all([
      this.appointments.mine(scope, userId, subjectOrgId),
      this.inventory.inquiryVisits(scope, { vendorOrgId: subjectOrgId, requesterUserId: userId, limit: 50 }),
      this.vehicles.serviceVisits(scope, subjectOrgId),
      scope.db
        .selectFrom('trust.review_requests')
        .select(['appointment_id', 'expires_at'])
        .where('invited_user_id', '=', userId)
        .where('subject_organization_id', '=', subjectOrgId)
        .where('appointment_id', 'is not', null)
        .where('status', 'in', ['sent', 'opened', 'reminded'])
        .where('deleted_at', 'is', null)
        .execute(),
    ]);
    const out: Candidate[] = [];
    for (const a of appointments) {
      const at = tookPlace(a, now);
      if (!at) continue;
      const inv = invitations.find((i) => i.appointment_id === a.id);
      const end = inv?.expires_at ? new Date(inv.expires_at).getTime() : at.getTime() + REVIEW_WINDOW_MS;
      out.push({
        type: 'appointment',
        id: a.id,
        date: a.confirmedStartAt ?? at,
        withinWindow: now <= end,
        verifiedStatus: 'appointment_verified',
        vehicleId: a.vehicleId,
        serviceSystemNodeId: a.serviceSystemNodeId,
        serviceTaskNodeId: a.serviceTaskNodeId,
        locationId: a.providerLocationId,
      });
    }
    for (const q of inquiries)
      if (q.status === 'completed' && q.requesterType === 'user' && q.completedAt)
        out.push({
          type: 'stock_inquiry',
          id: q.id,
          date: q.completedAt,
          withinWindow: true,
          verifiedStatus: 'inquiry_verified',
          vehicleId: null,
          serviceSystemNodeId: null,
          serviceTaskNodeId: null,
          locationId: null,
        });
    // An appointment's own service record is the same job: the appointment frames the review (54 §1.1).
    const appointmentIds = new Set(appointments.map((a) => a.id));
    for (const r of records)
      if (!r.appointmentId || !appointmentIds.has(r.appointmentId))
        out.push({
          type: 'service_record',
          id: r.id,
          date: new Date(`${r.serviceDate}T00:00:00Z`),
          withinWindow: true,
          verifiedStatus: 'service_record_verified',
          vehicleId: r.vehicleId,
          serviceSystemNodeId: r.serviceSystemNodeId,
          serviceTaskNodeId: r.serviceTaskNodeId,
          locationId: null,
        });
    // Contexts the user already reviewed are not candidates (52: one review per context).
    const reviewed = await scope.db
      .selectFrom('trust.reviews')
      .select(['context_appointment_id', 'context_stock_inquiry_id', 'context_service_record_id'])
      .where('author_user_id', '=', userId)
      .where('subject_organization_id', '=', subjectOrgId)
      .where('status', '<>', 'removed')
      .where('deleted_at', 'is', null)
      .execute();
    const done = new Set(reviewed.flatMap((r) => [r.context_appointment_id, r.context_stock_inquiry_id, r.context_service_record_id]));
    return out.filter((c) => !done.has(c.id)).slice(0, 20);
  }
}

/** Why the user may not review the subject at all, or null. */
async function blocker(
  scope: TxScope,
  x: { facts: AccountFacts; memberships: MembershipDirectory; profiles: PublicProfiles },
  userId: string,
  subjectOrgId: string,
  subjectType?: 'provider' | 'vendor',
): Promise<'member_of_subject' | 'velocity_limit' | 'unverified_contact' | 'subject_not_published' | null> {
  const card = (await x.profiles.cards(scope, [subjectOrgId])).get(subjectOrgId);
  if (!card || (subjectType && !card.roles.includes(subjectType))) return 'subject_not_published';
  if ((await x.memberships.memberships(userId, 'user')).some((m) => m.orgId === subjectOrgId)) return 'member_of_subject';
  if (!(await x.facts.hasVerifiedContact(scope, userId))) return 'unverified_contact';
  const recent = await scope.db
    .selectFrom('trust.reviews')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('author_user_id', '=', userId)
    .where('created_at', '>', new Date(Date.now() - DAY))
    .executeTakeFirstOrThrow();
  if (Number(recent.n) >= MAX_REVIEWS_PER_DAY) return 'velocity_limit';
  return null;
}

@Injectable()
@Operation('reviews.eligibility')
export class ReviewsEligibilityHandler implements OperationHandler {
  constructor(
    private readonly paths: ReviewPaths,
    private readonly facts: AccountFacts,
    private readonly memberships: MembershipDirectory,
    private readonly profiles: PublicProfiles,
  ) {}

  async handle(ctx: OperationContext<{ subject_organization_id: string }>): Promise<OperationResult> {
    const c = signedIn(ctx);
    const orgId = ctx.body.subject_organization_id;
    const body = await ctx.tx(
      async (scope) => {
        const reason = await blocker(scope, { facts: this.facts, memberships: this.memberships, profiles: this.profiles }, c.userId, orgId);
        const candidates = reason ? [] : await this.paths.candidates(scope, c.userId, orgId, Date.now());
        const path1 = candidates.some((x) => x.withinWindow);
        let allowed = !reason;
        let reasonCode: string | null = reason;
        if (allowed && candidates.length === 0) {
          // Without a visit the user may still write one Path 2 review of the subject.
          const open = await scope.db
            .selectFrom('trust.reviews')
            .select('id')
            .where('author_user_id', '=', c.userId)
            .where('subject_organization_id', '=', orgId)
            .where('context_appointment_id', 'is', null)
            .where('context_service_record_id', 'is', null)
            .where('context_stock_inquiry_id', 'is', null)
            .where('status', '<>', 'removed')
            .where('deleted_at', 'is', null)
            .executeTakeFirst();
          if (open) {
            allowed = false;
            reasonCode = 'already_reviewed';
          }
        }
        return {
          allowed,
          path: allowed ? (path1 ? 'visit_based' : 'approval_based') : null,
          reason_code: allowed ? 'ok' : reasonCode,
          candidate_visits: candidates.map((x) => ({
            type: x.type,
            id: x.id,
            date: x.date.toISOString().slice(0, 10),
            within_invitation_window: x.withinWindow,
          })),
        };
      },
      { readOnly: true },
    );
    return { body };
  }
}

type ReviewCreate = {
  subject_organization_id: string;
  subject_type: 'provider' | 'vendor';
  subject_location_id?: string;
  context_appointment_id?: string;
  context_service_record_id?: string;
  context_stock_inquiry_id?: string;
  context_vehicle_id?: string;
  invitation_grant?: string;
  service_system_node_id?: string;
  service_task_node_id?: string;
  service_date?: string;
  overall_rating: number;
  would_return?: boolean;
  title?: string;
  body: string;
  content_locale: string;
  sub_ratings?: { dimension: string; rating: number }[];
  tag_node_ids?: string[];
  media_ids?: string[];
};

function writeErrors(b: Partial<ReviewCreate>, subjectType: 'provider' | 'vendor'): FieldError[] {
  const errors: FieldError[] = [];
  if (b.body !== undefined && [...b.body.trim()].length < 10) errors.push({ pointer: '/body', code: 'too_short', limit: '10' });
  if (subjectType === 'vendor' && b.would_return !== undefined) errors.push({ pointer: '/would_return', code: 'conditional_forbidden' });
  (b.sub_ratings ?? []).forEach((s, i) => {
    if (!dimensionAllowed(subjectType, s.dimension)) errors.push({ pointer: `/sub_ratings/${i}/dimension`, code: 'enum' });
  });
  const dims = (b.sub_ratings ?? []).map((s) => s.dimension);
  if (new Set(dims).size !== dims.length) errors.push({ pointer: '/sub_ratings', code: 'not_unique' });
  if (b.service_date && b.service_date > new Date().toISOString().slice(0, 10))
    errors.push({ pointer: '/service_date', code: 'in_future' });
  return errors;
}

/** Sub-ratings and tags of a review as one set (replaced on edits). */
export async function writeDetails(
  scope: TxScope,
  reviewId: string,
  b: { sub_ratings?: ReviewCreate['sub_ratings']; tag_node_ids?: string[] },
) {
  if (b.sub_ratings) {
    await scope.db
      .updateTable('trust.review_sub_ratings')
      .set({ deleted_at: sql`now()` })
      .where('review_id', '=', reviewId)
      .where('deleted_at', 'is', null)
      .execute();
    for (const s of b.sub_ratings)
      await scope.db
        .insertInto('trust.review_sub_ratings')
        .values({ review_id: reviewId, dimension: s.dimension, rating: s.rating })
        .onConflict((oc) => oc.columns(['review_id', 'dimension']).doUpdateSet({ rating: s.rating, deleted_at: null }))
        .execute();
  }
  if (b.tag_node_ids) {
    await scope.db
      .updateTable('trust.review_tags')
      .set({ deleted_at: sql`now()` })
      .where('review_id', '=', reviewId)
      .where('deleted_at', 'is', null)
      .execute();
    for (const t of b.tag_node_ids)
      await scope.db
        .insertInto('trust.review_tags')
        .values({ review_id: reviewId, taxonomy_node_id: t, source: 'user_selected', confirmed_by_author: true })
        .onConflict((oc) => oc.columns(['review_id', 'taxonomy_node_id']).doUpdateSet({ deleted_at: null, confirmed_by_author: true }))
        .execute();
  }
}

/** A consumed invitation grant (40 review_invitations.verify → reviews.create). */
interface Grant {
  invitationId: string;
  userId: string;
}

@Injectable()
@Operation('reviews.create')
export class ReviewsCreateHandler implements OperationHandler {
  constructor(
    private readonly paths: ReviewPaths,
    private readonly facts: AccountFacts,
    private readonly memberships: MembershipDirectory,
    private readonly profiles: PublicProfiles,
    private readonly appointments: AppointmentFacts,
    private readonly media: MediaService,
    private readonly views: ReviewViews,
    @InjectInfra() private readonly infra: Infra,
  ) {}

  async handle(ctx: OperationContext<ReviewCreate>): Promise<OperationResult> {
    const c = signedIn(ctx);
    const b = ctx.body;
    failIf(writeErrors(b, b.subject_type));
    // The grant is single use: taken out of the store before anything else (40: consumed atomically).
    let grant: Grant | null = null;
    if (b.invitation_grant) {
      const key = `ri_grant:${b.invitation_grant}`;
      const raw = await this.infra.kv.get(key);
      // compareAndDelete: of two parallel requests with the same grant only one takes it.
      grant = raw && (await this.infra.kv.compareAndDelete(key, raw)) ? (JSON.parse(raw) as Grant) : null;
      if (!grant || grant.userId !== c.userId) throw new ApiError('LINK_EXPIRED', { detail: 'grant' });
    }
    const now = Date.now();
    const body = await ctx.tx(async (scope) => {
      const reason = await blocker(
        scope,
        { facts: this.facts, memberships: this.memberships, profiles: this.profiles },
        c.userId,
        b.subject_organization_id,
        b.subject_type,
      );
      if (reason === 'unverified_contact') throw new ApiError('VERIFIED_CONTACT_REQUIRED');
      if (reason) throw new ApiError('REVIEW_NOT_ALLOWED', { detail: reason });

      let invitation: RequestRow | undefined;
      if (grant) {
        invitation = await scope.db
          .selectFrom('trust.review_requests')
          .selectAll()
          .where('id', '=', grant.invitationId)
          .where('invited_user_id', '=', c.userId)
          .forUpdate()
          .executeTakeFirst();
        if (!invitation || invitation.subject_organization_id !== b.subject_organization_id)
          throw new ApiError('LINK_EXPIRED', { detail: 'grant' });
        if (invitation.token_used_at || invitation.status === 'converted') throw new ApiError('LINK_USED');
        if (!['sent', 'opened', 'reminded'].includes(invitation.status) || new Date(invitation.expires_at!).getTime() < now)
          throw new ApiError('LINK_EXPIRED');
      } else if (!b.context_appointment_id && !b.context_service_record_id && !b.context_stock_inquiry_id) {
        // An open in-app invitation of the business for a job without an appointment frames a Path 2 review (business_invited).
        invitation = (await this.paths.invitations(scope, c.userId, b.subject_organization_id)).find((i) => i.provider_job_log_id);
      }
      const ctxAppointment = invitation?.appointment_id ?? b.context_appointment_id ?? null;
      const ctxRecord = invitation?.service_record_id ?? b.context_service_record_id ?? null;
      const ctxInquiry = invitation?.stock_inquiry_id ?? b.context_stock_inquiry_id ?? null;

      // Path decision (52 §21).
      let verified: string | null = null;
      let vehicleId = b.context_vehicle_id ?? null;
      let system = b.service_system_node_id ?? null;
      let task = b.service_task_node_id ?? null;
      let serviceDate = b.service_date ?? null;
      let location = b.subject_location_id ?? null;
      if (ctxAppointment || ctxRecord || ctxInquiry) {
        const candidates = await this.paths.candidates(scope, c.userId, b.subject_organization_id, now);
        const id = ctxAppointment ?? ctxRecord ?? ctxInquiry;
        const pointer = ctxAppointment ? '/context_appointment_id' : ctxRecord ? '/context_service_record_id' : '/context_stock_inquiry_id';
        const candidate = candidates.find((x) => x.id === id);
        // 52: one review per user and visit context (40 reviews.create 409 DUPLICATE(context)).
        const already = await scope.db
          .selectFrom('trust.reviews')
          .select('id')
          .where('author_user_id', '=', c.userId)
          .where((eb) =>
            eb.or([
              eb('context_appointment_id', '=', id!),
              eb('context_service_record_id', '=', id!),
              eb('context_stock_inquiry_id', '=', id!),
            ]),
          )
          .where('status', '<>', 'removed')
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        if (already) throw ApiError.validation([{ pointer, code: 'not_unique' }], 'DUPLICATE');
        if (!candidate && !invitation) {
          // A visit of the user that did not take place yet, or one already reviewed, cannot frame a review.
          if (ctxAppointment && (await this.appointments.mine(scope, c.userId, b.subject_organization_id)).some((a) => a.id === id))
            throw new ApiError('REVIEW_NOT_ALLOWED', { detail: 'visit has not taken place' });
          throw notFoundAt(pointer);
        }
        if (candidate) {
          // The appointment is still attached as evidence when the 7-day window has passed (Path 2).
          if (candidate.withinWindow) verified = candidate.verifiedStatus;
          vehicleId ??= candidate.vehicleId;
          system ??= candidate.serviceSystemNodeId;
          task ??= candidate.serviceTaskNodeId;
          serviceDate ??= candidate.date.toISOString().slice(0, 10);
          location ??= candidate.locationId;
        }
      }
      if (b.subject_type === 'vendor' && verified === 'appointment_verified') verified = null;
      if (b.context_vehicle_id && b.context_vehicle_id !== vehicleId) {
        // Only the caller's own vehicle (taxonomy shown publicly, never the record).
        throw notFoundAt('/context_vehicle_id');
      }
      // 52: a business-sent invitation counts as the business's confirmation (job logs always; other visits when not Path 1).
      const path1 = verified !== null && !invitation?.provider_job_log_id;
      const businessInvited = !path1 && !!invitation && (invitation.business_confirmation_given || invitation.invited_by_user_id !== null);
      const id = uuidv7();
      const row = await scope.db
        .insertInto('trust.reviews')
        .values({
          id,
          author_user_id: c.userId,
          subject_organization_id: b.subject_organization_id,
          subject_type: b.subject_type,
          subject_location_id: location,
          context_vehicle_id: vehicleId,
          context_appointment_id: ctxAppointment,
          context_service_record_id: ctxRecord,
          context_stock_inquiry_id: ctxInquiry,
          service_system_node_id: system,
          service_task_node_id: task,
          service_date: serviceDate,
          overall_rating: b.overall_rating,
          would_return: b.subject_type === 'provider' ? (b.would_return ?? null) : null,
          title: b.title ?? null,
          body: b.body,
          content_locale: b.content_locale,
          confirmation_path: path1 ? 'visit_based' : 'approval_based',
          verified_status: path1 ? verified! : 'pending_approval',
          business_confirmation_status: path1 ? null : businessInvited ? 'confirmed' : 'pending',
          business_confirmation_due_at: path1 ? null : new Date(now + BUSINESS_CONFIRMATION_MS),
          business_confirmation_source: path1 ? null : businessInvited ? 'business_invited' : null,
          business_confirmed_at: businessInvited ? new Date(now) : null,
          reviewer_decision: path1 ? null : 'pending',
          trust_weight: '0',
          review_request_id: invitation?.id ?? null,
          status: path1 ? 'pending_moderation' : 'pending_approval',
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeDetails(scope, id, b);
      if (b.media_ids?.length)
        await this.media.syncAttachments(scope, b.media_ids, {
          type: 'review',
          id,
          role: 'gallery',
          owner: { type: 'user', id: c.userId },
          purposes: ['review_photo'],
          pointer: '/media_ids',
        });
      if (invitation)
        await scope.db
          .updateTable('trust.review_requests')
          .set({ status: 'converted', converted_review_id: id, token_used_at: sql`now()` })
          .where('id', '=', invitation.id)
          .execute();
      await publishEvent(scope, {
        type: 'review.created',
        aggregateType: 'review',
        aggregateId: id,
        payload: {
          subject_organization_id: row.subject_organization_id,
          subject_type: row.subject_type,
          confirmation_path: row.confirmation_path,
          author_user_id: c.userId,
        },
      });
      if (!path1)
        await publishEvent(scope, {
          type: 'review.approval.requested',
          aggregateType: 'review',
          aggregateId: id,
          payload: {
            subject_organization_id: row.subject_organization_id,
            business_confirmation_status: row.business_confirmation_status,
            due_at: new Date(row.business_confirmation_due_at!).toISOString(),
          },
        });
      return (await this.views.authorViews(scope, [row], ctx.locale, new Set(path1 ? [] : [id])))[0]!;
    });
    return created(body, `/v1/me/reviews/${body.id}`);
  }
}

/** Reviews whose author may still add evidence: Path 2 waiting, or an open objection dispute. */
export async function evidenceOpen(scope: TxScope, rows: readonly ReviewRow[]): Promise<Set<string>> {
  const out = new Set(rows.filter((r) => r.status === 'pending_approval').map((r) => r.id));
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return out;
  // The objection is raised by the business: the author does not see it under RLS, so ask by the review's state.
  for (const r of rows) if (r.business_confirmation_status === 'rejected' && r.status === 'pending_approval') out.add(r.id);
  return out;
}

async function loadOwn(scope: TxScope, userId: string, id: string, lock = false): Promise<ReviewRow> {
  const q = scope.db
    .selectFrom('trust.reviews')
    .selectAll()
    .where('id', '=', id)
    .where('author_user_id', '=', userId)
    .where('deleted_at', 'is', null);
  const row = await (lock ? q.forUpdate() : q).executeTakeFirst();
  if (!row) throw new ApiError('NOT_FOUND');
  return row;
}

@Injectable()
@Operation('reviews.mine_list')
export class ReviewsMineListHandler implements OperationHandler {
  constructor(private readonly views: ReviewViews) {}

  async handle(ctx: OperationContext<undefined, { status?: string; limit: number }>): Promise<OperationResult> {
    const c = signedIn(ctx);
    const after = afterId(ctx);
    const body = await ctx.tx(
      async (scope) => {
        let q = scope.db.selectFrom('trust.reviews').selectAll().where('author_user_id', '=', c.userId).where('deleted_at', 'is', null);
        if (ctx.query.status) q = q.where('status', '=', ctx.query.status as ReviewRow['status']);
        if (after) q = q.where('id', '<', after);
        const rows = await q
          .orderBy('id', 'desc')
          .limit(ctx.query.limit + 1)
          .execute();
        const page = rows.slice(0, ctx.query.limit);
        return pageOf(ctx, rows, await this.views.authorViews(scope, page, ctx.locale, await evidenceOpen(scope, page)));
      },
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('reviews.mine_get')
export class ReviewsMineGetHandler implements OperationHandler {
  constructor(private readonly views: ReviewViews) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const c = signedIn(ctx);
    const body = await ctx.tx(
      async (scope) => {
        const r = await loadOwn(scope, c.userId, ctx.params.review_id!);
        return (await this.views.authorViews(scope, [r], ctx.locale, await evidenceOpen(scope, [r])))[0]!;
      },
      { readOnly: true },
    );
    return { body };
  }
}

type ReviewUpdate = Pick<ReviewCreate, 'title' | 'body' | 'overall_rating' | 'would_return' | 'sub_ratings' | 'tag_node_ids'>;

@Injectable()
@Operation('reviews.mine_update')
export class ReviewsMineUpdateHandler implements OperationHandler {
  constructor(private readonly views: ReviewViews) {}

  async handle(ctx: OperationContext<ReviewUpdate>): Promise<OperationResult> {
    const c = signedIn(ctx);
    const b = ctx.body;
    const body = await ctx.tx(async (scope) => {
      const r = await loadOwn(scope, c.userId, ctx.params.review_id!, true);
      if (ctx.ifMatch !== r.version) throw new ApiError('VERSION_MISMATCH');
      if (r.status === 'published') throw new ApiError('INVALID_TRANSITION', { detail: 'published' });
      if (!['draft', 'pending_moderation', 'pending_approval'].includes(r.status))
        throw new ApiError('INVALID_TRANSITION', { detail: r.status });
      failIf(writeErrors(b, r.subject_type as 'provider' | 'vendor'));
      // A rating change never affects the approval decision: only the text and ratings change (40 reviews.mine_update).
      const row = await scope.db
        .updateTable('trust.reviews')
        .set({
          ...(b.title !== undefined ? { title: b.title } : {}),
          ...(b.body !== undefined ? { body: b.body } : {}),
          ...(b.overall_rating !== undefined ? { overall_rating: b.overall_rating } : {}),
          ...(b.would_return !== undefined ? { would_return: b.would_return } : {}),
          updated_at: sql`now()`,
        })
        .where('id', '=', r.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeDetails(scope, r.id, b);
      // The edit restarts the automatic checks (W4).
      await publishEvent(scope, {
        type: 'review.edited',
        aggregateType: 'review',
        aggregateId: r.id,
        payload: { subject_organization_id: r.subject_organization_id, confirmation_path: r.confirmation_path },
      });
      return (await this.views.authorViews(scope, [row], ctx.locale, await evidenceOpen(scope, [row])))[0]!;
    });
    return { body };
  }
}

@Injectable()
@Operation('reviews.mine_withdraw')
export class ReviewsMineWithdrawHandler implements OperationHandler {
  async handle(ctx: OperationContext): Promise<OperationResult> {
    const c = signedIn(ctx);
    await ctx.tx(async (scope) => {
      const r = await loadOwn(scope, c.userId, ctx.params.review_id!, true);
      // A withdrawn review is hidden like a deleted one.
      if (r.status === 'removed') throw new ApiError('NOT_FOUND');
      // Kept for audit and hidden (52 Review rules); its evidence is revoked by W3 on review.removed.
      await scope.db
        .updateTable('trust.reviews')
        .set({ status: 'removed', counts_toward_core_score: false, deletion_reason: 'withdrawn by the author' })
        .where('id', '=', r.id)
        .execute();
      await writeAudit(scope, { action: 'review.withdrawn', entityType: 'review', entityId: r.id, previous: r.status, next: 'removed' });
      await publishEvent(scope, {
        type: 'review.removed',
        aggregateType: 'review',
        aggregateId: r.id,
        payload: { subject_organization_id: r.subject_organization_id, organization_id: r.subject_organization_id, reason: 'withdrawn' },
      });
    });
    return { body: ACK };
  }
}

@Injectable()
@Operation('reviews.evidence_add')
export class ReviewsEvidenceAddHandler implements OperationHandler {
  constructor(
    private readonly media: MediaService,
    private readonly views: ReviewViews,
  ) {}

  async handle(ctx: OperationContext<{ media_ids: string[] }>): Promise<OperationResult> {
    const c = signedIn(ctx);
    const body = await ctx.tx(async (scope) => {
      const r = await loadOwn(scope, c.userId, ctx.params.review_id!, true);
      const open = await evidenceOpen(scope, [r]);
      if (!open.has(r.id)) throw new ApiError('INVALID_TRANSITION', { detail: 'evidence_not_accepted' });
      const existing = (await this.media.attachedAssets(scope, 'review', r.id)).filter((a) => a.role === 'evidence').map((a) => a.assetId);
      const ids = [...new Set([...existing, ...ctx.body.media_ids])].slice(0, 20);
      // MediaAttachment role evidence: visible to CarPal staff only (never in Review.media or PublicReview.media).
      await this.media.syncAttachments(scope, ids, {
        type: 'review',
        id: r.id,
        role: 'evidence',
        owner: { type: 'user', id: c.userId },
        purposes: ['review_evidence', 'review_photo', 'service_evidence'],
        pointer: '/media_ids',
      });
      const row = await scope.db
        .updateTable('trust.reviews')
        .set({ updated_at: sql`now()` })
        .where('id', '=', r.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return (await this.views.authorViews(scope, [row], ctx.locale, open))[0]!;
    });
    return { body };
  }
}
