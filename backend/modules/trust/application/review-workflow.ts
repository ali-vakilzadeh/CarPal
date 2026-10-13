// W4 review workflow (41 §2.4, §6.3) and the W3 triggers, in the worker's
// system context:
//   - review.created / review.edited: automatic checks; a Path 1 review that
//     passes is published (trust weight 1.0, counted) and review.published
//     goes out; one that fails waits in pending_moderation for the S8 queue.
//     Path 2 reviews are never published here: they need the business's
//     confirmation (or no_response) and a CarPal reviewer (S8 admin plane;
//     the database check reviews_path2_publish_rule enforces it too).
//   - appointment.completed / inquiry.status_changed (completed): the system
//     invitation to the requester (in-app, 7 days).
//   - W15 rules: Path 2 business deadline → no_response (every 5 min),
//     invitation reminders and expiry plus invitations for appointments that
//     took place without being closed (every 15 min), and the nightly trust
//     recomputation (W3 sweep, staleness).
//   - community.reaction.changed (review, helpful) keeps helpful_count.
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { EventEnvelope } from '#libs/infra/index.js';
import { ScheduledRule } from '#libs/jobs/index.js';
import { EventConsumer, publishEvent } from '#libs/outbox/index.js';
import { TxRunner, type TxScope } from '#libs/tenancy/index.js';
import { AppointmentFacts, type AppointmentVisit } from '#modules/appointment/interface/appointments.js';
import { InventoryRead } from '#modules/inventory/interface/inventory.js';
import { PublicProfiles } from '#modules/organization/interface/public-profiles.js';
import { autoCheck, REMINDER_AFTER_MS } from '../domain/reviews.js';
import { reviewTrustWeight } from '../domain/scoring.js';
import { Invitations } from './invitation-ops.js';
import { tookPlace } from './review-ops.js';
import { TrustScorer } from './trust-scorer.js';

@Injectable()
export class ReviewWorkflow {
  constructor(
    private readonly tx: TxRunner,
    private readonly invitations: Invitations,
    private readonly appointments: AppointmentFacts,
    private readonly inventory: InventoryRead,
  ) {}

