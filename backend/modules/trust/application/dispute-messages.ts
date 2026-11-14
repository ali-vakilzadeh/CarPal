// Dispute message threads (backend S20, admin console BR-28; 40 §15.3, §23.4; 52 DisputeMessage; Docs/23 A-DSP-01).
// One thread per party: the raiser's (the person or organization that raised the dispute) and the respondent's (the
// other party of the target, recorded when staff first write to it). Staff write templated messages on the admin
// plane; each party reads only its own thread, sees "CarPal" for staff, and replies with evidence files attached to
// its message. Messages are append-only; a dispute that is resolved or withdrawn takes no more messages.
import { Injectable } from '@nestjs/common';
import type { Selectable } from 'kysely';
import { writeAudit } from '#libs/audit/index.js';
import { ApiError } from '#libs/contract/index.js';
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
import { publishEvent } from '#libs/outbox/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { auditStaffRead, StaffNames, staffOf } from '#modules/admin/interface/admin.js';
import { AppointmentFacts } from '#modules/appointment/interface/appointments.js';
import { MediaService, type MediaAttachmentView } from '#modules/media/interface/media.js';
import { VehicleCards } from '#modules/vehicle/interface/vehicles.js';
import type { DisputeRow } from '../api/projections.js';
import { failIf, signedIn } from './common.js';

export type DisputeSide = 'raiser' | 'respondent';
type MessageRow = Selectable<DB['trust.dispute_messages']>;

const OPEN = ['open', 'in_mediation'];
/** 40 DisputeThread.items: at most 200 messages per side; StaffDisputeMessage list: both sides. */
const THREAD_MAX = 200;
const STAFF_LABEL = 'CarPal';
const REPLY_DUE_MAX_MS = 30 * 86_400_000;
/** Evidence a party may attach (its own clean files). */
const EVIDENCE_PURPOSES = ['review_evidence', 'service_evidence', 'review_photo'] as const;

export interface DisputeParty {
  type: 'user' | 'organization';
  id: string;
}

/**
 * The other party of a dispute's target (40 StaffDisputeDetail.respondent): the side of the target the raiser is not
 * on. Null for moderation appeals (CarPal decided) and when the target or its other party is gone. Staff context.
 */
@Injectable()
export class DisputeParties {
  constructor(
    private readonly appointments: AppointmentFacts,
    private readonly vehicles: VehicleCards,
  ) {}

  async respondentOf(scope: TxScope, d: DisputeRow): Promise<DisputeParty | null> {
    const raiserOrg = d.raised_by_organization_id;
    const user = (id: string | null | undefined): DisputeParty | null => (id ? { type: 'user', id } : null);
    const org = (id: string | null | undefined): DisputeParty | null => (id && id !== raiserOrg ? { type: 'organization', id } : null);
    switch (d.target_entity_type) {
      case 'review': {
        const r = await scope.db
          .selectFrom('trust.reviews')
          .select(['author_user_id', 'subject_organization_id'])
          .where('id', '=', d.target_entity_id)
          .executeTakeFirst();
        if (!r) return null;
        // The business raised it (fake, inaccurate, objection): the author answers; the author raised it: the business.
        return raiserOrg === r.subject_organization_id ? user(r.author_user_id) : org(r.subject_organization_id);
      }
      case 'badge': {
        const b = await scope.db
          .selectFrom('trust.provider_badges')
          .select('provider_organization_id')
          .where('id', '=', d.target_entity_id)
          .executeTakeFirst();
        return org(b?.provider_organization_id);
      }
      case 'appointment': {
        const a = (await this.appointments.visits(scope, [d.target_entity_id])).get(d.target_entity_id);
        if (!a) return null;
        if (raiserOrg && raiserOrg === a.providerOrgId) return a.requesterOrgId ? org(a.requesterOrgId) : user(a.requesterUserId);
        return org(a.providerOrgId);
      }
      case 'service_record': {
        const p = await this.vehicles.serviceRecordParties(scope, d.target_entity_id);
        if (!p) return null;
        if (raiserOrg && raiserOrg === p.providerOrgId) return p.ownerType === 'user' ? user(p.ownerId) : org(p.ownerId);
        return org(p.providerOrgId);
      }
      default:
        return null;
    }
  }
}

