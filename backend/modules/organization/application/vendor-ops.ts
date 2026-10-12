// Vendor profile (40 §9.2): vendor.profile_get / profile_put / publish /
// unpublish, vendor.coverage_list / coverage_create / coverage_delete,
// vendor.insights_get. The public inventory follows the profile's
// publication (inventory module, S5).
import { Injectable } from '@nestjs/common';
import { writeAudit } from '#libs/audit/index.js';
import { Authorizer } from '#libs/authz/index.js';
import { ApiError, type FieldErrorCode } from '#libs/contract/index.js';
import { ACK, Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { toVendorCoverage, toVendorProfile, type VendorCoverageRow, type VendorProfileRow } from '../api/projections.js';
import { completeness, insightsPeriod, VENDOR_COMPLETENESS, vendorPublishUnmet } from '../domain/profile-rules.js';
import { OrganizationExtensions } from '../interface/extensions.js';
import { ProfileFacts } from '../infrastructure/facts.js';
import { afterId, checkVersion, failIf, json, member, pageOf } from './common.js';
import { activateOrganization } from './provider-profile-ops.js';

type VendorProfileWrite = {
  vendor_type: string;
  description_translations?: Record<string, string>;
  delivery_options: string[];
  trade_customers_supported: boolean;
  default_price_visibility: string;
  return_policy_translations?: Record<string, string>;
  warranty_policy_translations?: Record<string, string>;
  response_time_target?: string;
  catalog_coming_soon?: boolean;
};

async function loadProfile(scope: TxScope, orgId: string, lock = false): Promise<VendorProfileRow | undefined> {
  const q = scope.db
    .selectFrom('organization.vendor_profiles')
    .selectAll()
    .where('organization_id', '=', orgId)
    .where('deleted_at', 'is', null);
  return (lock ? q.forUpdate() : q).executeTakeFirst();
}

@Injectable()
@Operation('vendor.profile_get')
export class VendorProfileGetHandler implements OperationHandler {
  constructor(private readonly facts: ProfileFacts) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const m = member(ctx);
    const body = await ctx.tx(
      async (scope) => {
        const p = await loadProfile(scope, m.orgId);
        if (!p) throw new ApiError('NOT_FOUND');
        return toVendorProfile(p, completeness(VENDOR_COMPLETENESS, await this.facts.vendor(scope, m.orgId)).score);
      },
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('vendor.profile_put')
export class VendorProfilePutHandler implements OperationHandler {
  constructor(private readonly facts: ProfileFacts) {}

  async handle(ctx: OperationContext<VendorProfileWrite>): Promise<OperationResult> {
    const m = member(ctx);
    const b = ctx.body;
    const body = await ctx.tx(async (scope) => {
      const existing = await loadProfile(scope, m.orgId, true);
      if (existing) checkVersion(existing.version, ctx.ifMatch);
      else if (ctx.ifMatch !== undefined) throw new ApiError('VERSION_MISMATCH', { detail: 'no profile yet' });
      const facts = await this.facts.vendor(scope, m.orgId);
      const score = completeness(VENDOR_COMPLETENESS, {
        ...facts,
        hasProfile: true,
        descriptionSet: !!b.description_translations,
        returnPolicySet: !!b.return_policy_translations,
        warrantyPolicySet: !!b.warranty_policy_translations,
        responseTargetSet: !!b.response_time_target,
        catalogComingSoon: b.catalog_coming_soon ?? false,
      }).score;
      const values = {
        vendor_type: b.vendor_type,
        description_translations: json(b.description_translations),
        // shipping_future is reserved and not accepted by the contract (52 §23).
        delivery_options: b.delivery_options,
        trade_customers_supported: b.trade_customers_supported,
        default_price_visibility: b.default_price_visibility,
        return_policy_translations: json(b.return_policy_translations),
        warranty_policy_translations: json(b.warranty_policy_translations),
        response_time_target: b.response_time_target ?? null,
        catalog_coming_soon: b.catalog_coming_soon ?? false,
        profile_completeness: score,
      };
      const row = existing
        ? await scope.db
            .updateTable('organization.vendor_profiles')
            .set(values)
            .where('id', '=', existing.id)
            .returningAll()
            .executeTakeFirstOrThrow()
        : await scope.db
            .insertInto('organization.vendor_profiles')
            .values({ ...values, organization_id: m.orgId })
            .returningAll()
            .executeTakeFirstOrThrow();
      return toVendorProfile(row, score);
    });
    return { body };
  }
}

@Injectable()
@Operation('vendor.publish')
export class VendorPublishHandler implements OperationHandler {
  constructor(
    private readonly facts: ProfileFacts,
    private readonly authorizer: Authorizer,
  ) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const m = member(ctx);
    const body = await ctx.tx(async (scope) => {
      const profile = await loadProfile(scope, m.orgId, true);
      const facts = await this.facts.vendor(scope, m.orgId);
      const unmet = vendorPublishUnmet(facts);
      if (unmet.length || !profile)
        throw new ApiError('PUBLISH_REQUIREMENTS_UNMET', { detail: unmet.join(','), extensions: { requirements: unmet } });
      await scope.db
        .updateTable('organization.vendor_profiles')
        .set({ public_status: 'published', profile_completeness: completeness(VENDOR_COMPLETENESS, facts).score })
        .where('id', '=', profile.id)
        .execute();
      const activated = await activateOrganization(scope, m.orgId);
      await writeAudit(scope, {
        action: 'vendor.published',
        entityType: 'vendor_profile',
        entityId: profile.id,
        previous: profile.public_status,
        next: activated ? 'published; organization active' : 'published',
      });
      if (activated) scope.afterCommit(() => this.authorizer.invalidateOrganization(m.orgId));
      return { public_status: 'published', unmet: [] };
    });
    return { body };
  }
}

@Injectable()
@Operation('vendor.unpublish')
export class VendorUnpublishHandler implements OperationHandler {
  constructor(private readonly facts: ProfileFacts) {}

  async handle(ctx: OperationContext<{ reason: string }>): Promise<OperationResult> {
    const m = member(ctx);
    const body = await ctx.tx(async (scope) => {
      const profile = await loadProfile(scope, m.orgId, true);
      if (!profile) throw new ApiError('NOT_FOUND');
      const next = profile.public_status === 'published' ? 'draft' : profile.public_status;
      if (next !== profile.public_status)
        await scope.db.updateTable('organization.vendor_profiles').set({ public_status: next }).where('id', '=', profile.id).execute();
      await writeAudit(scope, {
        action: 'vendor.unpublished',
        entityType: 'vendor_profile',
        entityId: profile.id,
        reason: ctx.body.reason,
        previous: profile.public_status,
        next,
      });
      return { public_status: next, unmet: vendorPublishUnmet(await this.facts.vendor(scope, m.orgId)) };
    });
    return { body };
  }
}

@Injectable()
@Operation('vendor.coverage_list')
export class VendorCoverageListHandler implements OperationHandler {
  async handle(ctx: OperationContext<undefined, { limit: number }>): Promise<OperationResult> {
    const m = member(ctx);
    const after = afterId(ctx);
    const rows = await ctx.tx(
      (scope) => {
        let q = scope.db
          .selectFrom('organization.vendor_coverage')
          .selectAll()
          .where('vendor_organization_id', '=', m.orgId)
          .where('deleted_at', 'is', null);
        if (after) q = q.where('id', '>', after);
        return q
          .orderBy('id')
          .limit(ctx.query.limit + 1)
          .execute();
      },
      { readOnly: true },
    );
    return { body: pageOf(ctx, rows, toVendorCoverage) };
  }
}

/** coverage_type must name the node's type (VendorCoverageWrite). */
const COVERAGE_NODE_TYPE = { brand: 'vehicle_brand', model: 'vehicle_model', part_category: 'part_category' } as const;

@Injectable()
@Operation('vendor.coverage_create')
export class VendorCoverageCreateHandler implements OperationHandler {
  constructor(private readonly taxonomy: TaxonomyResolver) {}

  async handle(
    ctx: OperationContext<{ items: { taxonomy_node_id: string; coverage_type: keyof typeof COVERAGE_NODE_TYPE }[] }>,
  ): Promise<OperationResult> {
    const m = member(ctx);
    const items = ctx.body.items;
    const types = await Promise.all(items.map(async (i) => (await this.taxonomy.get(i.taxonomy_node_id))?.type));
    const result = await ctx.tx(async (scope) => {
      const created: VendorCoverageRow[] = [];
      const skipped: { index: number; code: FieldErrorCode }[] = [];
      for (const [index, item] of items.entries()) {
        if (types[index] !== COVERAGE_NODE_TYPE[item.coverage_type]) {
          skipped.push({ index, code: 'enum' });
          continue;
        }
        if (items.slice(0, index).some((e) => e.taxonomy_node_id === item.taxonomy_node_id && e.coverage_type === item.coverage_type)) {
          skipped.push({ index, code: 'not_unique' });
          continue;
        }
        const existing = await scope.db
          .selectFrom('organization.vendor_coverage')
          .select(['id', 'status'])
          .where('vendor_organization_id', '=', m.orgId)
          .where('taxonomy_node_id', '=', item.taxonomy_node_id)
          .where('coverage_type', '=', item.coverage_type)
          .forUpdate()
          .executeTakeFirst();
        if (existing?.status === 'active') {
          skipped.push({ index, code: 'not_unique' });
          continue;
        }
        created.push(
          existing
            ? await scope.db
                .updateTable('organization.vendor_coverage')
                .set({ status: 'active' })
                .where('id', '=', existing.id)
                .returningAll()
                .executeTakeFirstOrThrow()
            : await scope.db
                .insertInto('organization.vendor_coverage')
                .values({ vendor_organization_id: m.orgId, taxonomy_node_id: item.taxonomy_node_id, coverage_type: item.coverage_type })
                .returningAll()
                .executeTakeFirstOrThrow(),
        );
      }
      return { created: created.map(toVendorCoverage), skipped };
    });
    return { body: result };
  }
}

@Injectable()
@Operation('vendor.coverage_delete')
export class VendorCoverageDeleteHandler implements OperationHandler {
  async handle(ctx: OperationContext): Promise<OperationResult> {
    const m = member(ctx);
    await ctx.tx(async (scope) => {
      const r = await scope.db
        .updateTable('organization.vendor_coverage')
        .set({ status: 'inactive' })
        .where('id', '=', ctx.params.coverage_id!)
        .where('vendor_organization_id', '=', m.orgId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) === 0) throw new ApiError('NOT_FOUND');
    });
    return { body: ACK };
  }
}

@Injectable()
@Operation('vendor.insights_get')
export class VendorInsightsGetHandler implements OperationHandler {
  constructor(private readonly ext: OrganizationExtensions) {}

  async handle(ctx: OperationContext<undefined, { from: string; to: string }>): Promise<OperationResult> {
    const m = member(ctx);
    const period = { from: ctx.query.from, to: ctx.query.to };
    failIf(insightsPeriod(period.from, period.to));
    const body = await ctx.tx(
      async (scope) => {
        const profile = await loadProfile(scope, m.orgId);
        const x = <T>(key: Parameters<OrganizationExtensions['insight']>[0], fallback: T) =>
          this.ext.insight(key, scope, m.orgId, period, fallback);
        // Inquiries and catalog figures come from inventory (S5), searches and views from analytics (S8).
        return {
          period,
          inquiries_received: await x('vendor.inquiries_received', 0),
          inquiry_fulfillment_rate: await x<string | null>('vendor.inquiry_fulfillment_rate', null),
          measured_response_time_minutes: profile?.measured_response_time_minutes ?? null,
          catalog_quality_score: profile?.catalog_quality_score ?? 0,
          items_missing_fitment: await x('vendor.items_missing_fitment', 0),
          items_missing_images: await x('vendor.items_missing_images', 0),
          top_searched_part_categories: await x<unknown[]>('vendor.top_searched_part_categories', []),
          popular_categories: await x<unknown[]>('vendor.popular_categories', []),
          map_pin_views: await x('vendor.map_pin_views', 0),
          directions_taps: await x('vendor.directions_taps', 0),
        };
      },
      { readOnly: true },
    );
    return { body };
  }
}
