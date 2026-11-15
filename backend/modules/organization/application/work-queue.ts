// The verification work queue of admin.work_summary (backend S21, BR-22): pending checks as admin.verifications_queue
// lists them, on the 2-working-day clock that starts at sla_started_at; a check waiting for the business (S19 request
// more info) is paused, and assigned checks count for their assignee.
import { sql } from 'kysely';
import type { WorkQueues } from '#modules/admin/interface/admin.js';

export function registerOrganizationWork(queues: WorkQueues): void {
  queues.register('verifications', {
    roles: ['platform_admin', 'platform_moderator'],
    assignable: true,
    timed: true,
    async items(scope, staff, limit) {
      const q = scope.db
        .selectFrom('organization.organization_verifications')
        .where('deleted_at', 'is', null)
        .where('status', '=', 'pending');
      const [n, rows] = await Promise.all([
        q.select(sql<string>`count(*)`.as('n')).executeTakeFirst(),
        q.select(['sla_started_at', 'sla_paused_at', 'assigned_to', 'verification_type']).orderBy('sla_started_at').limit(limit).execute(),
      ]);
      return {
        open: Number(n?.n ?? 0),
        items: rows.map((r) => ({
          startedAt: r.sla_started_at,
          target: { workingDays: 2 },
          paused: r.sla_paused_at !== null,
          mine: r.assigned_to === staff.userId,
          keys: [`type:${r.verification_type}`],
        })),
      };
    },
  });
}
