// Support tickets (backend S24, admin console BR-13; 40 §22.2 support.*, §23.6 admin.support_*; 52 SupportTicket,
// SupportTicketMessage; Docs/23 A-SUP-01, Docs/21 C-PROF-09). Owner decisions: DQ-07 (filed and answered in the apps
// only, no email intake) and DQ-20 row 4 (one ticket model; the console's inbox is an intake queue that answers with
// templates and turns tickets into a moderation case, privacy request, dispute or plan request).
//
// A ticket is its requester's own: other members of the organization it was filed for do not see it. Staff read it
// under its purpose ticket:<id> (SEC-ADM-5; subjects: the requester and the organization), and their names never
// reach the requester ("CarPal"). The team's clock (Docs/23 §6: first response within 1 working day) runs while the
// ticket is new or waiting on the team; a staff reply hands it to the user, a user reply hands it back, and a user
// reply within 14 days reopens a solved ticket.
import { Injectable } from '@nestjs/common';
import type { Selectable } from 'kysely';
import { writeAudit } from '#libs/audit/index.js';
import { MembershipDirectory, OrganizationDirectory } from '#libs/authz/index.js';
import { ApiError, type FieldError } from '#libs/contract/index.js';
import type { DB } from '#libs/db/index.js';
import {
  created,
  iso,
  isoOrNull,
  Operation,
  type OperationContext,
  type OperationHandler,
  type OperationResult,
} from '#libs/http-pipeline/index.js';
import { ScheduledRule } from '#libs/jobs/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import { TxRunner, type TxScope } from '#libs/tenancy/index.js';
import { SubscriptionWriter } from '#modules/billing/interface/billing.js';
import { AccountAdmin } from '#modules/identity/interface/identity.js';
import { OrgCards, toOrgSummary } from '#modules/organization/interface/org-cards.js';
import { TrustAdmin } from '#modules/trust/interface/trust.js';
import { auditStaffRead, caseSeverity, ModerationTargets, StaffNames, staffOf } from '../interface/admin.js';
import { afterId, failIf, notFoundAt, pageOf } from './common.js';

export type TicketRow = Selectable<DB['admin.support_tickets']>;
type MessageRow = Selectable<DB['admin.support_ticket_messages']>;
export type TicketStatus = 'new' | 'waiting_on_user' | 'waiting_on_team' | 'solved';
export type LinkedItem = { type: 'moderation_case' | 'data_subject_request' | 'dispute' | 'subscription_change_request'; id: string };

/** Statuses of a ticket that is not solved (the inbox's open items). */
export const OPEN_TICKET: readonly TicketStatus[] = ['new', 'waiting_on_user', 'waiting_on_team'];
/** A requester's reply reopens a ticket solved less than this long ago (40 SupportTicket.can_reply). */
export const REOPEN_MS = 14 * 86_400_000;
/** 40 SupportTicketThread.items, StaffSupportTicketDetail.items: one thread, both authors. */
const THREAD_MAX = 200;
/** At most this many open tickets per user (40 support.ticket_create). */
const OPEN_MAX = 5;
/** 40 StaffSupportTicket.linked_items. */
const LINKS_MAX = 10;
const STAFF_LABEL = 'CarPal';
const OPEN_CASE = ['open', 'investigating', 'escalated'];
/** Platform roles that work the inbox (40 §23.6 STF(SUP, ADM)) and may use a ticket purpose. */
export const SUPPORT_ROLES = ['platform_support', 'platform_admin'];
const OWNER_ROLES = ['provider_owner', 'vendor_owner', 'fleet_owner'];

export const canReply = (t: Pick<TicketRow, 'status' | 'solved_at'>, now = Date.now()): boolean =>
  t.status !== 'solved' || (!!t.solved_at && now - t.solved_at.getTime() < REOPEN_MS);

const linksOf = (t: TicketRow): LinkedItem[] => (Array.isArray(t.linked_items) ? (t.linked_items as unknown as LinkedItem[]) : []);

