// Disputes and mediation requests (40 §15.3, 52 Dispute). A party raises one
// about a review, an appointment or a badge it is part of; outcomes are
// decided by CarPal staff (admin.dispute_resolve) and feed trust signals. A
// service record is disputed by its vehicle owner or provider of record, a
// moderation action by the user or organization it affected (S8). Moderator
// notes and the assignee never leave the server.
import { Injectable } from '@nestjs/common';
import { ApiError } from '#libs/contract/index.js';
import { created, Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { ModerationLog } from '#modules/admin/interface/admin.js';
import { AppointmentFacts } from '#modules/appointment/interface/appointments.js';
import { VehicleCards } from '#modules/vehicle/interface/vehicles.js';
import { toDispute, type DisputeRow } from '../api/projections.js';
import { afterId, failIf, notFoundAt, pageOf, signedIn } from './common.js';

type DisputeCreate = {
  target: { type: 'review' | 'service_record' | 'badge' | 'appointment' | 'moderation_action'; id: string };
  dispute_type: string;
  reason: string;
  raised_by_organization_id?: string;
};

const TYPES_BY_TARGET: Record<string, string[]> = {
  review: ['fake_review', 'inaccurate_review', 'mediation_request'],
  appointment: ['mediation_request'],
  badge: ['badge_challenge'],
  service_record: ['service_record_dispute', 'mediation_request'],
  moderation_action: ['moderation_appeal'],
};

@Injectable()
@Operation('disputes.create')
export class DisputesCreateHandler implements OperationHandler {
  constructor(
    private readonly appointments: AppointmentFacts,
    private readonly vehicles: VehicleCards,
    private readonly moderation: ModerationLog,
  ) {}

  async handle(ctx: OperationContext<DisputeCreate>): Promise<OperationResult> {
    const c = signedIn(ctx);
    const b = ctx.body;
    if (!(TYPES_BY_TARGET[b.target.type] ?? []).includes(b.dispute_type)) failIf([{ pointer: '/dispute_type', code: 'enum' }]);
    if ([...b.reason.trim()].length < 10) failIf([{ pointer: '/reason', code: 'too_short', limit: '10' }]);
    // The caller must be a member of the raising organization (40 DisputeCreate).
    const org = b.raised_by_organization_id ? await ctx.authorizeOrg(b.raised_by_organization_id, ['ANY']) : null;
    const body = await ctx.tx(async (scope) => {
      if (org) await scope.setOrganization(org.id, org.role);
      await this.requireParty(scope, b.target, c.userId, org?.id ?? null);
      const row = await scope.db
        .insertInto('trust.disputes')
        .values({
          target_entity_type: b.target.type,
          target_entity_id: b.target.id,
          dispute_type: b.dispute_type,
          raised_by_user_id: c.userId,
          raised_by_organization_id: org?.id ?? null,
          reason: b.reason,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      // A review reported by its subject shows as reported in the inbox (RLS subject_answer lets the subject set it).
      if (b.target.type === 'review' && org)
        await scope.db
          .updateTable('trust.reviews')
          .set({ report_status: 'reported' })
          .where('id', '=', b.target.id)
          .where('subject_organization_id', '=', org.id)
          .where('report_status', '=', 'none')
          .execute();
      await publishEvent(scope, {
        type: 'dispute.opened',
        aggregateType: 'dispute',
        aggregateId: row.id,
        payload: { target_type: row.target_entity_type, target_id: row.target_entity_id, dispute_type: row.dispute_type },
      });
      return toDispute(row);
    });
    return created(body, `/v1/disputes/${body.id}`);
  }

  /** The caller (or its organization) must be a party of the target. */
  private async requireParty(scope: TxScope, t: DisputeCreate['target'], userId: string, orgId: string | null): Promise<void> {
    if (t.type === 'review') {
      const r = await scope.db
        .selectFrom('trust.reviews')
        .select(['author_user_id', 'subject_organization_id'])
        .where('id', '=', t.id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!r || !(r.author_user_id === userId || (orgId && r.subject_organization_id === orgId))) throw notFoundAt('/target/id');
      return;
    }
    if (t.type === 'appointment') {
      const a = (await this.appointments.visits(scope, [t.id])).get(t.id);
      const party = a && (orgId ? a.providerOrgId === orgId || a.requesterOrgId === orgId : a.requesterUserId === userId);
      if (!party) throw notFoundAt('/target/id');
      return;
    }
    if (t.type === 'badge') {
      const b = await scope.db
        .selectFrom('trust.provider_badges')
        .select('provider_organization_id')
        .where('id', '=', t.id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      // Public badges can be challenged by anyone signed in (badge_challenge); private ones only by their provider.
      if (!b) throw notFoundAt('/target/id');
      return;
    }
    if (t.type === 'service_record') {
      const p = await this.vehicles.serviceRecordParties(scope, t.id);
      const party =
        p &&
        (orgId
          ? p.providerOrgId === orgId || (p.ownerType === 'organization' && p.ownerId === orgId)
          : p.ownerType === 'user' && p.ownerId === userId);
      if (!party) throw notFoundAt('/target/id');
      return;
    }
    // Moderation actions are staff records: only the parties they affected may appeal (definer, no other fields).
    const a = await this.moderation.affects(scope, t.id);
    const affected = a && (orgId ? a.organizationId === orgId : a.userId === userId);
    if (!affected) throw notFoundAt('/target/id');
  }
}

async function loadMine(scope: TxScope, userId: string, id: string, lock = false): Promise<DisputeRow> {
  const q = scope.db.selectFrom('trust.disputes').selectAll().where('id', '=', id).where('deleted_at', 'is', null);
  const row = await (lock ? q.forUpdate() : q).executeTakeFirst();
  // RLS raiser_all: the raiser or the raising organization (when it is the context organization).
  if (!row || (row.raised_by_user_id !== userId && !row.raised_by_organization_id)) throw new ApiError('NOT_FOUND');
  return row;
}

@Injectable()
@Operation('disputes.mine_list')
export class DisputesMineListHandler implements OperationHandler {
  async handle(ctx: OperationContext<undefined, { organization_id?: string; status?: string; limit: number }>): Promise<OperationResult> {
    const c = signedIn(ctx);
    const after = afterId(ctx);
    // Disputes of an organization: its owners and managers (40 disputes.mine_list).
    const org = ctx.query.organization_id ? await ctx.authorizeOrg(ctx.query.organization_id, ['P+', 'V+', 'F+']) : null;
    const body = await ctx.tx(
      async (scope) => {
        if (org) await scope.setOrganization(org.id, org.role);
        let q = scope.db.selectFrom('trust.disputes').selectAll().where('deleted_at', 'is', null);
        q = org ? q.where('raised_by_organization_id', '=', org.id) : q.where('raised_by_user_id', '=', c.userId);
        if (ctx.query.status) q = q.where('status', '=', ctx.query.status);
        if (after) q = q.where('id', '<', after);
        const rows = await q
          .orderBy('id', 'desc')
          .limit(ctx.query.limit + 1)
          .execute();
        return pageOf(ctx, rows, rows.slice(0, ctx.query.limit).map(toDispute));
      },
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('disputes.get')
export class DisputesGetHandler implements OperationHandler {
  async handle(ctx: OperationContext): Promise<OperationResult> {
    const c = signedIn(ctx);
    const body = await ctx.tx(async (scope) => toDispute(await loadMine(scope, c.userId, ctx.params.dispute_id!)), { readOnly: true });
    return { body };
  }
}

@Injectable()
@Operation('disputes.withdraw')
export class DisputesWithdrawHandler implements OperationHandler {
  async handle(ctx: OperationContext): Promise<OperationResult> {
    const c = signedIn(ctx);
    const body = await ctx.tx(async (scope) => {
      const d = await loadMine(scope, c.userId, ctx.params.dispute_id!, true);
      // Only the person who raised it withdraws it.
      if (d.raised_by_user_id !== c.userId) throw new ApiError('NOT_FOUND');
      if (!['open', 'in_mediation'].includes(d.status)) throw new ApiError('INVALID_TRANSITION', { detail: d.status });
      const row = await scope.db
        .updateTable('trust.disputes')
        .set({ status: 'withdrawn' })
        .where('id', '=', d.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return toDispute(row);
    });
    return { body };
  }
}
