// Feature flags, retention policies and assisted onboarding sessions (with their list, backend S19) (40
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
import { toJobView } from '#libs/jobs/index.js';
import { ExchangeRates, RegionConfigService } from '#libs/region-config/index.js';
import { InjectConfig } from '#libs/runtime/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { OrgCards, toOrgSummary } from '#modules/organization/interface/org-cards.js';
import { toExchangeRate, toFlag, toRetention, type ExchangeRateRow, type FlagRow } from '../api/projections.js';
import { uuidv7 } from '#libs/crypto/index.js';
import {
  FourEyes,
  ModerationLog,
  retentionCutoff,
  RetentionHandlers,
  StaffNames,
  staffOf,
  type RetentionPolicyRecord,
} from '../interface/admin.js';
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

type RatePatch = { per_usd: string; reason: string };

/** 4EYES(change over 20 %): a mistyped rate would misprice every amount shown to everybody. */
export function rateNeedsSecondApprover(current: string, next: string): boolean {
  return Math.abs(Number(next) - Number(current)) / Number(current) > 0.2;
}

/** Applies a rate change (directly, or as the approved four-eyes change). */
export async function applyExchangeRateChange(
  scope: TxScope,
  rates: ExchangeRates,
  row: ExchangeRateRow,
  patch: RatePatch,
  staffId: string,
): Promise<ExchangeRateRow> {
  const updated = await scope.db
    .updateTable('admin.exchange_rates')
    .set({ per_usd: patch.per_usd, reason: patch.reason, updated_by: staffId })
    .where('id', '=', row.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await writeAudit(scope, {
    action: 'admin.exchange_rate_updated',
    entityType: 'exchange_rate',
    entityId: row.id,
    reason: patch.reason,
    previous: JSON.stringify({ currency: row.currency, per_usd: row.per_usd }),
    next: JSON.stringify({ currency: updated.currency, per_usd: updated.per_usd }),
  });
  await publishEvent(scope, {
    type: 'exchange_rate.changed',
    aggregateType: 'exchange_rate',
    aggregateId: row.id,
    payload: { currency: row.currency, per_usd: String(updated.per_usd) },
  });
  scope.afterCommit(() => rates.invalidate());
  return updated;
}

@Injectable()
@Operation('admin.exchange_rates_list')
export class ExchangeRatesListHandler implements OperationHandler {
  constructor(private readonly names: StaffNames) {}

  async handle(ctx: OperationContext) {
    staffOf(ctx);
    const body = await ctx.tx(
      async (scope) => {
        const rows = await scope.db
          .selectFrom('admin.exchange_rates')
          .selectAll()
          .where('deleted_at', 'is', null)
          .orderBy('currency')
          .limit(10)
          .execute();
        const names = await this.names.names(
          scope,
          rows.map((r) => r.updated_by ?? r.created_by),
          ctx.locale,
        );
        return { items: rows.map((r) => toExchangeRate(r, names.get((r.updated_by ?? r.created_by)!) ?? 'CarPal')) };
      },
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('admin.exchange_rate_update')
export class ExchangeRateUpdateHandler implements OperationHandler {
  constructor(
    private readonly rates: ExchangeRates,
    private readonly fourEyes: FourEyes,
    private readonly names: StaffNames,
  ) {}

  async handle(ctx: OperationContext<RatePatch>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const b = ctx.body;
    if (!(Number(b.per_usd) > 0)) throw ApiError.validation([{ pointer: '/per_usd', code: 'out_of_range' }]);
    return ctx.tx(async (scope) => {
      const row = await scope.db
        .selectFrom('admin.exchange_rates')
        .selectAll()
        .where('currency', '=', ctx.params.currency!)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw new ApiError('NOT_FOUND');
      if (ctx.ifMatch !== row.version) throw new ApiError('VERSION_MISMATCH');
      if (rateNeedsSecondApprover(String(row.per_usd), b.per_usd)) {
        const pending = await this.fourEyes.request(
          scope,
          s.userId,
          {
            opId: 'admin.exchange_rate_update',
            targetType: 'exchange_rate',
            targetId: row.id,
            payload: { currency: row.currency, ...b },
            summary: `Set ${row.currency} per USD to ${b.per_usd}`,
            reason: b.reason,
            requiredRole: 'platform_admin',
          },
          ctx.locale,
        );
        return { status: 202, body: pending };
      }
      const updated = await applyExchangeRateChange(scope, this.rates, row, b, s.userId);
      return { body: toExchangeRate(updated, await this.names.name(scope, s.userId, ctx.locale)) };
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

/** 52 entity names: an upper-case letter, then letters and digits (e.g. "MediaAsset"). */
const ENTITY_NAME = /^[A-Z][A-Za-z0-9]{0,59}$/u;

/** Is a policy for this entity type and status already there, or asked for and still pending? */
async function retentionTaken(scope: TxScope, entityType: string, status: string | null): Promise<boolean> {
  if (await policyExists(scope, entityType, status)) return true;
  const pending = await scope.db
    .selectFrom('admin.pending_admin_changes')
    .select('id')
    .where('op_id', '=', 'admin.retention_create')
    .where('status', '=', 'pending')
    .where('expires_at', '>', new Date())
    .where('deleted_at', 'is', null)
    .where(sql<boolean>`request_payload->>'entity_type' = ${entityType}`)
    .where(sql<boolean>`request_payload->>'applies_to_status' IS NOT DISTINCT FROM ${status}`)
    .executeTakeFirst();
  return !!pending;
}

/**
 * 40 admin.retention_create (backend S21, BR-25): a new policy waits for a second administrator (4EYES). The pending
 * change targets the id the policy will get, so its audit entries and the policy's share one id. A delete or
 * anonymize policy needs a module that applies the entity type; an archive policy keeps records and may name any entity.
 */
@Injectable()
@Operation('admin.retention_create')
export class RetentionCreateHandler implements OperationHandler {
  constructor(
    private readonly fourEyes: FourEyes,
    private readonly handlers: RetentionHandlers,
  ) {}

  async handle(ctx: OperationContext<RetentionWrite>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const b = ctx.body;
    if (!ENTITY_NAME.test(b.entity_type) || (b.action !== 'archive' && !this.handlers.get(b.entity_type)))
      throw ApiError.validation([{ pointer: '/entity_type', code: 'enum' }]);
    const body = await ctx.tx(async (scope) => {
      if (await retentionTaken(scope, b.entity_type, b.applies_to_status ?? null))
        throw new ApiError('DUPLICATE', { detail: 'entity_type' });
      return this.fourEyes.request(
        scope,
        s.userId,
        {
          opId: 'admin.retention_create',
          targetType: 'data_retention_policy',
          targetId: uuidv7(),
          payload: { ...b, applies_to_status: b.applies_to_status ?? null },
          summary:
            `New retention policy ${b.entity_type}${b.applies_to_status ? ` (${b.applies_to_status})` : ''}: ${b.retention_days} d ${b.action} (${b.status})`.slice(
              0,
              1000,
            ),
          reason: b.reason,
          requiredRole: 'platform_admin',
        },
        ctx.locale,
      );
    });
    return { status: 202, body };
  }
}

/** Creates an approved retention policy (four-eyes executor of admin.retention_create) with the pending change's target id. */
export async function applyRetentionCreate(scope: TxScope, policyId: string, w: RetentionWrite): Promise<void> {
  const status = w.applies_to_status ?? null;
  if (await policyExists(scope, w.entity_type, status)) throw new ApiError('DUPLICATE', { detail: 'entity_type' });
  await scope.db
    .insertInto('admin.data_retention_policies')
    .values({
      id: policyId,
      entity_type: w.entity_type,
      applies_to_status: status,
      retention_days: w.retention_days,
      action: w.action,
      legal_basis: w.legal_basis,
      status: w.status,
    })
    .execute();
  await writeAudit(scope, {
    action: 'admin.retention_created',
    entityType: 'data_retention_policy',
    entityId: policyId,
    reason: w.reason,
    next: JSON.stringify({ ...w, reason: undefined }),
  });
}

/** UNIQUE NULLS NOT DISTINCT (entity_type, applies_to_status) counts soft-deleted policies too. */
async function policyExists(scope: TxScope, entityType: string, status: string | null): Promise<boolean> {
  const row = await scope.db
    .selectFrom('admin.data_retention_policies')
    .select('id')
    .where('entity_type', '=', entityType)
    .where(sql<boolean>`applies_to_status IS NOT DISTINCT FROM ${status}`)
    .executeTakeFirst();
  return !!row;
}

type DryRunInput = { retention_days?: number; applies_to_status?: string | null };

/**
 * 40 admin.retention_dry_run (backend S21, BR-25): what the next daily run (RetentionRule) would delete or anonymize
 * under a policy, counted by the owning module's RetentionCounter with the handler's own conditions; nothing changes.
 * Inactive policies are counted too (what activating them would do).
 */
@Injectable()
@Operation('admin.retention_dry_run')
export class RetentionDryRunHandler implements OperationHandler {
  constructor(private readonly handlers: RetentionHandlers) {}

  async handle(ctx: OperationContext<DryRunInput>): Promise<OperationResult> {
    staffOf(ctx);
    const b = ctx.body ?? {};
    const body = await ctx.tx(
      async (scope) => {
        const p = await scope.db
          .selectFrom('admin.data_retention_policies')
          .selectAll()
          .where('id', '=', ctx.params.policy_id!)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        if (!p) throw new ApiError('NOT_FOUND');
        const policy: RetentionPolicyRecord = {
          id: p.id,
          entityType: p.entity_type,
          appliesToStatus: b.applies_to_status !== undefined ? b.applies_to_status : p.applies_to_status,
          retentionDays: b.retention_days ?? p.retention_days,
          action: p.action as RetentionPolicyRecord['action'],
        };
        const counter = this.handlers.counter(p.entity_type);
        const outcome =
          policy.action === 'archive'
            ? 'archive'
            : !this.handlers.get(p.entity_type)
              ? 'no_handler'
              : !counter
                ? 'not_countable'
                : 'counted';
        const count = outcome === 'counted' ? await counter!(scope, policy) : null;
        return {
          policy_id: p.id,
          entity_type: p.entity_type,
          applies_to_status: policy.appliesToStatus,
          retention_days: policy.retentionDays,
          action: policy.action,
          status: p.status as 'active' | 'inactive',
          cutoff: retentionCutoff(policy).toISOString(),
          outcome,
          affected: count ? count.affected : null,
          by_status: count?.byStatus ? count.byStatus.slice(0, 20) : null,
        };
      },
      { readOnly: true },
    );
    return { body };
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

type AssistQuery = { mine?: boolean; status?: 'active' | 'ended' | 'expired'; organization_id?: string; limit: number };

/**
 * 40 admin.assist_sessions_list (backend S19, BR-34, D-62): open and past assisted sessions, newest first, so the
 * console can show the banner of an open session after a reload or on another device. A session past its 4 hours
 * is shown (and filtered) as expired before the hourly rule marks it.
 */
@Injectable()
@Operation('admin.assist_sessions_list')
export class AssistSessionsListHandler implements OperationHandler {
  constructor(
    private readonly orgs: OrgCards,
    private readonly names: StaffNames,
  ) {}

  async handle(ctx: OperationContext<undefined, AssistQuery>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const q = ctx.query;
    const after = afterId(ctx);
    const body = await ctx.tx(
      async (scope) => {
        const now = new Date();
        let r = scope.db.selectFrom('admin.assist_sessions').selectAll().where('deleted_at', 'is', null);
        if (q.mine) r = r.where('staff_user_id', '=', s.userId);
        if (q.organization_id) r = r.where('organization_id', '=', q.organization_id);
        if (q.status === 'active') r = r.where('status', '=', 'active').where('expires_at', '>', now);
        if (q.status === 'ended') r = r.where('status', '=', 'ended');
        if (q.status === 'expired')
          r = r.where((eb) => eb.or([eb('status', '=', 'expired'), eb.and([eb('status', '=', 'active'), eb('expires_at', '<=', now)])]));
        if (after) r = r.where('id', '<', after);
        const rows = await r
          .orderBy('id', 'desc')
          .limit(q.limit + 1)
          .execute();
        const page = rows.slice(0, q.limit);
        const [cards, names] = await Promise.all([
          this.orgs.cards(
            scope,
            page.map((x) => x.organization_id),
          ),
          this.names.names(
            scope,
            page.map((x) => x.staff_user_id),
            ctx.locale,
          ),
        ]);
        const items = [];
        for (const x of page) {
          const card = cards.get(x.organization_id);
          if (!card) continue;
          items.push({
            assist_session_id: x.id,
            organization: toOrgSummary(card),
            flow_type: x.flow_type as 'provider' | 'vendor' | 'fleet',
            status: x.status === 'active' && x.expires_at <= now ? 'expired' : x.status,
            staff_display: names.get(x.staff_user_id)!,
            mine: x.staff_user_id === s.userId,
            started_at: x.started_at.toISOString(),
            expires_at: x.expires_at.toISOString(),
            ended_at: x.ended_at ? x.ended_at.toISOString() : null,
          });
        }
        return ctx.page(items, rows.length > q.limit ? { id: page.at(-1)!.id } : null);
      },
      { readOnly: true },
    );
    return { body };
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

/**
 * Background jobs an admin-plane operation starts, and the staff roles that may start them (contract 1.4.0,
 * admin console BR-20). A kind is listed only when no api-host operation starts it, so admin.job_get can never
 * reveal a job of a user or an organization.
 */
export const ADMIN_JOB_KINDS: Readonly<Record<string, { module: string; roles: readonly string[] }>> = {
  data_export: { module: 'identity', roles: ['platform_admin', 'platform_support'] }, // admin.dsr_export
  taxonomy_merge: { module: 'taxonomy', roles: ['platform_admin'] }, // approved admin.taxonomy_merge
  organization_merge: { module: 'organization', roles: ['platform_admin'] }, // approved admin.org_merge (backend S22)
};

/** admin.job_get: the state of a job an admin-plane operation started (no input or personal data). */
@Injectable()
@Operation('admin.job_get')
export class AdminJobGetHandler implements OperationHandler {
  async handle(ctx: OperationContext): Promise<OperationResult> {
    const s = staffOf(ctx);
    const row = await ctx.tx(
      (scope) => scope.db.selectFrom('core.background_jobs').selectAll().where('id', '=', ctx.params.job_id!).executeTakeFirst(),
      { readOnly: true },
    );
    const kind = row ? ADMIN_JOB_KINDS[row.kind] : undefined;
    // Jobs of the api host, and kinds the caller's roles cannot start, do not exist for the caller.
    if (!row || !kind || row.owning_module !== kind.module || !kind.roles.some((r) => s.roles.includes(r))) throw new ApiError('NOT_FOUND');
    return { body: toJobView(row) };
  }
}

/** admin.region_settings: config.client's region part and the pin check threshold for the console (BR-18). */
@Injectable()
@Operation('admin.region_settings')
export class AdminRegionSettingsHandler implements OperationHandler {
  constructor(
    @InjectConfig() private readonly config: CarpalConfig,
    private readonly region: RegionConfigService,
    private readonly rates: ExchangeRates,
  ) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    staffOf(ctx);
    return {
      body: {
        region: { ...this.region.forLocale(ctx.locale), exchange_rates: await this.rates.all() },
        location_check_threshold_m: this.config.geo.locationCheckThresholdM,
      },
      contentLanguage: ctx.locale,
    };
  }
}
