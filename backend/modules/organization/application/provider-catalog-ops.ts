// Provider capability portfolio (40 §8.2, 54 §2): service catalog, vehicle
// coverage, capability matrix, evidence and the approval gate for
// AI-suggested rows ("AI suggests, provider approves, platform verifies").
// Confidence is never written here: the trust-scoring worker computes it from
// active evidence (S7); self-declared rows start at level 0.
import { Injectable } from '@nestjs/common';
import { writeAudit } from '#libs/audit/index.js';
import { ApiError, type FieldErrorCode } from '#libs/contract/index.js';
import { ACK, created, Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import {
  toCapability,
  toCoverage,
  toEvidence,
  toServiceCategory,
  type CapabilityRow,
  type CoverageRow,
  type ServiceCategoryRow,
} from '../api/projections.js';
import { afterId, checkChain, checkVersion, json, member, pageOf } from './common.js';

/** Rows a provider may revive by creating them again (a pending AI suggestion is decided, not recreated). */
const REVIVABLE = ['inactive', 'rejected'];

// ------------------------------------------------------------ service catalog

type ServiceCategoryWrite = {
  taxonomy_node_id: string;
  display_name_translations?: Record<string, string>;
  description_translations?: Record<string, string>;
  experience_level: string;
  price_indicator?: string;
  typical_duration_minutes?: number;
  appointment_types?: string[];
  visibility: 'public' | 'private';
};

async function loadCategory(scope: TxScope, orgId: string, id: string, lock = false): Promise<ServiceCategoryRow> {
  const q = scope.db
    .selectFrom('organization.provider_service_categories')
    .selectAll()
    .where('id', '=', id)
    .where('provider_organization_id', '=', orgId)
    .where('deleted_at', 'is', null);
  const row = await (lock ? q.forUpdate() : q).executeTakeFirst();
  if (!row) throw new ApiError('NOT_FOUND');
  return row;
}

@Injectable()
@Operation('provider.service_categories_list')
export class ProviderServiceCategoriesListHandler implements OperationHandler {
  async handle(ctx: OperationContext<undefined, { status?: string; limit: number }>): Promise<OperationResult> {
    const m = member(ctx);
    const after = afterId(ctx);
    const rows = await ctx.tx(
      (scope) => {
        let q = scope.db
          .selectFrom('organization.provider_service_categories')
          .selectAll()
          .where('provider_organization_id', '=', m.orgId)
          .where('deleted_at', 'is', null);
        if (ctx.query.status) q = q.where('status', '=', ctx.query.status);
        if (after) q = q.where('id', '>', after);
        return q
          .orderBy('id')
          .limit(ctx.query.limit + 1)
          .execute();
      },
      { readOnly: true },
    );
    return { body: pageOf(ctx, rows, toServiceCategory) };
  }
}

@Injectable()
@Operation('provider.service_category_create')
export class ProviderServiceCategoryCreateHandler implements OperationHandler {
  async handle(ctx: OperationContext<ServiceCategoryWrite>): Promise<OperationResult> {
    const m = member(ctx);
    const b = ctx.body;
    const values = {
      display_name_translations: json(b.display_name_translations),
      description_translations: json(b.description_translations),
      experience_level: b.experience_level,
      price_indicator: b.price_indicator ?? null,
      typical_duration_minutes: b.typical_duration_minutes ?? null,
      appointment_types: b.appointment_types ?? [],
      visibility: b.visibility,
      source: 'self_declared',
      ai_insight_id: null,
      status: 'active',
    };
    const row = await ctx.tx(async (scope) => {
      // Unique per provider and node (52); a removed or rejected entry comes back as a new self-declared one.
      const existing = await scope.db
        .selectFrom('organization.provider_service_categories')
        .select(['id', 'status'])
        .where('provider_organization_id', '=', m.orgId)
        .where('taxonomy_node_id', '=', b.taxonomy_node_id)
        .forUpdate()
        .executeTakeFirst();
      if (existing && !REVIVABLE.includes(existing.status)) throw new ApiError('DUPLICATE');
      return existing
        ? scope.db
            .updateTable('organization.provider_service_categories')
            .set(values)
            .where('id', '=', existing.id)
            .returningAll()
            .executeTakeFirstOrThrow()
        : scope.db
            .insertInto('organization.provider_service_categories')
            .values({ ...values, provider_organization_id: m.orgId, taxonomy_node_id: b.taxonomy_node_id })
            .returningAll()
            .executeTakeFirstOrThrow();
    });
    return created(toServiceCategory(row), `/v1/orgs/${m.orgId}/provider/service-categories/${row.id}`);
  }
}

@Injectable()
@Operation('provider.service_category_update')
export class ProviderServiceCategoryUpdateHandler implements OperationHandler {
  async handle(ctx: OperationContext<Partial<Omit<ServiceCategoryWrite, 'taxonomy_node_id'>>>): Promise<OperationResult> {
    const m = member(ctx);
    const b = ctx.body;
    const row = await ctx.tx(async (scope) => {
      const c = await loadCategory(scope, m.orgId, ctx.params.category_id!, true);
      checkVersion(c.version, ctx.ifMatch);
      return scope.db
        .updateTable('organization.provider_service_categories')
        .set({
          ...(b.display_name_translations !== undefined ? { display_name_translations: json(b.display_name_translations) } : {}),
          ...(b.description_translations !== undefined ? { description_translations: json(b.description_translations) } : {}),
          ...(b.experience_level !== undefined ? { experience_level: b.experience_level } : {}),
          ...(b.price_indicator !== undefined ? { price_indicator: b.price_indicator } : {}),
          ...(b.typical_duration_minutes !== undefined ? { typical_duration_minutes: b.typical_duration_minutes } : {}),
          ...(b.appointment_types !== undefined ? { appointment_types: b.appointment_types } : {}),
          ...(b.visibility !== undefined ? { visibility: b.visibility } : {}),
        })
        .where('id', '=', c.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    return { body: toServiceCategory(row) };
  }
}

@Injectable()
@Operation('provider.service_category_delete')
export class ProviderServiceCategoryDeleteHandler implements OperationHandler {
  async handle(ctx: OperationContext): Promise<OperationResult> {
    const m = member(ctx);
    await ctx.tx(async (scope) => {
      const c = await loadCategory(scope, m.orgId, ctx.params.category_id!, true);
      await scope.db.updateTable('organization.provider_service_categories').set({ status: 'inactive' }).where('id', '=', c.id).execute();
    });
    return { body: ACK };
  }
}

// ------------------------------------------------------------ vehicle coverage

type CoverageWrite = {
  brand_node_id: string;
  model_node_id?: string;
  series_node_id?: string;
  engine_type_node_id?: string;
  fuel_type_node_id?: string;
  coverage_level: string;
};

@Injectable()
@Operation('provider.coverage_list')
export class ProviderCoverageListHandler implements OperationHandler {
  async handle(ctx: OperationContext<undefined, { brand_node_id?: string; status?: string; limit: number }>): Promise<OperationResult> {
    const m = member(ctx);
    const after = afterId(ctx);
    const rows = await ctx.tx(
      (scope) => {
        let q = scope.db
          .selectFrom('organization.provider_vehicle_coverage')
          .selectAll()
          .where('provider_organization_id', '=', m.orgId)
          .where('deleted_at', 'is', null);
        if (ctx.query.brand_node_id) q = q.where('brand_node_id', '=', ctx.query.brand_node_id);
        if (ctx.query.status) q = q.where('status', '=', ctx.query.status);
        if (after) q = q.where('id', '>', after);
        return q
          .orderBy('id')
          .limit(ctx.query.limit + 1)
          .execute();
      },
      { readOnly: true },
    );
    return { body: pageOf(ctx, rows, toCoverage) };
  }
}

const sameCoverage = (a: CoverageWrite, b: CoverageWrite): boolean =>
  a.brand_node_id === b.brand_node_id &&
  (a.model_node_id ?? null) === (b.model_node_id ?? null) &&
  (a.series_node_id ?? null) === (b.series_node_id ?? null) &&
  (a.engine_type_node_id ?? null) === (b.engine_type_node_id ?? null) &&
  (a.fuel_type_node_id ?? null) === (b.fuel_type_node_id ?? null);

@Injectable()
@Operation('provider.coverage_create')
export class ProviderCoverageCreateHandler implements OperationHandler {
  constructor(private readonly taxonomy: TaxonomyResolver) {}

  /** Why a row is skipped: its parent chain is wrong, or its model is missing for a series. */
  async #chainProblem(item: CoverageWrite): Promise<FieldErrorCode | null> {
    try {
      await checkChain(this.taxonomy, item);
      return null;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VALIDATION_FAILED') return 'conditional_required';
      if (err instanceof ApiError && err.code === 'TAXONOMY_MISMATCH') return 'reference_not_found';
      throw err;
    }
  }

  async handle(ctx: OperationContext<{ items: CoverageWrite[] }>): Promise<OperationResult> {
    const m = member(ctx);
    const items = ctx.body.items;
    // Each row is validated on its own (node types were checked for the whole request by the pipeline, GD-17).
    const problems = await Promise.all(items.map((i) => this.#chainProblem(i)));
    const result = await ctx.tx(async (scope) => {
      const created: CoverageRow[] = [];
      const skipped: { index: number; code: FieldErrorCode }[] = [];
      for (const [index, item] of items.entries()) {
        const problem = problems[index];
        if (problem) {
          skipped.push({ index, code: problem });
          continue;
        }
        if (items.slice(0, index).some((earlier) => sameCoverage(earlier, item))) {
          skipped.push({ index, code: 'not_unique' });
          continue;
        }
        let q = scope.db
          .selectFrom('organization.provider_vehicle_coverage')
          .select(['id', 'status'])
          .where('provider_organization_id', '=', m.orgId)
          .where('brand_node_id', '=', item.brand_node_id);
        for (const col of ['model_node_id', 'series_node_id', 'engine_type_node_id', 'fuel_type_node_id'] as const)
          q = item[col] ? q.where(col, '=', item[col]) : q.where(col, 'is', null);
        const existing = await q.forUpdate().executeTakeFirst();
        if (existing && !REVIVABLE.includes(existing.status)) {
          skipped.push({ index, code: 'not_unique' });
          continue;
        }
        const values = { coverage_level: item.coverage_level, source: 'self_declared', ai_insight_id: null, status: 'active' };
        created.push(
          existing
            ? await scope.db
                .updateTable('organization.provider_vehicle_coverage')
                .set(values)
                .where('id', '=', existing.id)
                .returningAll()
                .executeTakeFirstOrThrow()
            : await scope.db
                .insertInto('organization.provider_vehicle_coverage')
                .values({
                  ...values,
                  provider_organization_id: m.orgId,
                  brand_node_id: item.brand_node_id,
                  model_node_id: item.model_node_id ?? null,
                  series_node_id: item.series_node_id ?? null,
                  engine_type_node_id: item.engine_type_node_id ?? null,
                  fuel_type_node_id: item.fuel_type_node_id ?? null,
                })
                .returningAll()
                .executeTakeFirstOrThrow(),
        );
      }
      return { created: created.map(toCoverage), skipped };
    });
    return { body: result };
  }
}

@Injectable()
@Operation('provider.coverage_delete')
export class ProviderCoverageDeleteHandler implements OperationHandler {
  async handle(ctx: OperationContext): Promise<OperationResult> {
    const m = member(ctx);
    await ctx.tx(async (scope) => {
      const r = await scope.db
        .updateTable('organization.provider_vehicle_coverage')
        .set({ status: 'inactive' })
        .where('id', '=', ctx.params.coverage_id!)
        .where('provider_organization_id', '=', m.orgId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) === 0) throw new ApiError('NOT_FOUND');
    });
    return { body: ACK };
  }
}

// ------------------------------------------------------------ capabilities

type CapabilityWrite = {
  brand_node_id?: string;
  model_node_id?: string;
  series_node_id?: string;
  service_system_node_id: string;
  service_task_node_id?: string;
  experience_level: string;
  public_visibility: boolean;
};

async function loadCapability(scope: TxScope, orgId: string, id: string, lock = false): Promise<CapabilityRow> {
  const q = scope.db
    .selectFrom('organization.provider_capabilities')
    .selectAll()
    .where('id', '=', id)
    .where('provider_organization_id', '=', orgId)
    .where('deleted_at', 'is', null);
  const row = await (lock ? q.forUpdate() : q).executeTakeFirst();
  if (!row) throw new ApiError('NOT_FOUND');
  return row;
}

@Injectable()
@Operation('provider.capabilities_list')
export class ProviderCapabilitiesListHandler implements OperationHandler {
  async handle(
    ctx: OperationContext<undefined, { service_system_node_id?: string; brand_node_id?: string; status?: string; limit: number }>,
  ): Promise<OperationResult> {
    const m = member(ctx);
    const after = afterId(ctx);
    const rows = await ctx.tx(
      (scope) => {
        let q = scope.db
          .selectFrom('organization.provider_capabilities')
          .selectAll()
          .where('provider_organization_id', '=', m.orgId)
          .where('deleted_at', 'is', null);
        if (ctx.query.service_system_node_id) q = q.where('service_system_node_id', '=', ctx.query.service_system_node_id);
        if (ctx.query.brand_node_id) q = q.where('brand_node_id', '=', ctx.query.brand_node_id);
        if (ctx.query.status) q = q.where('status', '=', ctx.query.status);
        if (after) q = q.where('id', '>', after);
        return q
          .orderBy('id')
          .limit(ctx.query.limit + 1)
          .execute();
      },
      { readOnly: true },
    );
    return { body: pageOf(ctx, rows, toCapability) };
  }
}

@Injectable()
@Operation('provider.capability_create')
export class ProviderCapabilityCreateHandler implements OperationHandler {
  constructor(private readonly taxonomy: TaxonomyResolver) {}

  async handle(ctx: OperationContext<CapabilityWrite>): Promise<OperationResult> {
    const m = member(ctx);
    const b = ctx.body;
    await checkChain(this.taxonomy, b);
    const row = await ctx.tx(async (scope) => {
      let q = scope.db
        .selectFrom('organization.provider_capabilities')
        .select(['id', 'status'])
        .where('provider_organization_id', '=', m.orgId)
        .where('service_system_node_id', '=', b.service_system_node_id);
      for (const col of ['brand_node_id', 'model_node_id', 'series_node_id', 'service_task_node_id'] as const)
        q = b[col] ? q.where(col, '=', b[col]) : q.where(col, 'is', null);
      const existing = await q.forUpdate().executeTakeFirst();
      if (existing && !REVIVABLE.includes(existing.status)) throw new ApiError('DUPLICATE');
      // Self-declared claims score 0 and never earn badges (54 §2.1); evidence links stay for audit.
      const values = {
        experience_level: b.experience_level,
        public_visibility: b.public_visibility,
        source: 'self_declared',
        ai_insight_id: null,
        status: 'active',
      };
      return existing
        ? scope.db
            .updateTable('organization.provider_capabilities')
            .set(values)
            .where('id', '=', existing.id)
            .returningAll()
            .executeTakeFirstOrThrow()
        : scope.db
            .insertInto('organization.provider_capabilities')
            .values({
              ...values,
              provider_organization_id: m.orgId,
              brand_node_id: b.brand_node_id ?? null,
              model_node_id: b.model_node_id ?? null,
              series_node_id: b.series_node_id ?? null,
              service_system_node_id: b.service_system_node_id,
              service_task_node_id: b.service_task_node_id ?? null,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
    });
    return created(toCapability(row), `/v1/orgs/${m.orgId}/provider/capabilities/${row.id}`);
  }
}

@Injectable()
@Operation('provider.capability_update')
export class ProviderCapabilityUpdateHandler implements OperationHandler {
  async handle(ctx: OperationContext<{ experience_level?: string; public_visibility?: boolean }>): Promise<OperationResult> {
    const m = member(ctx);
    const b = ctx.body;
    const row = await ctx.tx(async (scope) => {
      const c = await loadCapability(scope, m.orgId, ctx.params.capability_id!, true);
      checkVersion(c.version, ctx.ifMatch);
      // public_visibility is the provider's wish; the row is public only when active and ≥ low_evidence (RLS public_read).
      return scope.db
        .updateTable('organization.provider_capabilities')
        .set({
          ...(b.experience_level !== undefined ? { experience_level: b.experience_level } : {}),
          ...(b.public_visibility !== undefined ? { public_visibility: b.public_visibility } : {}),
        })
        .where('id', '=', c.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    return { body: toCapability(row) };
  }
}

@Injectable()
@Operation('provider.capability_delete')
export class ProviderCapabilityDeleteHandler implements OperationHandler {
  async handle(ctx: OperationContext): Promise<OperationResult> {
    const m = member(ctx);
    await ctx.tx(async (scope) => {
      const c = await loadCapability(scope, m.orgId, ctx.params.capability_id!, true);
      await scope.db.updateTable('organization.provider_capabilities').set({ status: 'inactive' }).where('id', '=', c.id).execute();
    });
    return { body: ACK };
  }
}

@Injectable()
@Operation('provider.capability_evidence_list')
export class ProviderCapabilityEvidenceListHandler implements OperationHandler {
  async handle(ctx: OperationContext<undefined, { status?: string; limit: number }>): Promise<OperationResult> {
    const m = member(ctx);
    const after = afterId(ctx);
    const rows = await ctx.tx(
      async (scope) => {
        await loadCapability(scope, m.orgId, ctx.params.capability_id!);
        let q = scope.db
          .selectFrom('organization.provider_capability_evidence')
          .selectAll()
          .where('capability_id', '=', ctx.params.capability_id!)
          .where('deleted_at', 'is', null);
        if (ctx.query.status) q = q.where('status', '=', ctx.query.status);
        if (after) q = q.where('id', '<', after);
        return q
          .orderBy('id', 'desc')
          .limit(ctx.query.limit + 1)
          .execute();
      },
      { readOnly: true },
    );
    return { body: pageOf(ctx, rows, toEvidence) };
  }
}

// ------------------------------------------------------------ approval gate

const GATED = {
  'service-categories': {
    table: 'organization.provider_service_categories',
    project: toServiceCategory,
    entity: 'provider_service_category',
  },
  coverage: { table: 'organization.provider_vehicle_coverage', project: toCoverage, entity: 'provider_vehicle_coverage' },
  capabilities: { table: 'organization.provider_capabilities', project: toCapability, entity: 'provider_capability' },
} as const;

@Injectable()
@Operation('provider.gated_decide')
export class ProviderGatedDecideHandler implements OperationHandler {
  async handle(ctx: OperationContext<{ decision: 'approve' | 'reject' }>): Promise<OperationResult> {
    const m = member(ctx);
    const collection = ctx.params.collection as keyof typeof GATED | 'evidence';
    const id = ctx.params.record_id!;
    const approve = ctx.body.decision === 'approve';
    const body = await ctx.tx(async (scope) => {
      if (collection === 'evidence') {
        // AI-linked evidence (54 §2.2): counts only after the provider approves; a rejected link is revoked.
        const e = await scope.db
          .selectFrom('organization.provider_capability_evidence as e')
          .innerJoin('organization.provider_capabilities as c', 'c.id', 'e.capability_id')
          .selectAll('e')
          .where('e.id', '=', id)
          .where('c.provider_organization_id', '=', m.orgId)
          .where('e.deleted_at', 'is', null)
          .forUpdate()
          .executeTakeFirst();
        if (!e) throw new ApiError('NOT_FOUND');
        if (e.status !== 'pending_approval') throw new ApiError('INVALID_TRANSITION', { detail: 'not_pending' });
        const row = await scope.db
          .updateTable('organization.provider_capability_evidence')
          .set({ status: approve ? 'active' : 'revoked' })
          .where('id', '=', e.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await writeAudit(scope, {
          action: approve ? 'provider.evidence_approved' : 'provider.evidence_rejected',
          entityType: 'provider_capability_evidence',
          entityId: e.id,
        });
        return toEvidence(row);
      }
      const g = GATED[collection];
      if (!g) throw new ApiError('NOT_FOUND');
      const orgColumn = 'provider_organization_id';
      const rec = (await scope.db
        .selectFrom(g.table)
        .selectAll()
        .where('id', '=', id)
        .where(orgColumn, '=', m.orgId)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst()) as { id: string; status: string } | undefined;
      if (!rec) throw new ApiError('NOT_FOUND');
      if (rec.status !== 'pending_provider_approval') throw new ApiError('INVALID_TRANSITION', { detail: 'not_pending' });
      const row = await scope.db
        .updateTable(g.table)
        .set({ status: approve ? 'active' : 'rejected' })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeAudit(scope, {
        action: approve ? 'provider.suggestion_approved' : 'provider.suggestion_rejected',
        entityType: g.entity,
        entityId: id,
      });
      return (g.project as (r: unknown) => unknown)(row);
    });
    return { body };
  }
}
