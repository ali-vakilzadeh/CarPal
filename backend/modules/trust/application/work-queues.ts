// The trust module's work queues of admin.work_summary (backend S21, BR-22), as their list operations show them:
// Path 2 reviews awaiting the CarPal reviewer (admin.review_approvals_queue stage awaiting_reviewer: 2 working days from
// the business's answer or its passed deadline), open and in-mediation disputes (admin.disputes_queue: 5 working days
// from creation) and badges waiting for an administrator's approval (admin.badges_list: no target).
import { sql } from 'kysely';
import type { WorkQueues } from '#modules/admin/interface/admin.js';

const OPEN_DISPUTE = ['open', 'in_mediation'];

export function registerTrustWork(queues: WorkQueues): void {
  queues.register('review_approvals', {
    roles: ['platform_community_reviewer', 'platform_moderator'],
    assignable: false,
    timed: true,
    async items(scope, _staff, limit) {
      const q = scope.db
        .selectFrom('trust.reviews')
        .where('deleted_at', 'is', null)
        .where('status', '=', 'pending_approval')
        .where('confirmation_path', '=', 'approval_based')
        .where('business_confirmation_status', 'in', ['confirmed', 'no_response', 'rejected'])
        .where('reviewer_decision', '=', 'pending');
      // S18 business_answered_at: the business's answer, its passed deadline, or the creation of an invited review.
      const start = sql<Date>`coalesce(business_confirmed_at, updated_at)`;
      const [n, rows] = await Promise.all([
        q.select(sql<string>`count(*)`.as('n')).executeTakeFirst(),
        q
          .select([start.as('started_at'), 'business_confirmation_status'])
          .orderBy(start)
          .limit(limit)
          .execute(),
      ]);
      return {
        open: Number(n?.n ?? 0),
        items: rows.map((r) => ({
          startedAt: r.started_at,
          target: { workingDays: 2 },
          keys: [`status:${r.business_confirmation_status}`],
        })),
      };
    },
  });

  queues.register('disputes', {
    roles: ['platform_moderator', 'platform_community_reviewer'],
    assignable: true,
    timed: true,
    async items(scope, staff, limit) {
      const q = scope.db.selectFrom('trust.disputes').where('deleted_at', 'is', null).where('status', 'in', OPEN_DISPUTE);
      const [n, rows] = await Promise.all([
        q.select(sql<string>`count(*)`.as('n')).executeTakeFirst(),
        q.select(['created_at', 'status', 'dispute_type', 'assigned_to']).orderBy('created_at').limit(limit).execute(),
      ]);
      return {
        open: Number(n?.n ?? 0),
        items: rows.map((r) => ({
          startedAt: r.created_at,
          target: { workingDays: 5 },
          mine: r.assigned_to === staff.userId,
          keys: [`status:${r.status}`, `type:${r.dispute_type}`],
        })),
      };
    },
  });

  queues.register('badge_approvals', {
    roles: ['platform_admin', 'platform_moderator'],
    assignable: false,
    timed: false,
    async items(scope, _staff, limit) {
      const q = scope.db
        .selectFrom('trust.provider_badges')
        .where('deleted_at', 'is', null)
        .where('status', '=', 'pending_approval')
        .where('requires_admin_approval', '=', true);
      const [n, rows] = await Promise.all([
        q.select(sql<string>`count(*)`.as('n')).executeTakeFirst(),
        q.select(['awarded_at', 'badge_type']).orderBy('awarded_at').limit(limit).execute(),
      ]);
      return {
        open: Number(n?.n ?? 0),
        items: rows.map((r) => ({ startedAt: r.awarded_at, target: null, keys: [`type:${r.badge_type}`] })),
      };
    },
  });
}
