// Four-eyes approvals (40 §23.5 admin.four_eyes_list / four_eyes_decide,
// SEC-ADM-6, 52 PendingAdminChange). A 4EYES operation files a pending change
// (FourEyes.request, in the owning module's handler); a second staff member
// with the required role approves or rejects it here. Approval runs the
// registered executor in the approver's transaction, so the change and its
// approval commit together; the audit entry names the original requester as
// initiator and the caller as approver. Moderators decide moderation changes
// only (required_role platform_moderator).
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { writeAudit } from '#libs/audit/index.js';
import { ApiError } from '#libs/contract/index.js';
import { Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import { pendingStatus, toPendingChange, type PendingChangeRow } from '../api/projections.js';
import { FourEyesExecutors, StaffNames, staffOf, type Staff } from '../interface/admin.js';
import { afterId, pageOf } from './common.js';

const isAdmin = (s: Staff) => s.roles.includes('platform_admin');

@Injectable()
@Operation('admin.four_eyes_list')
export class FourEyesListHandler implements OperationHandler {
  constructor(private readonly names: StaffNames) {}

  async handle(ctx: OperationContext<undefined, { status?: string; limit: number }>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const status = ctx.query.status ?? 'pending';
    const after = afterId(ctx);
    const body = await ctx.tx(
      async (scope) => {
        // Never the caller's own changes; moderators see moderation changes only.
        let q = scope.db
          .selectFrom('admin.pending_admin_changes')
          .selectAll()
          .where('requested_by', '<>', s.userId)
          .where('deleted_at', 'is', null);
        if (!isAdmin(s)) q = q.where('required_role', '=', 'platform_moderator');
        if (status === 'pending') q = q.where('status', '=', 'pending').where('expires_at', '>', new Date());
        else if (status === 'expired')
          q = q.where((eb) =>
            eb.or([eb('status', '=', 'expired'), eb.and([eb('status', '=', 'pending'), eb('expires_at', '<=', new Date())])]),
          );
        else q = q.where('status', '=', status);
        if (after) q = q.where('id', '<', after);
        const rows = await q
          .orderBy('id', 'desc')
          .limit(ctx.query.limit + 1)
          .execute();
        const names = await this.names.names(
          scope,
          rows.map((r) => r.requested_by),
          ctx.locale,
        );
        return pageOf(
          ctx,
          rows,
          rows.map((r) => toPendingChange(r, names.get(r.requested_by)!)),
        );
      },
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('admin.four_eyes_decide')
export class FourEyesDecideHandler implements OperationHandler {
  constructor(
    private readonly executors: FourEyesExecutors,
    private readonly names: StaffNames,
  ) {}

  async handle(ctx: OperationContext<{ decision: 'approve' | 'reject'; reason: string }>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const b = ctx.body;
    const body = await ctx.tx(async (scope) => {
      const c = (await scope.db
        .selectFrom('admin.pending_admin_changes')
        .selectAll()
        .where('id', '=', ctx.params.change_id!)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst()) as PendingChangeRow | undefined;
      // STF(ADM, MOD: moderation changes only): a moderator cannot see admin changes.
      if (!c || (!isAdmin(s) && c.required_role !== 'platform_moderator')) throw new ApiError('NOT_FOUND');
      if (c.requested_by === s.userId) throw new ApiError('SELF_APPROVAL_FORBIDDEN', { detail: 'own change' });
      const status = pendingStatus(c);
      if (status === 'expired') throw new ApiError('INVALID_TRANSITION', { detail: 'expired' });
      if (status !== 'pending') throw new ApiError('INVALID_TRANSITION', { detail: status });
      if (b.decision === 'approve') {
        const executor = this.executors.get(c.op_id);
        if (!executor) throw new ApiError('INTERNAL', { detail: `no four-eyes executor for ${c.op_id}` });
        await executor(scope, {
          id: c.id,
          opId: c.op_id,
          targetType: c.target_entity_type,
          targetId: c.target_entity_id,
          payload: c.request_payload as Record<string, unknown>,
          reason: c.reason,
          requestedBy: c.requested_by,
          approvedBy: s.userId,
          decisionReason: b.reason,
          requestId: ctx.requestId,
        });
      }
      const row = (await scope.db
        .updateTable('admin.pending_admin_changes')
        .set({
          status: b.decision === 'approve' ? 'approved' : 'rejected',
          decided_by: s.userId,
          decision_reason: b.reason,
          decided_at: sql<Date>`now()`,
        })
        .where('id', '=', c.id)
        .returningAll()
        .executeTakeFirstOrThrow()) as PendingChangeRow;
      await writeAudit(scope, {
        action: b.decision === 'approve' ? 'admin.four_eyes_approved' : 'admin.four_eyes_rejected',
        entityType: c.target_entity_type,
        entityId: c.target_entity_id,
        reason: b.reason,
        previous: `${c.op_id} requested by ${c.requested_by}: ${c.reason}`.slice(0, 2000),
        next: `${row.status} by ${s.userId} (change ${c.id})`,
      });
      return toPendingChange(row, await this.names.name(scope, c.requested_by, ctx.locale));
    });
    return { body };
  }
}