/** The caller's side of a dispute: as the raiser (or the raising organization), or as the recorded respondent. */
export function sideOf(d: DisputeRow, userId: string, orgId: string | null): DisputeSide | null {
  if (orgId) {
    if (d.raised_by_organization_id === orgId) return 'raiser';
    if (d.respondent_organization_id === orgId) return 'respondent';
    return null;
  }
  if (d.raised_by_user_id === userId) return 'raiser';
  if (d.respondent_user_id === userId) return 'respondent';
  return null;
}

/** 40 DisputeMessage (staff names never reach the parties). */
function toMessage(m: MessageRow, authorDisplay: string, media: MediaAttachmentView[]) {
  return {
    id: m.id,
    side: m.side as DisputeSide,
    author: m.author_kind as 'staff' | 'party',
    author_display: m.author_kind === 'staff' ? STAFF_LABEL : authorDisplay,
    template_key: m.template_key,
    body: m.body,
    media: media.filter((x) => x.role === 'evidence').slice(0, 5),
    reply_due_at: isoOrNull(m.reply_due_at),
    created_at: iso(m.created_at),
  };
}

/** Thread messages with author names and evidence, oldest first. */
async function views(scope: TxScope, rows: MessageRow[], names: StaffNames, media: MediaService, locale: string) {
  const [display, files] = await Promise.all([
    names.names(
      scope,
      rows.map((m) => m.author_user_id),
      locale,
    ),
    rows.some((m) => m.author_kind === 'party')
      ? media.attachmentViews(
          scope,
          'dispute_message',
          rows.filter((m) => m.author_kind === 'party').map((m) => m.id),
        )
      : Promise.resolve(new Map<string, MediaAttachmentView[]>()),
  ]);
  return rows.map((m) => ({ row: m, name: display.get(m.author_user_id) ?? STAFF_LABEL, files: files.get(m.id) ?? [] }));
}

const sideCount = async (scope: TxScope, disputeId: string, side: DisputeSide): Promise<number> =>
  Number(
    (
      await scope.db
        .selectFrom('trust.dispute_messages')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('dispute_id', '=', disputeId)
        .where('side', '=', side)
        .executeTakeFirstOrThrow()
    ).n,
  );

const PARTY_ORG_GROUPS = ['P+', 'V+', 'F+'];

async function loadParty(ctx: OperationContext, scope: TxScope, userId: string, orgId: string | null) {
  // RLS: raiser_all (the raiser, the raising organization) or respondent_read (the recorded respondent).
  const d = await scope.db
    .selectFrom('trust.disputes')
    .selectAll()
    .where('id', '=', ctx.params.dispute_id!)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  const side = d ? sideOf(d, userId, orgId) : null;
  if (!d || !side) throw new ApiError('NOT_FOUND');
  return { d, side };
}

@Injectable()
@Operation('disputes.messages_list')
export class DisputesMessagesListHandler implements OperationHandler {
  constructor(
    private readonly names: StaffNames,
    private readonly media: MediaService,
  ) {}

  async handle(ctx: OperationContext<undefined, { organization_id?: string }>): Promise<OperationResult> {
    const c = signedIn(ctx);
    const org = ctx.query.organization_id ? await ctx.authorizeOrg(ctx.query.organization_id, PARTY_ORG_GROUPS) : null;
    const body = await ctx.tx(
      async (scope) => {
        if (org) await scope.setOrganization(org.id, org.role);
        const { d, side } = await loadParty(ctx, scope, c.userId, org?.id ?? null);
        const rows = await scope.db
          .selectFrom('trust.dispute_messages')
          .selectAll()
          .where('dispute_id', '=', d.id)
          .where('side', '=', side)
          .orderBy('created_at')
          .orderBy('id')
          .limit(THREAD_MAX)
          .execute();
        const items = (await views(scope, rows, this.names, this.media, ctx.locale)).map((v) => toMessage(v.row, v.name, v.files));
        const due = [...rows].reverse().find((m) => m.author_kind === 'staff' && m.reply_due_at);
        return {
          dispute_id: d.id,
          dispute_type: d.dispute_type,
          target: { type: d.target_entity_type, id: d.target_entity_id },
          status: d.status,
          side,
          can_reply: OPEN.includes(d.status),
          reply_due_at: isoOrNull(due?.reply_due_at ?? null),
          items,
        };
      },
      { readOnly: true },
    );
    return { body };
  }
}