  /** Automatic checks of a Path 1 review waiting in pending_moderation; returns true when published. */
  async check(reviewId: string, requestId?: string): Promise<boolean> {
    return this.tx.run({ actorType: 'system', ...(requestId ? { requestId } : {}) }, async (scope) => {
      const r = await scope.db
        .selectFrom('trust.reviews')
        .selectAll()
        .where('id', '=', reviewId)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!r || r.status !== 'pending_moderation' || r.confirmation_path !== 'visit_based') return false;
      if (!autoCheck(`${r.title ?? ''}\n${r.body}`).pass) return false;
      const weight = reviewTrustWeight(r.verified_status);
      if (weight <= 0) return false;
      await scope.db
        .updateTable('trust.reviews')
        .set({ status: 'published', published_at: sql`now()`, trust_weight: String(weight), counts_toward_core_score: true })
        .where('id', '=', r.id)
        .execute();
      await publishEvent(scope, {
        type: 'review.published',
        aggregateType: 'review',
        aggregateId: r.id,
        payload: {
          organization_id: r.subject_organization_id,
          subject_organization_id: r.subject_organization_id,
          author_user_id: r.author_user_id,
          confirmation_path: r.confirmation_path,
          overall_rating: Number(r.overall_rating),
        },
      });
      return true;
    });
  }

  /** The system invitation after a visit (52 ReviewRequest: invited_by null, in-app, 7 days). */
  async inviteForAppointment(scope: TxScope, a: AppointmentVisit): Promise<boolean> {
    // Fleet appointments are reviewed through the fleet workflow (fleet_confirmed, S8).
    if (a.requesterType !== 'user') return false;
    const existing = await scope.db
      .selectFrom('trust.review_requests')
      .select('id')
      .where('appointment_id', '=', a.id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    const reviewed = await scope.db
      .selectFrom('trust.reviews')
      .select('id')
      .where('context_appointment_id', '=', a.id)
      .where('author_user_id', '=', a.requesterUserId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (existing || reviewed) return false;
    await this.invitations.create(scope, {
      subjectOrgId: a.providerOrgId,
      visit: { appointment_id: a.id },
      invitedUserId: a.requesterUserId,
      invitedContact: null,
      invitedBy: null,
      channel: 'in_app',
      businessConfirmation: false,
    });
    return true;
  }

  async onAppointmentCompleted(appointmentId: string, requestId?: string): Promise<void> {
    await this.tx.run({ actorType: 'system', ...(requestId ? { requestId } : {}) }, async (scope) => {
      const a = (await this.appointments.visits(scope, [appointmentId])).get(appointmentId);
      if (a && tookPlace(a, Date.now())) await this.inviteForAppointment(scope, a);
    });
  }

  async onInquiryCompleted(inquiryId: string, requestId?: string): Promise<void> {
    await this.tx.run({ actorType: 'system', ...(requestId ? { requestId } : {}) }, async (scope) => {
      const q = (await this.inventory.inquiryVisits(scope, { ids: [inquiryId] }))[0];
      if (!q || q.status !== 'completed' || q.requesterType !== 'user') return;
      const existing = await scope.db
        .selectFrom('trust.review_requests')
        .select('id')
        .where('stock_inquiry_id', '=', q.id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (existing) return;
      await this.invitations.create(scope, {
        subjectOrgId: q.vendorOrgId,
        visit: { stock_inquiry_id: q.id },
        invitedUserId: q.requesterUserId,
        invitedContact: null,
        invitedBy: null,
        channel: 'in_app',
        businessConfirmation: false,
      });
    });
  }
}

/** W4: review checks and system invitations. */
@Injectable()
export class ReviewWorkflowConsumer extends EventConsumer {
  readonly name = 'trust.review_workflow';
  readonly subjects = ['review.created', 'review.edited', 'appointment.completed', 'inquiry.status_changed'];

  constructor(private readonly workflow: ReviewWorkflow) {
    super();
  }

  async handle(event: EventEnvelope): Promise<void> {
    const p = event.payload;
    switch (event.type) {
      case 'review.created':
      case 'review.edited':
        await this.workflow.check(event.aggregateId, event.requestId ?? undefined);
        return;
      case 'appointment.completed':
        await this.workflow.onAppointmentCompleted(event.aggregateId, event.requestId ?? undefined);
        return;
      case 'inquiry.status_changed':
        if (p.new_status === 'completed') await this.workflow.onInquiryCompleted(event.aggregateId, event.requestId ?? undefined);
        return;
    }
  }
}

/** The organization an event concerns, for W3. */
function organizationOf(e: EventEnvelope): string | null {
  const p = e.payload;
  for (const k of ['organization_id', 'subject_organization_id', 'provider_organization_id', 'vendor_organization_id'])
    if (typeof p[k] === 'string') return p[k] as string;
  return e.aggregateType === 'organization' ? e.aggregateId : null;
}

/** W3: recompute the organization an event touches (54 §4 "on relevant events"). */
@Injectable()
export class TrustScoringConsumer extends EventConsumer {
  readonly name = 'trust.scoring';
  readonly subjects = [
    'review.published',
    'review.removed',
    'review.approved',
    'review.response.published',
    'appointment.completed',
    'appointment.confirmed',
    'appointment.status_changed',
    'portfolio.published',
    'organization.verified',
    'moderation.action.taken',
    'provider.profile.published',
  ];

  constructor(private readonly scorer: TrustScorer) {
    super();
  }

  async handle(event: EventEnvelope): Promise<void> {
    const orgId = organizationOf(event);
    if (orgId) await this.scorer.recompute(orgId, new Date(), event.requestId ?? undefined);
  }
}

/** community.reaction.changed → trust.reviews.helpful_count (SEC-BF-9: the count already leaves out the subject's members). */
@Injectable()
export class HelpfulCountConsumer extends EventConsumer {
  readonly name = 'trust.helpful_count';
  readonly subjects = ['community.reaction.changed'];

  constructor(private readonly tx: TxRunner) {
    super();
  }

  async handle(event: EventEnvelope): Promise<void> {
    const p = event.payload;
    if (p.target_type !== 'review' || p.reaction_type !== 'helpful' || typeof p.target_id !== 'string') return;
    const count = Math.max(0, Math.trunc(Number(p.count) || 0));
    await this.tx.run({ actorType: 'system', requestId: event.requestId }, async ({ db }) => {
      await db
        .updateTable('trust.reviews')
        .set({ helpful_count: count })
        .where('id', '=', p.target_id as string)
        .where('helpful_count', '<>', count)
        .execute();
    });
  }
}

/** Path 2: no business answer within 7 days counts as no objection (52 Business confirmation status no_response). */
@Injectable()
export class ApprovalDeadlineRule extends ScheduledRule {
  readonly name = 'trust.approval_deadline';
  readonly everyMs = 5 * 60_000;

  constructor(private readonly tx: TxRunner) {
    super();
  }

  async run(now = new Date()): Promise<number> {
    return this.tx.run({ actorType: 'system' }, async (scope) => {
      const rows = await scope.db
        .updateTable('trust.reviews')
        .set({ business_confirmation_status: 'no_response', business_confirmation_source: 'deadline_passed', business_confirmed_at: now })
        .where('status', '=', 'pending_approval')
        .where('business_confirmation_status', '=', 'pending')
        .where('business_confirmation_due_at', '<=', now)
        .where('deleted_at', 'is', null)
        .returning(['id', 'subject_organization_id'])
        .execute();
      for (const r of rows)
        await publishEvent(scope, {
          type: 'review.approval.answered',
          aggregateType: 'review',
          aggregateId: r.id,
          payload: { subject_organization_id: r.subject_organization_id, answer: 'no_response' },
        });
      return rows.length;
    });
  }
}

/** Invitation reminders (≤ 2, while valid), expiry, and invitations for visits that took place without being closed. */
@Injectable()
export class InvitationRule extends ScheduledRule {
  readonly name = 'trust.invitations';
  readonly everyMs = 15 * 60_000;

  constructor(
    private readonly tx: TxRunner,
    private readonly workflow: ReviewWorkflow,
    private readonly appointments: AppointmentFacts,
  ) {
    super();
  }

  async run(now = new Date()): Promise<number> {
    let n = 0;
    await this.tx.run({ actorType: 'system' }, async (scope) => {
      const expired = await scope.db
        .updateTable('trust.review_requests')
        .set({ status: 'expired' })
        .where('status', 'in', ['sent', 'opened', 'reminded'])
        .where('expires_at', '<=', now)
        .where('deleted_at', 'is', null)
        .returning('id')
        .execute();
      n += expired.length;
      const due = await scope.db
        .selectFrom('trust.review_requests')
        .select(['id', 'subject_organization_id', 'invited_user_id', 'reminder_count', 'sent_at'])
        .where('status', 'in', ['sent', 'reminded'])
        .where('invited_user_id', 'is not', null)
        .where('expires_at', '>', now)
        .where('reminder_count', '<', REMINDER_AFTER_MS.length)
        .where('deleted_at', 'is', null)
        .limit(1000)
        .execute();
      for (const r of due) {
        const after = REMINDER_AFTER_MS[Number(r.reminder_count)]!;
        if (new Date(r.sent_at!).getTime() + after > now.getTime()) continue;
        await scope.db
          .updateTable('trust.review_requests')
          .set({ status: 'reminded', reminder_count: Number(r.reminder_count) + 1, last_sent_at: now })
          .where('id', '=', r.id)
          .execute();
        await publishEvent(scope, {
          type: 'review.invitation.reminded',
          aggregateType: 'review_request',
          aggregateId: r.id,
          payload: { subject_organization_id: r.subject_organization_id, invited_user_id: r.invited_user_id },
        });
        n++;
      }
    });
    // 52 §21: a confirmed appointment whose time passed 24 h ago is reviewable even if the shop did not close it.
    const visits = await this.tx.run({ actorType: 'system' }, (scope) =>
      this.appointments.tookPlaceSince(scope, new Date(now.getTime() - 8 * 86_400_000), now, 500),
    );
    for (const a of visits) if (await this.tx.run({ actorType: 'system' }, (scope) => this.workflow.inviteForAppointment(scope, a))) n++;
    return n;
  }
}

/** Nightly W3 sweep (54 §4 "recalculated nightly", §6 staleness): every published organization and recent appointment providers. */
@Injectable()
export class TrustNightlyRule extends ScheduledRule {
  readonly name = 'trust.nightly';
  readonly everyMs = 86_400_000;

  constructor(
    private readonly tx: TxRunner,
    private readonly scorer: TrustScorer,
    private readonly profiles: PublicProfiles,
    private readonly appointments: AppointmentFacts,
  ) {
    super();
  }

  async run(now = new Date()): Promise<number> {
    const ids = new Set<string>();
    let after: string | null = null;
    for (;;) {
      const page: string[] = await this.tx.run({ actorType: 'system' }, (scope) => this.profiles.publishedIds(scope, after, 500));
      for (const id of page) ids.add(id);
      if (page.length < 500) break;
      after = page.at(-1)!;
    }
    for (const id of await this.tx.run({ actorType: 'system' }, (scope) =>
      this.appointments.activeProviders(scope, new Date(now.getTime() - 400 * 86_400_000), 5000),
    ))
      ids.add(id);
    for (const id of ids) await this.scorer.recompute(id, now);
    return ids.size;
  }
}
