// The admin module's own work queues and system health signal (backend S21, BR-22, BR-17): four-eyes changes the
// caller may decide, open reports and open cases (as admin.four_eyes_list, admin.reports_list and admin.cases_list
// show them), and failed import jobs (core.background_jobs, a platform table the admin module already purges).
import { sql } from 'kysely';
import { failureCounts, type SystemHealthSignals, type WorkQueues } from '../interface/admin.js';
import { moderationTarget } from './work-sla.js';

/** Background job kinds of the inventory and fleet imports (inventory.import_create, fleet.import_create). */
export const IMPORT_JOB_KINDS: readonly string[] = ['inventory_import', 'fleet_import'];

const OPEN_CASE = ['open', 'investigating', 'escalated'];

const count = (rows: { n: string | number | bigint }[]): number => Number(rows[0]?.n ?? 0);

export function registerAdminWork(queues: WorkQueues, signals: SystemHealthSignals): void {
  queues.register('four_eyes', {
    roles: ['platform_admin', 'platform_moderator'],
    assignable: false,
    timed: true,
    async items(scope, staff, limit) {
      const now = new Date();
      // Never the caller's own changes; moderators decide moderation changes only (admin.four_eyes_list).
      let q = scope.db
        .selectFrom('admin.pending_admin_changes')
        .where('deleted_at', 'is', null)
        .where('status', '=', 'pending')
        .where('expires_at', '>', now)
        .where('requested_by', '<>', staff.userId);
      if (!staff.roles.includes('platform_admin')) q = q.where('required_role', '=', 'platform_moderator');
      const [n, rows] = await Promise.all([
        q.select(sql<string>`count(*)`.as('n')).execute(),
        q.select(['created_at', 'expires_at', 'op_id']).orderBy('created_at').limit(limit).execute(),
      ]);
      return {
        open: count(n),
        items: rows.map((r) => ({ startedAt: r.created_at, target: { at: r.expires_at }, keys: [`type:${r.op_id}`] })),
      };
    },
  });

  queues.register('reports', {
    roles: ['platform_moderator', 'platform_support'],
    assignable: false,
    timed: true,
    async items(scope, _staff, limit) {
      const q = scope.db.selectFrom('admin.content_reports').where('deleted_at', 'is', null).where('status', '=', 'open');
      const [n, rows] = await Promise.all([
        q.select(sql<string>`count(*)`.as('n')).execute(),
        q.select(['created_at', 'reason', 'target_type']).orderBy('created_at').limit(limit).execute(),
      ]);
      return {
        open: count(n),
        items: rows.map((r) => ({
          startedAt: r.created_at,
          target: moderationTarget(r.reason, null, r.target_type),
          keys: [`reason:${r.reason}`, `type:${r.target_type}`],
        })),
      };
    },
  });

  queues.register('cases', {
    roles: ['platform_moderator', 'platform_admin'],
    assignable: true,
    timed: true,
    async items(scope, staff, limit) {
      const q = scope.db.selectFrom('admin.moderation_cases').where('deleted_at', 'is', null).where('status', 'in', OPEN_CASE);
      const [n, rows] = await Promise.all([
        q.select(sql<string>`count(*)`.as('n')).execute(),
        q
          .select(['created_at', 'status', 'source', 'reason', 'severity', 'case_type', 'assigned_to'])
          .orderBy('created_at')
          .limit(limit)
          .execute(),
      ]);
      return {
        open: count(n),
        items: rows.map((r) => ({
          startedAt: r.created_at,
          target: moderationTarget(r.reason, r.severity, r.case_type),
          mine: r.assigned_to === staff.userId,
          keys: [`status:${r.status}`, `source:${r.source}`, `reason:${r.reason}`, `type:${r.case_type}`, `severity:${r.severity}`],
        })),
      };
    },
  });

  signals.register('import_failures', (scope, now) =>
    failureCounts(
      scope,
      sql`FROM core.background_jobs WHERE status = 'failed' AND kind IN (${sql.join(IMPORT_JOB_KINDS.map((k) => sql`${k}`))})`,
      sql`coalesce(finished_at, updated_at)`,
      now,
    ),
  );
}
