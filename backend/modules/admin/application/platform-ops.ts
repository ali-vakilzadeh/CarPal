// Feature flags, retention policies and assisted onboarding sessions (40
// §23.2, §23.5; 52 FeatureFlag, DataRetentionPolicy, AssistSession).
// Turning the AI kill switch on is immediate; turning it off again, or
// turning featured.enabled on, waits for a second admin (4EYES). Flag changes
// drop the flag cache of this process at once and publish
// feature_flag.changed so every other process drops its cache too.
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { writeAudit } from '#libs/audit/index.js';
import type { CarpalConfig } from '#libs/config/index.js';
import { ApiError } from '#libs/contract/index.js';
import { FlagService, KILL_SWITCH } from '#libs/flags/index.js';
import { created, Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import { InjectConfig } from '#libs/runtime/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { OrgCards } from '#modules/organization/interface/org-cards.js';
import { toFlag, toRetention, type FlagRow } from '../api/projections.js';
import { FourEyes, ModerationLog, StaffNames, staffOf } from '../interface/admin.js';
import { afterId, pageOf } from './common.js';

type FlagPatch = { enabled?: boolean; targeting?: Record<string, unknown> | null; reason: string };

/** 4EYES(kill switch off, featured.enabled on). */
export function flagNeedsSecondApprover(key: string, current: boolean, next: boolean | undefined): boolean {
  if (next === undefined || next === current) return false;
  return (key === KILL_SWITCH && !next) || (key === 'featured.enabled' && next);
}

/** Applies a flag change (directly, or as the approved four-eyes change). */
export async function applyFlagChange(
  scope: TxScope,
  flags: FlagService,
  row: FlagRow,
  patch: FlagPatch,
  staffId: string,
): Promise<FlagRow> {
  const updated = await scope.db
    .updateTable('admin.feature_flags')
    .set({
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.targeting !== undefined ? { targeting: patch.targeting === null ? null : JSON.stringify(patch.targeting) } : {}),
      updated_by: staffId,
    })
    .where('id', '=', row.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await writeAudit(scope, {
    action: 'admin.flag_updated',
    entityType: 'feature_flag',
    entityId: row.id,
    reason: patch.reason,
    previous: JSON.stringify({ key: row.key, enabled: row.enabled, targeting: row.targeting }).slice(0, 2000),
    next: JSON.stringify({ key: updated.key, enabled: updated.enabled, targeting: updated.targeting }).slice(0, 2000),
  });
  await publishEvent(scope, {
    type: 'feature_flag.changed',
    aggregateType: 'feature_flag',
    aggregateId: row.id,
    payload: { key: row.key, enabled: updated.enabled },
  });
  scope.afterCommit(() => flags.invalidate());
  return updated;
}

@Injectable()
@Operation('admin.flags_list')
export class FlagsListHandler implements OperationHandler {
  constructor(private readonly names: StaffNames) {}

  async handle(ctx: OperationContext<undefined, { flag_type?: string; environment?: string; limit: number }>) {
    staffOf(ctx);
    const q = ctx.query;
    const after = afterId(ctx);
    const body = await ctx.tx(
      async (scope) => {
        let s = scope.db.selectFrom('admin.feature_flags').selectAll().where('deleted_at', 'is', null);
        if (q.flag_type) s = s.where('flag_type', '=', q.flag_type);
        if (q.environment) s = s.where('environment', '=', q.environment);
        if (after) s = s.where('id', '>', after);
        const rows = await s
          .orderBy('id')
          .limit(q.limit + 1)
          .execute();
        const names = await this.names.names(
          scope,
          rows.map((r) => r.updated_by ?? r.created_by),
          ctx.locale,
        );
        return pageOf(
          ctx,
          rows,
          rows.map((r) => toFlag(r, names.get((r.updated_by ?? r.created_by)!) ?? 'CarPal')),
        );
      },
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('admin.flag_update')
export class FlagUpdateHandler implements OperationHandler {
  constructor(
    private readonly flags: FlagService,
    private readonly fourEyes: FourEyes,
    private readonly names: StaffNames,
    @InjectConfig() private readonly config: CarpalConfig,
  ) {}

  async handle(ctx: OperationContext<FlagPatch>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const b = ctx.body;
    return ctx.tx(async (scope) => {
      const row = await scope.db
        .selectFrom('admin.feature_flags')
        .selectAll()
        .where('key', '=', ctx.params.key!)
        .where('environment', '=', this.config.env)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw new ApiError('NOT_FOUND');
      if (ctx.ifMatch !== row.version) throw new ApiError('VERSION_MISMATCH');
      if (flagNeedsSecondApprover(row.key, row.enabled, b.enabled)) {
        const pending = await this.fourEyes.request(
          scope,
          s.userId,
          {
            opId: 'admin.flag_update',
            targetType: 'feature_flag',
            targetId: row.id,
            payload: { key: row.key, ...b },
            summary: `Turn ${row.key} ${b.enabled ? 'on' : 'off'}`,
            reason: b.reason,
            requiredRole: 'platform_admin',
          },
          ctx.locale,
        );
        return { status: 202, body: pending };
      }
      const updated = await applyFlagChange(scope, this.flags, row, b, s.userId);
      return { body: toFlag(updated, await this.names.name(scope, s.userId, ctx.locale)) };
    });
  }
}

@Injectable()
@Operation('admin.retention_list')
export class RetentionListHandler implements OperationHandler {
  async handle(ctx: OperationContext<undefined, { limit: number }>) {
    staffOf(ctx);
    const after = afterId(ctx);
    const body = await ctx.tx(
      async (scope) => {
        let s = scope.db.selectFrom('admin.data_retention_policies').selectAll().where('deleted_at', 'is', null);
        if (after) s = s.where('id', '>', after);
        const rows = await s
          .orderBy('id')
          .limit(ctx.query.limit + 1)
          .execute();
        return pageOf(ctx, rows, rows.map(toRetention));
      },
      { readOnly: true },
    );
    return { body };
  }
}

type RetentionWrite = {
  entity_type: string;
  applies_to_status: string | null;
  retention_days: number;
  action: string;
  legal_basis: string | null;
  status: string;
  reason: string;
};

/** Applies an approved retention change (four-eyes executor of admin.retention_update). */
export async function applyRetentionChange(scope: TxScope, policyId: string, w: RetentionWrite): Promise<void> {
  const before = await scope.db
    .selectFrom('admin.data_retention_policies')
    .selectAll()
    .where('id', '=', policyId)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  if (!before) throw new ApiError('NOT_FOUND', { detail: 'retention policy gone' });
  await scope.db
    .updateTable('admin.data_retention_policies')
    .set({
      entity_type: w.entity_type,
      applies_to_status: w.applies_to_status,
      retention_days: w.retention_days,
      action: w.action,
      legal_basis: w.legal_basis,
      status: w.status,
    })
    .where('id', '=', policyId)
    .execute();
  await writeAudit(scope, {
    action: 'admin.retention_updated',
    entityType: 'data_retention_policy',
    entityId: policyId,
    reason: w.reason,
    previous: JSON.stringify(toRetention(before)),
    next: JSON.stringify({ ...w, reason: undefined }),
  });
}

@Injectable()
@Operation('admin.retention_update')
export class RetentionUpdateHandler implements OperationHandler {
  constructor(private readonly fourEyes: FourEyes) {}

  async handle(ctx: OperationContext<RetentionWrite>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const b = ctx.body;
    const body = await ctx.tx(async (scope) => {
      const p = await scope.db
        .selectFrom('admin.data_retention_policies')
        .select(['id', 'entity_type', 'retention_days', 'action'])
        .where('id', '=', ctx.params.policy_id!)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!p) throw new ApiError('NOT_FOUND');
      return this.fourEyes.request(
        scope,
        s.userId,
        {
          opId: 'admin.retention_update',
          targetType: 'data_retention_policy',
          targetId: p.id,
          payload: { ...b },
          summary: `Retention ${p.entity_type}: ${p.retention_days} d ${p.action} → ${b.retention_days} d ${b.action} (${b.status})`,
          reason: b.reason,
          requiredRole: 'platform_admin',
        },
        ctx.locale,
      );
    });
    return { status: 202, body };
  }
}

const FLOW_TYPES: Record<string, string[]> = {
  provider: ['provider', 'hybrid_provider_vendor'],
  vendor: ['vendor', 'hybrid_provider_vendor'],
  fleet: ['fleet'],
};

@Injectable()
@Operation('admin.assist_session_start')
export class AssistSessionStartHandler implements OperationHandler {
  constructor(
    private readonly orgs: OrgCards,
    private readonly log: ModerationLog,
  ) {}

  async handle(ctx: OperationContext<{ flow_type: 'provider' | 'vendor' | 'fleet'; reason: string }>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const b = ctx.body;
    const orgId = ctx.params.org_id!;
    const body = await ctx.tx(async (scope) => {
      const org = (await this.orgs.cards(scope, [orgId])).get(orgId);
      if (!org || ['merged', 'archived'].includes(org.status)) throw new ApiError('NOT_FOUND');
      if (!FLOW_TYPES[b.flow_type]!.includes(org.organizationType)) throw ApiError.validation([{ pointer: '/flow_type', code: 'enum' }]);
      // An earlier session past its 4 hours no longer blocks a new one (the hourly rule marks it expired).
      await scope.db
        .updateTable('admin.assist_sessions')
        .set({ status: 'expired' })
        .where('organization_id', '=', orgId)
        .where('status', '=', 'active')
        .where('expires_at', '<=', new Date())
        .execute();
      const row = await scope.db
        .insertInto('admin.assist_sessions')
        .values({ organization_id: orgId, flow_type: b.flow_type, staff_user_id: s.userId, reason: b.reason })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.log.record(scope, {
        targetType: 'organization',
        targetId: orgId,
        actionType: 'assist_onboarding',
        reason: b.reason,
        params: { assist_session_id: row.id, step: 'session_started', flow_type: b.flow_type },
        actorUserId: s.userId,
      });
      await writeAudit(scope, {
        action: 'admin.assist_session_started',
        entityType: 'organization',
        entityId: orgId,
        reason: b.reason,
        next: `${b.flow_type} session ${row.id} until ${row.expires_at.toISOString()}`,
      });
      return { assist_session_id: row.id, expires_at: row.expires_at.toISOString() };
    });
    return created(body, `/v1/admin/assist-sessions/${body.assist_session_id}`);
  }
}

@Injectable()
@Operation('admin.assist_session_end')
export class AssistSessionEndHandler implements OperationHandler {
  async handle(ctx: OperationContext<{ reason: string }>): Promise<OperationResult> {
    staffOf(ctx);
    const body = await ctx.tx(async (scope) => {
      const row = await scope.db
        .selectFrom('admin.assist_sessions')
        .selectAll()
        .where('id', '=', ctx.params.assist_session_id!)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw new ApiError('NOT_FOUND');
      if (row.status !== 'active') throw new ApiError('INVALID_TRANSITION', { detail: row.status });
      await scope.db
        .updateTable('admin.assist_sessions')
        .set({ status: 'ended', ended_at: sql<Date>`now()`, end_reason: ctx.body.reason })
        .where('id', '=', row.id)
        .execute();
      await writeAudit(scope, {
        action: 'admin.assist_session_ended',
        entityType: 'organization',
        entityId: row.organization_id,
        reason: ctx.body.reason,
        previous: `session ${row.id} active`,
        next: 'ended',
      });
      return { ok: true as const };
    });
    return { body };
  }
}