type Reply = { body: string; media_ids?: string[]; organization_id?: string };

@Injectable()
@Operation('disputes.message_post')
export class DisputesMessagePostHandler implements OperationHandler {
  constructor(
    private readonly names: StaffNames,
    private readonly media: MediaService,
  ) {}

  async handle(ctx: OperationContext<Reply>): Promise<OperationResult> {
    const c = signedIn(ctx);
    const b = ctx.body;
    if (!b.body.trim()) failIf([{ pointer: '/body', code: 'too_short', limit: '1' }]);
    const org = b.organization_id ? await ctx.authorizeOrg(b.organization_id, PARTY_ORG_GROUPS) : null;
    const body = await ctx.tx(async (scope) => {
      if (org) await scope.setOrganization(org.id, org.role);
      const { d, side } = await loadParty(ctx, scope, c.userId, org?.id ?? null);
      if (!OPEN.includes(d.status)) throw new ApiError('INVALID_TRANSITION', { detail: 'closed' });
      if ((await sideCount(scope, d.id, side)) >= THREAD_MAX) throw new ApiError('INVALID_TRANSITION', { detail: 'thread_full' });
      // RLS party_insert re-checks the side and the open status.
      const row = await scope.db
        .insertInto('trust.dispute_messages')
        .values({
          dispute_id: d.id,
          side,
          author_kind: 'party',
          author_user_id: c.userId,
          author_organization_id: org?.id ?? null,
          body: b.body,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      if (b.media_ids?.length)
        // Evidence: the party's own clean files, visible to the party and CarPal staff (MediaAttachment role evidence).
        await this.media.syncAttachments(scope, [...new Set(b.media_ids)], {
          type: 'dispute_message',
          id: row.id,
          role: 'evidence',
          owner: org ? { type: 'organization', id: org.id } : { type: 'user', id: c.userId },
          purposes: EVIDENCE_PURPOSES,
          pointer: '/media_ids',
        });
      await publishEvent(scope, {
        type: 'dispute.message.posted',
        aggregateType: 'dispute',
        aggregateId: d.id,
        payload: { dispute_id: d.id, message_id: row.id, side, author: 'party', dispute_type: d.dispute_type },
      });
      const [v] = await views(scope, [row], this.names, this.media, ctx.locale);
      return toMessage(v!.row, v!.name, v!.files);
    });
    return created(body, `/v1/disputes/${ctx.params.dispute_id}/messages/${body.id}`);
  }
}

/** 40 StaffDisputeMessage: the party's view plus the staff member who wrote it. */
function toStaffMessage(m: MessageRow, name: string, files: MediaAttachmentView[]) {
  return { ...toMessage(m, name, files), staff_author_display: m.author_kind === 'staff' ? name : null };
}

async function loadStaffDispute(scope: TxScope, id: string, lock = false): Promise<DisputeRow> {
  const q = scope.db.selectFrom('trust.disputes').selectAll().where('id', '=', id).where('deleted_at', 'is', null);
  const d = await (lock ? q.forUpdate() : q).executeTakeFirst();
  if (!d) throw new ApiError('NOT_FOUND');
  return d;
}

@Injectable()
@Operation('admin.dispute_messages_list')
export class AdminDisputeMessagesListHandler implements OperationHandler {
  constructor(
    private readonly names: StaffNames,
    private readonly media: MediaService,
  ) {}

  async handle(ctx: OperationContext<undefined, { side?: DisputeSide }>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const body = await ctx.tx(async (scope) => {
      const d = await loadStaffDispute(scope, ctx.params.dispute_id!);
      await auditStaffRead(scope, s, 'dispute', d.id, 'dispute messages');
      let q = scope.db.selectFrom('trust.dispute_messages').selectAll().where('dispute_id', '=', d.id);
      if (ctx.query.side) q = q.where('side', '=', ctx.query.side);
      const rows = await q
        .orderBy('created_at')
        .orderBy('id')
        .limit(2 * THREAD_MAX)
        .execute();
      return { items: (await views(scope, rows, this.names, this.media, ctx.locale)).map((v) => toStaffMessage(v.row, v.name, v.files)) };
    });
    return { body };
  }
}

type StaffWrite = { side: DisputeSide; template_key: string; body: string; reply_due_at?: string; reason: string };

@Injectable()
@Operation('admin.dispute_message_post')
export class AdminDisputeMessagePostHandler implements OperationHandler {
  constructor(
    private readonly names: StaffNames,
    private readonly media: MediaService,
    private readonly parties: DisputeParties,
  ) {}

  async handle(ctx: OperationContext<StaffWrite>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const b = ctx.body;
    if (!b.body.trim()) failIf([{ pointer: '/body', code: 'too_short', limit: '1' }]);
    if (b.reply_due_at) {
      const due = Date.parse(b.reply_due_at);
      if (due <= Date.now()) failIf([{ pointer: '/reply_due_at', code: 'in_past' }]);
      if (due > Date.now() + REPLY_DUE_MAX_MS) failIf([{ pointer: '/reply_due_at', code: 'out_of_range', limit: '30 days' }]);
    }
    const body = await ctx.tx(async (scope) => {
      const d = await loadStaffDispute(scope, ctx.params.dispute_id!, true);
      if (!OPEN.includes(d.status)) throw new ApiError('INVALID_TRANSITION', { detail: 'closed' });
      let recipient: DisputeParty | null =
        b.side === 'raiser'
          ? d.raised_by_organization_id
            ? { type: 'organization', id: d.raised_by_organization_id }
            : { type: 'user', id: d.raised_by_user_id }
          : d.respondent_user_id
            ? { type: 'user', id: d.respondent_user_id }
            : d.respondent_organization_id
              ? { type: 'organization', id: d.respondent_organization_id }
              : null;
      if (b.side === 'respondent' && !recipient) {
        // The first message to the other party records it: from then on it can read and answer its thread (RLS).
        recipient = await this.parties.respondentOf(scope, d);
        if (!recipient) throw new ApiError('INVALID_TRANSITION', { detail: 'no_respondent' });
        await scope.db
          .updateTable('trust.disputes')
          .set(recipient.type === 'user' ? { respondent_user_id: recipient.id } : { respondent_organization_id: recipient.id })
          .where('id', '=', d.id)
          .execute();
      }
      if ((await sideCount(scope, d.id, b.side)) >= THREAD_MAX) throw new ApiError('INVALID_TRANSITION', { detail: 'thread_full' });
      const row = await scope.db
        .insertInto('trust.dispute_messages')
        .values({
          dispute_id: d.id,
          side: b.side,
          author_kind: 'staff',
          author_user_id: s.userId,
          template_key: b.template_key,
          body: b.body,
          reply_due_at: b.reply_due_at ? new Date(b.reply_due_at) : null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeAudit(scope, {
        action: 'dispute.message_posted',
        entityType: 'dispute',
        entityId: d.id,
        reason: b.reason,
        next: `${b.side}: ${b.template_key}`,
        accessPurpose: s.purpose,
      });
      // The party is notified (W5): the raiser, the raising organization's managers, or the respondent.
      await publishEvent(scope, {
        type: 'dispute.message.posted',
        aggregateType: 'dispute',
        aggregateId: d.id,
        payload: {
          dispute_id: d.id,
          message_id: row.id,
          side: b.side,
          author: 'staff',
          dispute_type: d.dispute_type,
          template_key: b.template_key,
          ...(recipient!.type === 'user' ? { user_id: recipient!.id } : { organization_id: recipient!.id }),
        },
      });
      return toStaffMessage(row, await this.names.name(scope, s.userId, ctx.locale), []);
    });
    return created(body, `/v1/admin/disputes/${ctx.params.dispute_id}/messages/${body.id}`);
  }
}
