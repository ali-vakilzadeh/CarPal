// The privacy request work queue of admin.work_summary (backend S21, BR-22): received, verifying and in-progress data
// subject requests as admin.dsr_queue lists them, each on its own due date (requested_at to due_at).
import { sql } from 'kysely';
import type { WorkQueues } from '#modules/admin/interface/admin.js';

const OPEN_DSR = ['received', 'verifying_identity', 'in_progress'];

export function registerIdentityWork(queues: WorkQueues): void {
  queues.register('privacy_requests', {
    roles: ['platform_admin', 'platform_support'],
    assignable: false,
    timed: true,
    async items(scope, _staff, limit) {
      const q = scope.db.selectFrom('identity.data_subject_requests').where('deleted_at', 'is', null).where('status', 'in', OPEN_DSR);
      const [n, rows] = await Promise.all([
        q.select(sql<string>`count(*)`.as('n')).executeTakeFirst(),
        q.select(['requested_at', 'due_at', 'status', 'request_type']).orderBy('requested_at').limit(limit).execute(),
      ]);
      return {
        open: Number(n?.n ?? 0),
        items: rows.map((r) => ({
          startedAt: r.requested_at,
          target: { at: r.due_at },
          keys: [`status:${r.status}`, `type:${r.request_type}`],
        })),
      };
    },
  });
}