/** 40 SupportTicket (the requester's view). */
function toTicket(t: TicketRow) {
  return {
    id: t.id,
    topic: t.topic,
    subject: t.subject,
    app_area: t.app_area,
    organization_id: t.organization_id,
    status: t.status as TicketStatus,
    outcome: t.outcome,
    can_reply: canReply(t),
    created_at: iso(t.created_at),
    last_message_at: iso(t.last_message_at),
    solved_at: isoOrNull(t.solved_at),
  };
}

/** 40 SupportMessage: staff show as "CarPal". */
function toMessage(m: MessageRow, name: string) {
  return {
    id: m.id,
    author: m.author_kind as 'requester' | 'staff',
    author_display: m.author_kind === 'staff' ? STAFF_LABEL : name,
    body: m.body,
    created_at: iso(m.created_at),
  };
}

/** 40 StaffSupportMessage: the requester's view plus the template and the staff member who wrote it. */
function toStaffMessage(m: MessageRow, name: string) {
  return { ...toMessage(m, name), template_key: m.template_key, staff_author_display: m.author_kind === 'staff' ? name : null };
}

async function threadOf(scope: TxScope, ticketId: string): Promise<MessageRow[]> {
  return scope.db
    .selectFrom('admin.support_ticket_messages')
    .selectAll()
    .where('ticket_id', '=', ticketId)
    .orderBy('created_at')
    .orderBy('id')
    .limit(THREAD_MAX)
    .execute();
}

