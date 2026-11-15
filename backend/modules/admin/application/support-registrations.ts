// Support tickets in the admin module's registries (backend S24, BR-13): the ticket:<id> purpose (SEC-ADM-5), the
// support_tickets work queue of admin.work_summary (Docs/23 §6: first response within 1 working day), the requester's
// part of a DSR export and erasure, and the SupportTicket retention policy.
import { sql } from 'kysely';
import type { MembershipDirectory } from '#libs/authz/index.js';
import type { PersonalDataRegistry } from '#modules/identity/interface/identity.js';
import {
  countByStatus,
  retentionCutoff,
  type PurposeQueues,
  type RetentionPolicyRecord,
  type RetentionHandlers,
  type SubjectRef,
  type WorkQueues,
} from '../interface/admin.js';
import { OPEN_TICKET, SUPPORT_ROLES } from './support-ops.js';

const count = (rows: { n: string | number | bigint }[]): number => Number(rows[0]?.n ?? 0);

export function registerSupport(r: {
  purposes: PurposeQueues;
  work: WorkQueues;
  retention: RetentionHandlers;
  directory: MembershipDirectory;
  personal?: PersonalDataRegistry;
}): void {
  // ticket:<id> — an open ticket assigned to the caller or to nobody, for support staff and administrators only (a
  // ticket is not a moderation item). Subjects: the requester and the organization the ticket was filed for.
  r.purposes.register('ticket', {
    open: async (scope, staffUserId, id) => {
      const t = await scope.db
        .selectFrom('admin.support_tickets')
        .select(['status', 'assigned_to'])
        .where('id', '=', id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!t || !OPEN_TICKET.includes(t.status as (typeof OPEN_TICKET)[number])) return false;
      if (t.assigned_to !== null && t.assigned_to !== staffUserId) return false;
      return (await r.directory.platformRoles(staffUserId)).some((role) => SUPPORT_ROLES.includes(role));
    },
    subjects: async (scope, id) => {
      const t = await scope.db
        .selectFrom('admin.support_tickets')
        .select(['requester_user_id', 'organization_id'])
        .where('id', '=', id)
        .executeTakeFirst();
      if (!t) return [];
      const out: SubjectRef[] = [{ type: 'user', id: t.requester_user_id }];
      if (t.organization_id) out.push({ type: 'organization', id: t.organization_id });
      return out;
    },
  });

  // The inbox as admin.support_tickets_list shows it: every ticket not solved. The team's clock runs while a ticket
  // is new or waiting on the team; waiting on the user pauses it.
  r.work.register('support_tickets', {
    roles: ['platform_support', 'platform_admin'],
    assignable: true,
    timed: true,
    async items(scope, staff, limit) {
      const q = scope.db.selectFrom('admin.support_tickets').where('deleted_at', 'is', null).where('status', '<>', 'solved');
      const [n, rows] = await Promise.all([
        q.select(sql<string>`count(*)`.as('n')).execute(),
        q.select(['created_at', 'clock_started_at', 'status', 'topic', 'assigned_to']).orderBy('created_at').limit(limit).execute(),
      ]);
      return {
        open: count(n),
        items: rows.map((t) => ({
          startedAt: t.clock_started_at ?? t.created_at,
          target: { workingDays: 1 },
          paused: t.status === 'waiting_on_user',
          mine: t.assigned_to === staff.userId,
          keys: [`status:${t.status}`, `type:${t.topic}`],
        })),
      };
    },
  });

  // DSR (40 §6.5): the requester's tickets with the whole thread (staff shown as CarPal); erasure deletes them.
  r.personal?.register('support', {
    async export(scope, userId) {
      const tickets = await scope.db
        .selectFrom('admin.support_tickets')
        .select(['id', 'topic', 'subject', 'app_area', 'status', 'outcome', 'created_at', 'solved_at'])
        .where('requester_user_id', '=', userId)
        .execute();
      const messages = tickets.length
        ? await scope.db
            .selectFrom('admin.support_ticket_messages')
            .select(['id', 'ticket_id', 'author_kind', 'body', 'created_at'])
            .where(
              'ticket_id',
              'in',
              tickets.map((t) => t.id),
            )
            .orderBy('created_at')
            .execute()
        : [];
      return [
        {
          section: 'support_tickets',
          records: tickets.map((t) => ({
            id: t.id,
            fields: {
              topic: t.topic,
              subject: t.subject,
              app_area: t.app_area,
              status: t.status,
              outcome: t.outcome,
              created_at: t.created_at.toISOString(),
              solved_at: t.solved_at ? t.solved_at.toISOString() : null,
            },
          })),
        },
        {
          section: 'support_ticket_messages',
          records: messages.map((m) => ({
            id: m.id,
            fields: {
              ticket_id: m.ticket_id,
              author: m.author_kind === 'staff' ? 'CarPal' : 'you',
              body: m.body,
              created_at: m.created_at.toISOString(),
            },
          })),
        },
      ];
    },
    // The tickets are the requester's own requests: they go with the account (messages cascade). The items a ticket
    // was turned into (cases, privacy requests, disputes, plan requests) follow their own modules' rules.
    async erase(scope, userId) {
      const r = await sql`DELETE FROM admin.support_tickets WHERE requester_user_id = ${userId}::uuid`.execute(scope.db);
      return Number(r.numAffectedRows ?? 0);
    },
  });

  // 52 DataRetentionPolicy entity SupportTicket: solved tickets older than the policy, counted from when they were
  // solved (messages cascade). Open tickets are never purged: a policy for another status matches nothing.
  const solvedOnly = (p: RetentionPolicyRecord): boolean => (p.appliesToStatus ?? 'solved') === 'solved';
  r.retention.register(
    'SupportTicket',
    async (scope, p) => {
      if (!solvedOnly(p)) return 0;
      const res = await sql`DELETE FROM admin.support_tickets
                             WHERE status = 'solved' AND solved_at < ${retentionCutoff(p)}`.execute(scope.db);
      return Number(res.numAffectedRows ?? 0);
    },
    async (scope, p) =>
      solvedOnly(p)
        ? countByStatus(
            (
              await sql<{ status: string; n: string }>`SELECT status, count(*) AS n FROM admin.support_tickets
                                                        WHERE status = 'solved' AND solved_at < ${retentionCutoff(p)}
                                                        GROUP BY status`.execute(scope.db)
            ).rows,
          )
        : { affected: 0, byStatus: [] },
  );
}