async function messageCounts(scope: TxScope, ids: readonly string[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const rows = await scope.db
    .selectFrom('admin.support_ticket_messages')
    .select(['ticket_id', (eb) => eb.fn.countAll<string>().as('n')])
    .where('ticket_id', 'in', ids)
    .groupBy('ticket_id')
    .execute();
  return new Map(rows.map((r) => [r.ticket_id, Number(r.n)]));
}

/** Staff views of tickets: requester and assignee names, the organization card, message counts. */
@Injectable()
export class SupportViews {
  constructor(
    readonly names: StaffNames,
    private readonly orgs: OrgCards,
  ) {}

  async many(scope: TxScope, rows: TicketRow[], locale: string) {
    const ids = rows.map((r) => r.id);
    const [names, cards, counts] = await Promise.all([
      this.names.names(scope, [...rows.map((r) => r.requester_user_id), ...rows.map((r) => r.assigned_to)], locale),
      this.orgs.cards(scope, [...new Set(rows.map((r) => r.organization_id).filter((x): x is string => !!x))]),
      messageCounts(scope, ids),
    ]);
    return rows.map((t) => {
      const card = t.organization_id ? cards.get(t.organization_id) : undefined;
      return {
        id: t.id,
        topic: t.topic,
        subject: t.subject,
        app_area: t.app_area,
        requester: { user_id: t.requester_user_id, display: names.get(t.requester_user_id)! },
        organization: card ? toOrgSummary(card) : null,
        status: t.status as TicketStatus,
        outcome: t.outcome,
        assignee: t.assigned_to ? { user_id: t.assigned_to, display: names.get(t.assigned_to)! } : null,
        clock_started_at: isoOrNull(t.clock_started_at),
        first_response_at: isoOrNull(t.first_response_at),
        message_count: counts.get(t.id) ?? 0,
        linked_items: linksOf(t),
        created_at: iso(t.created_at),
        last_message_at: iso(t.last_message_at),
        solved_at: isoOrNull(t.solved_at),
        version: t.version,
      };
    });
  }

  async one(scope: TxScope, row: TicketRow, locale: string) {
    return (await this.many(scope, [row], locale))[0]!;
  }
}

// ------------------------------------------------------------------ the requester (api host)

type TicketCreate = {
  topic: string;
  subject: string;
  body: string;
  app_area?: string;
  organization_id?: string;
  diagnostics?: Record<string, string>;
};

function requester(ctx: OperationContext): string {
  if (ctx.principal.kind !== 'user') throw new ApiError('NOT_FOUND');
  return ctx.principal.userId;
}

async function ownTicket(scope: TxScope, userId: string, id: string, lock = false): Promise<TicketRow> {
  // RLS requester_read: the requester's own tickets only.
  const q = scope.db
    .selectFrom('admin.support_tickets')
    .selectAll()
    .where('id', '=', id)
    .where('requester_user_id', '=', userId)
    .where('deleted_at', 'is', null);
  const t = await (lock ? q.forUpdate() : q).executeTakeFirst();
  if (!t) throw new ApiError('NOT_FOUND');
  return t;
}

@Injectable()
@Operation('support.ticket_create')
export class SupportTicketCreateHandler implements OperationHandler {
  constructor(private readonly names: StaffNames) {}

  async handle(ctx: OperationContext<TicketCreate>): Promise<OperationResult> {
    const userId = requester(ctx);
    const b = ctx.body;
    if ([...b.body.trim()].length < 10) failIf([{ pointer: '/body', code: 'too_short', limit: '10' }]);
    if ([...b.subject.trim()].length < 3) failIf([{ pointer: '/subject', code: 'too_short', limit: '3' }]);
    // Filed for a business: the caller must be an active member (any role); the ticket stays the caller's own.
    const org = b.organization_id ? await ctx.authorizeOrg(b.organization_id, ['ANY']) : null;
    const body = await ctx.tx(async (scope) => {
      if (org) await scope.setOrganization(org.id, org.role);
      const open = await scope.db
        .selectFrom('admin.support_tickets')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('requester_user_id', '=', userId)
        .where('status', '<>', 'solved')
        .where('deleted_at', 'is', null)
        .executeTakeFirstOrThrow();
      if (Number(open.n) >= OPEN_MAX) throw new ApiError('INVALID_TRANSITION', { detail: 'too_many_open' });
      const t = await scope.db
        .insertInto('admin.support_tickets')
        .values({
          requester_user_id: userId,
          organization_id: org?.id ?? null,
          topic: b.topic,
          subject: b.subject.trim(),
          app_area: b.app_area ?? null,
          diagnostics: b.diagnostics ? JSON.stringify(b.diagnostics) : null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const m = await scope.db
        .insertInto('admin.support_ticket_messages')
        .values({ ticket_id: t.id, author_kind: 'requester', author_user_id: userId, body: b.body })
        .returningAll()
        .executeTakeFirstOrThrow();
      await publishEvent(scope, {
        type: 'support.ticket.created',
        aggregateType: 'support_ticket',
        aggregateId: t.id,
        payload: { ticket_id: t.id, topic: t.topic, organization_id: t.organization_id },
      });
      return { ...toTicket(t), items: [toMessage(m, await this.names.name(scope, userId, ctx.locale))] };
    });
    return created(body, `/v1/support/tickets/${body.id}`);
  }
}

@Injectable()
@Operation('support.tickets_list')
export class SupportTicketsListHandler implements OperationHandler {
  async handle(ctx: OperationContext<undefined, { status?: string; limit: number }>): Promise<OperationResult> {
    const userId = requester(ctx);
    const after = afterId(ctx);
    const body = await ctx.tx(
      async (scope) => {
        let q = scope.db
          .selectFrom('admin.support_tickets')
          .selectAll()
          .where('requester_user_id', '=', userId)
          .where('deleted_at', 'is', null);
        if (ctx.query.status) q = q.where('status', '=', ctx.query.status);
        if (after) q = q.where('id', '<', after);
        const rows = await q
          .orderBy('id', 'desc')
          .limit(ctx.query.limit + 1)
          .execute();
        return pageOf(ctx, rows, rows.slice(0, ctx.query.limit).map(toTicket));
      },
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('support.ticket_get')
export class SupportTicketGetHandler implements OperationHandler {
  constructor(private readonly names: StaffNames) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const userId = requester(ctx);
    const body = await ctx.tx(
      async (scope) => {
        const t = await ownTicket(scope, userId, ctx.params.ticket_id!);
        const [rows, name] = await Promise.all([threadOf(scope, t.id), this.names.name(scope, userId, ctx.locale)]);
        return { ...toTicket(t), items: rows.map((m) => toMessage(m, name)) };
      },
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('support.ticket_reply')
export class SupportTicketReplyHandler implements OperationHandler {
  constructor(private readonly names: StaffNames) {}

  async handle(ctx: OperationContext<{ body: string }>): Promise<OperationResult> {
    const userId = requester(ctx);
    if (!ctx.body.body.trim()) failIf([{ pointer: '/body', code: 'too_short', limit: '1' }]);
    const body = await ctx.tx(async (scope) => {
      const t = await ownTicket(scope, userId, ctx.params.ticket_id!, true);
      if (!canReply(t)) throw new ApiError('INVALID_TRANSITION', { detail: 'closed' });
      if ((await messageCounts(scope, [t.id])).get(t.id)! >= THREAD_MAX)
        throw new ApiError('INVALID_TRANSITION', { detail: 'thread_full' });
      const m = await scope.db
        .insertInto('admin.support_ticket_messages')
        .values({ ticket_id: t.id, author_kind: 'requester', author_user_id: userId, body: ctx.body.body })
        .returningAll()
        .executeTakeFirstOrThrow();
      // The answer hands the ticket back to the team (its clock starts again); a reply to a solved ticket reopens it.
      // A new ticket or one already waiting on the team keeps its clock. RLS requester_update re-checks the status.
      const now = new Date();
      const handBack = t.status === 'waiting_on_user' || t.status === 'solved';
      await scope.db
        .updateTable('admin.support_tickets')
        .set(
          handBack
            ? { status: 'waiting_on_team', clock_started_at: now, last_message_at: now, outcome: null, solved_at: null, solved_by: null }
            : { last_message_at: now },
        )
        .where('id', '=', t.id)
        .execute();
      await publishEvent(scope, {
        type: 'support.message.posted',
        aggregateType: 'support_ticket',
        aggregateId: t.id,
        payload: { ticket_id: t.id, message_id: m.id, author: 'requester', reopened: t.status === 'solved' },
      });
      return toMessage(m, await this.names.name(scope, userId, ctx.locale));
    });
    return created(body, `/v1/support/tickets/${ctx.params.ticket_id}/messages/${body.id}`);
  }
}

// ------------------------------------------------------------------ the inbox (admin-api host)

async function loadTicket(scope: TxScope, id: string, lock = false): Promise<TicketRow> {
  const q = scope.db.selectFrom('admin.support_tickets').selectAll().where('id', '=', id).where('deleted_at', 'is', null);
  const t = await (lock ? q.forUpdate() : q).executeTakeFirst();
  if (!t) throw new ApiError('NOT_FOUND');
  return t;
}

@Injectable()
@Operation('admin.support_tickets_list')
export class AdminSupportTicketsListHandler implements OperationHandler {
  constructor(private readonly views: SupportViews) {}

  async handle(
    ctx: OperationContext<
      undefined,
      { status?: string[]; topic?: string; assigned_to_me?: boolean; organization_id?: string; limit: number }
    >,
  ): Promise<OperationResult> {
    const s = staffOf(ctx);
    const q = ctx.query;
    const after = afterId(ctx);
    const body = await ctx.tx(
      async (scope) => {
        let t = scope.db.selectFrom('admin.support_tickets').selectAll().where('deleted_at', 'is', null);
        if (q.status?.length) t = t.where('status', 'in', q.status);
        if (q.topic) t = t.where('topic', '=', q.topic);
        if (q.organization_id) t = t.where('organization_id', '=', q.organization_id);
        if (q.assigned_to_me !== undefined)
          t = q.assigned_to_me ? t.where('assigned_to', '=', s.userId) : t.where('assigned_to', 'is', null);
        if (after) t = t.where('id', '<', after);
        const rows = await t
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
@Operation('admin.support_ticket_get')
export class AdminSupportTicketGetHandler implements OperationHandler {
  constructor(private readonly views: SupportViews) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const s = staffOf(ctx);
    const body = await ctx.tx(async (scope) => {
      const t = await loadTicket(scope, ctx.params.ticket_id!);
      const rows = await threadOf(scope, t.id);
      const names = await this.views.names.names(
        scope,
        rows.map((m) => m.author_user_id),
        ctx.locale,
      );
      await auditStaffRead(scope, s, 'support_ticket', t.id, 'support ticket thread and diagnostics');
      return {
        ...(await this.views.one(scope, t, ctx.locale)),
        diagnostics: (t.diagnostics as Record<string, string> | null) ?? null,
        resolution_note: t.resolution_note,
        items: rows.map((m) => toStaffMessage(m, names.get(m.author_user_id)!)),
      };
    });
    return { body };
  }
}

@Injectable()
@Operation('admin.support_ticket_assign')
export class AdminSupportTicketAssignHandler implements OperationHandler {
  constructor(
    private readonly views: SupportViews,
    private readonly directory: MembershipDirectory,
  ) {}

  async handle(ctx: OperationContext<{ assignee_user_id?: string; reason: string }>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const assignee = ctx.body.assignee_user_id ?? s.userId;
    if (assignee !== s.userId) {
      const roles = await this.directory.platformRoles(assignee);
      if (!roles.some((r) => SUPPORT_ROLES.includes(r))) throw notFoundAt('/assignee_user_id');
    }
    const body = await ctx.tx(async (scope) => {
      const t = await loadTicket(scope, ctx.params.ticket_id!, true);
      if (t.status === 'solved') throw new ApiError('INVALID_TRANSITION', { detail: 'solved' });
      const row = await scope.db
        .updateTable('admin.support_tickets')
        .set({ assigned_to: assignee })
        .where('id', '=', t.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeAudit(scope, {
        action: 'support.ticket_assigned',
        entityType: 'support_ticket',
        entityId: t.id,
        reason: ctx.body.reason,
        previous: t.assigned_to ?? 'unassigned',
        next: assignee,
      });
      return this.views.one(scope, row, ctx.locale);
    });
    return { body };
  }
}

type StaffReply = { template_key: string; body: string; status?: 'waiting_on_user' | 'waiting_on_team'; reason: string };

@Injectable()
@Operation('admin.support_ticket_reply')
export class AdminSupportTicketReplyHandler implements OperationHandler {
  constructor(private readonly names: StaffNames) {}

  async handle(ctx: OperationContext<StaffReply>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const b = ctx.body;
    if (!b.body.trim()) failIf([{ pointer: '/body', code: 'too_short', limit: '1' }]);
    const body = await ctx.tx(async (scope) => {
      const t = await loadTicket(scope, ctx.params.ticket_id!, true);
      if (t.status === 'solved') throw new ApiError('INVALID_TRANSITION', { detail: 'solved' });
      if ((await messageCounts(scope, [t.id])).get(t.id)! >= THREAD_MAX)
        throw new ApiError('INVALID_TRANSITION', { detail: 'thread_full' });
      const m = await scope.db
        .insertInto('admin.support_ticket_messages')
        .values({ ticket_id: t.id, author_kind: 'staff', author_user_id: s.userId, template_key: b.template_key, body: b.body })
        .returningAll()
        .executeTakeFirstOrThrow();
      // The first staff message is the first response (Docs/23 §6). Waiting on the user stops the team's clock; staying
      // with the team (an acknowledgement) keeps it where it started.
      const now = new Date();
      const next = b.status ?? 'waiting_on_user';
      await scope.db
        .updateTable('admin.support_tickets')
        .set({
          status: next,
          clock_started_at: next === 'waiting_on_team' ? (t.clock_started_at ?? now) : null,
          first_response_at: t.first_response_at ?? now,
          last_message_at: now,
        })
        .where('id', '=', t.id)
        .execute();
      await writeAudit(scope, {
        action: 'support.reply_posted',
        entityType: 'support_ticket',
        entityId: t.id,
        reason: b.reason,
        previous: t.status,
        next: `${b.template_key}; ${next}`,
        accessPurpose: s.purpose,
      });
      // The requester is notified (W5): in the app, and a notice by email or push that points to the app (DQ-07).
      await publishEvent(scope, {
        type: 'support.message.posted',
        aggregateType: 'support_ticket',
        aggregateId: t.id,
        payload: {
          ticket_id: t.id,
          message_id: m.id,
          author: 'staff',
          template_key: b.template_key,
          requester_user_id: t.requester_user_id,
        },
      });
      return toStaffMessage(m, await this.names.name(scope, s.userId, ctx.locale));
    });
    return created(body, `/v1/admin/support/tickets/${ctx.params.ticket_id}/messages/${body.id}`);
  }
}

type Conversion = {
  into: 'moderation_case' | 'privacy_request' | 'dispute' | 'plan_request';
  case_target?: { type: string; id: string };
  moderation_reason?: string;
  severity?: string;
  request_type?: string;
  dispute_target?: { type: 'review' | 'service_record' | 'badge' | 'appointment' | 'moderation_action'; id: string };
  dispute_type?: string;
  plan_key?: string;
  statement?: string;
  reason: string;
};

/** The members each `into` requires; the members of the other kinds are refused (40 SupportConversion `C:`). */
const CONVERSION_MEMBERS: Record<Conversion['into'], (keyof Conversion)[]> = {
  moderation_case: ['case_target', 'moderation_reason', 'severity'],
  privacy_request: ['request_type'],
  dispute: ['dispute_target', 'dispute_type'],
  plan_request: ['plan_key'],
};

export function checkConversion(b: Conversion): void {
  const required = CONVERSION_MEMBERS[b.into];
  const others = Object.values(CONVERSION_MEMBERS)
    .flat()
    .filter((k) => !required.includes(k));
  const errors: FieldError[] = [
    ...required.filter((k) => b[k] === undefined).map((k) => ({ pointer: `/${k}`, code: 'conditional_required' as const })),
    ...others.filter((k) => b[k] !== undefined).map((k) => ({ pointer: `/${k}`, code: 'conditional_forbidden' as const })),
  ];
  if (b.into === 'dispute' && b.dispute_type === 'review_approval_objection') errors.push({ pointer: '/dispute_type', code: 'enum' });
  failIf(errors);
}

const cut = (text: string, max: number): string => {
  const chars = [...text.trim()];
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('')}…`;
};

@Injectable()
@Operation('admin.support_ticket_convert')
export class AdminSupportTicketConvertHandler implements OperationHandler {
  constructor(
    private readonly views: SupportViews,
    private readonly targets: ModerationTargets,
    private readonly accounts: AccountAdmin,
    private readonly trust: TrustAdmin,
    private readonly subscriptions: SubscriptionWriter,
    private readonly memberships: MembershipDirectory,
    private readonly organizations: OrganizationDirectory,
  ) {}

  async handle(ctx: OperationContext<Conversion>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const b = ctx.body;
    checkConversion(b);
    const body = await ctx.tx(async (scope) => {
      const t = await loadTicket(scope, ctx.params.ticket_id!, true);
      if (t.status === 'solved') throw new ApiError('INVALID_TRANSITION', { detail: 'solved' });
      const links = linksOf(t);
      if (links.length >= LINKS_MAX) throw new ApiError('INVALID_TRANSITION', { detail: 'too_many_links' });
      // The requester's words: the statement staff wrote down, else the ticket's first message.
      const first = await scope.db
        .selectFrom('admin.support_ticket_messages')
        .select('body')
        .where('ticket_id', '=', t.id)
        .where('author_kind', '=', 'requester')
        .orderBy('created_at')
        .orderBy('id')
        .limit(1)
        .executeTakeFirst();
      const words = b.statement ?? first?.body ?? t.subject;
      const item = await this.convert(scope, t, b, words);
      const row = await scope.db
        .updateTable('admin.support_tickets')
        .set({ linked_items: JSON.stringify([...links, item]) })
        .where('id', '=', t.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeAudit(scope, {
        action: 'support.ticket_converted',
        entityType: 'support_ticket',
        entityId: t.id,
        reason: b.reason,
        next: `${b.into}: ${item.type} ${item.id}`,
        accessPurpose: s.purpose,
      });
      return { ticket: await this.views.one(scope, row, ctx.locale), item };
    });
    return created(body, `/v1/admin/support/tickets/${ctx.params.ticket_id}`);
  }

  private async convert(scope: TxScope, t: TicketRow, b: Conversion, words: string): Promise<LinkedItem> {
    const source = `support ticket ${t.id}`;
    switch (b.into) {
      case 'moderation_case':
        return { type: 'moderation_case', id: await this.openCase(scope, t, b, words) };
      case 'privacy_request':
        return {
          type: 'data_subject_request',
          id: await this.accounts.createDsr(scope, t.requester_user_id, b.request_type!, cut(words, 2000), source),
        };
      case 'dispute': {
        // The ticket's organization raises it with the requester when the requester still acts for it.
        const orgId = t.organization_id && (await this.memberOf(t.requester_user_id, t.organization_id)) ? t.organization_id : null;
        if ([...words.trim()].length < 10) failIf([{ pointer: '/statement', code: 'too_short', limit: '10' }]);
        return {
          type: 'dispute',
          id: await this.trust.raiseDispute(scope, {
            target: b.dispute_target!,
            disputeType: b.dispute_type!,
            userId: t.requester_user_id,
            orgId,
            reason: cut(words, 2000),
          }),
        };
      }
      case 'plan_request': {
        if (!t.organization_id) throw new ApiError('INVALID_TRANSITION', { detail: 'no_organization' });
        const [org, role] = await Promise.all([
          this.organizations.get(t.organization_id),
          this.memberOf(t.requester_user_id, t.organization_id),
        ]);
        // As subscription.change_request (ORG(O+)): only the organization's owner asks for a plan.
        if (!org || !role || !OWNER_ROLES.includes(role)) throw new ApiError('INVALID_TRANSITION', { detail: 'not_owner' });
        return {
          type: 'subscription_change_request',
          id: await this.subscriptions.requestPlanChange(scope, {
            orgId: org.id,
            orgType: org.type,
            userId: t.requester_user_id,
            planKey: b.plan_key!,
            note: cut(words, 1000),
          }),
        };
      }
    }
  }

  private async memberOf(userId: string, orgId: string): Promise<string | null> {
    return (await this.memberships.memberships(userId, 'user')).find((m) => m.orgId === orgId)?.role ?? null;
  }

  /**
   * The requester's report about the target, filed by staff and triaged at once (as admin.report_triage would): into
   * the target's open case, or a new case with the S18 severity floor. Other open reports about the target join it.
   */
  private async openCase(scope: TxScope, t: TicketRow, b: Conversion, words: string): Promise<string> {
    const target = b.case_target!;
    const handler = this.targets.get(target.type);
    if (!handler || !(await handler.exists(scope, target.id))) throw notFoundAt('/case_target/id');
    const existing = await scope.db
      .selectFrom('admin.moderation_cases')
      .select('id')
      .where('target_entity_type', '=', target.type)
      .where('target_entity_id', '=', target.id)
      .where('status', 'in', OPEN_CASE)
      .where('deleted_at', 'is', null)
      .orderBy('id')
      .limit(1)
      .executeTakeFirst();
    const caseId =
      existing?.id ??
      (
        await scope.db
          .insertInto('admin.moderation_cases')
          .values({
            case_type: target.type,
            target_entity_type: target.type,
            target_entity_id: target.id,
            source: 'user_report',
            reason: b.moderation_reason!,
            severity: caseSeverity(b.moderation_reason!, b.severity!),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    const report = await scope.db
      .insertInto('admin.content_reports')
      .values({
        reporter_user_id: t.requester_user_id,
        target_type: target.type,
        target_id: target.id,
        reason: b.moderation_reason!,
        details: cut(words, 2000),
        status: 'triaged',
        moderation_case_id: caseId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await scope.db
      .updateTable('admin.content_reports')
      .set({ status: 'triaged', moderation_case_id: caseId })
      .where('target_type', '=', target.type)
      .where('target_id', '=', target.id)
      .where('status', '=', 'open')
      .where('deleted_at', 'is', null)
      .execute();
    await writeAudit(scope, {
      action: 'moderation.report_triaged',
      entityType: 'content_report',
      entityId: report.id,
      reason: b.reason,
      previous: 'open',
      next: `triaged into case ${caseId} (filed by staff from support ticket ${t.id})`,
    });
    if (target.type === 'review')
      await publishEvent(scope, {
        type: 'review.reported',
        aggregateType: 'review',
        aggregateId: target.id,
        payload: { report_id: report.id, reason: b.moderation_reason },
      });
    return caseId;
  }
}

@Injectable()
@Operation('admin.support_ticket_close')
export class AdminSupportTicketCloseHandler implements OperationHandler {
  constructor(private readonly views: SupportViews) {}

  async handle(ctx: OperationContext<{ outcome: string; resolution_note?: string; reason: string }>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const b = ctx.body;
    const body = await ctx.tx(async (scope) => {
      const t = await loadTicket(scope, ctx.params.ticket_id!, true);
      if (t.status === 'solved') throw new ApiError('INVALID_TRANSITION', { detail: 'solved' });
      if (b.outcome === 'converted' && !linksOf(t).length) throw new ApiError('INVALID_TRANSITION', { detail: 'not_converted' });
      const row = await scope.db
        .updateTable('admin.support_tickets')
        .set({
          status: 'solved',
          outcome: b.outcome,
          solved_at: new Date(),
          solved_by: s.userId,
          resolution_note: b.resolution_note ?? null,
          clock_started_at: null,
        })
        .where('id', '=', t.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeAudit(scope, {
        action: 'support.ticket_solved',
        entityType: 'support_ticket',
        entityId: t.id,
        reason: b.reason,
        previous: t.status,
        next: `solved: ${b.outcome}`,
        accessPurpose: s.purpose,
      });
      await publishEvent(scope, {
        type: 'support.ticket.solved',
        aggregateType: 'support_ticket',
        aggregateId: t.id,
        payload: { ticket_id: t.id, outcome: b.outcome, requester_user_id: t.requester_user_id },
      });
      return this.views.one(scope, row, ctx.locale);
    });
    return { body };
  }
}

/**
 * S25a.T6 (owner decision DQ-23, S24-D8): a ticket waiting on the user without a reply from the requester for
 * NO_RESPONSE_DAYS days (since the last staff message) is solved by the system with outcome no_response, audited with
 * actor system, and the requester gets the support.ticket_solved notice. A constant, not a setting: Docs/23 names no
 * rule for it. The 14-day reopen after solved_at is unchanged, so a late reply still reopens the ticket.
 */
export const NO_RESPONSE_DAYS = 7;
const AUTO_CLOSE_BATCH = 500;

@Injectable()
export class SupportAutoCloseRule extends ScheduledRule {
  readonly name = 'admin.support_auto_close';
  readonly everyMs = 3_600_000;

  constructor(private readonly tx: TxRunner) {
    super();
  }

  async run(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - NO_RESPONSE_DAYS * 86_400_000);
    return this.tx.run({ actorType: 'system' }, async (scope) => {
      const rows = await scope.db
        .updateTable('admin.support_tickets')
        .set({ status: 'solved', outcome: 'no_response', solved_at: now, solved_by: null, clock_started_at: null })
        .where('status', '=', 'waiting_on_user')
        .where('last_message_at', '<=', cutoff)
        .where('deleted_at', 'is', null)
        .where(
          'id',
          'in',
          scope.db
            .selectFrom('admin.support_tickets')
            .select('id')
            .where('status', '=', 'waiting_on_user')
            .where('last_message_at', '<=', cutoff)
            .where('deleted_at', 'is', null)
            .orderBy('last_message_at')
            .limit(AUTO_CLOSE_BATCH),
        )
        .returning(['id', 'requester_user_id'])
        .execute();
      for (const t of rows) {
        await writeAudit(scope, {
          action: 'support.ticket_solved',
          entityType: 'support_ticket',
          entityId: t.id,
          reason: `No reply from the requester for ${NO_RESPONSE_DAYS} days`,
          previous: 'waiting_on_user',
          next: 'solved: no_response (automatic)',
        });
        await publishEvent(scope, {
          type: 'support.ticket.solved',
          aggregateType: 'support_ticket',
          aggregateId: t.id,
          payload: { ticket_id: t.id, outcome: 'no_response', requester_user_id: t.requester_user_id },
        });
      }
      return rows.length;
    });
  }
}
