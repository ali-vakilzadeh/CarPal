// Inventory on the admin plane (backend S23, admin console BR-16, DI-06; 40 admin.org_inventory_quality): A-ORG-02
// Inventory. Item counts by status, data quality, confirmed fitment, inquiry fulfillment and the catalog quality score
// (54 §7.2) computed now without writing it, plus the flagged items. PURP (business data): the purpose is bound to the
// organization in the path (S14). Every figure is 0 for an organization without inventory.
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { ApiError } from '#libs/contract/index.js';
import { iso, Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { ModerationLog, staffOf } from '#modules/admin/interface/admin.js';
import { OrgCards } from '#modules/organization/interface/org-cards.js';
import { catalogQualityScore } from '../domain/rules.js';
import { CatalogQuality } from './common.js';

/** data_quality_score below this marks an item low_quality (40 InventoryFlag). */
export const LOW_QUALITY_BELOW = 50;
const MAX_FLAGGED = 50;
/** Live items checked for open moderation cases per query. */
const CASE_CHUNK = 1000;

const STATUSES = ['draft', 'active', 'pending_review', 'hidden', 'discontinued', 'removed'] as const;
type Flag = 'open_case' | 'pending_review' | 'hidden' | 'possible_duplicate' | 'low_quality';

/** Ids of the vendor's live (not removed) items that have an open moderation case. */
async function itemsWithOpenCases(scope: TxScope, moderation: ModerationLog, orgId: string): Promise<Set<string>> {
  const out = new Set<string>();
  let after: string | null = null;
  for (;;) {
    let q = scope.db
      .selectFrom('inventory.inventory_items')
      .select('id')
      .where('vendor_organization_id', '=', orgId)
      .where('status', '<>', 'removed')
      .where('deleted_at', 'is', null);
    if (after) q = q.where('id', '>', after);
    const ids = (await q.orderBy('id').limit(CASE_CHUNK).execute()).map((r) => r.id);
    for (const id of await moderation.withOpenCases(scope, 'inventory_item', ids)) out.add(id);
    if (ids.length < CASE_CHUNK) return out;
    after = ids.at(-1)!;
  }
}

@Injectable()
@Operation('admin.org_inventory_quality')
export class AdminOrgInventoryQualityHandler implements OperationHandler {
  constructor(
    private readonly orgs: OrgCards,
    private readonly quality: CatalogQuality,
    private readonly moderation: ModerationLog,
  ) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    staffOf(ctx);
    const orgId = ctx.params.org_id!;
    const body = await ctx.tx(
      async (scope) => {
        if (!(await this.orgs.cards(scope, [orgId])).has(orgId)) throw new ApiError('NOT_FOUND');
        const { rows: byStatus } = await sql<{ status: string; n: number }>`
          SELECT status, count(*)::int AS n FROM inventory.inventory_items
           WHERE vendor_organization_id = ${orgId}::uuid AND deleted_at IS NULL GROUP BY status`.execute(scope.db);
        const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<(typeof STATUSES)[number], number>;
        for (const r of byStatus) if (r.status in counts) counts[r.status as (typeof STATUSES)[number]] = Number(r.n);
        const { rows: activeRows } = await sql<{ low: number; confirmed: number; avg_quality: string | null }>`
          SELECT count(*) FILTER (WHERE i.data_quality_score < ${LOW_QUALITY_BELOW})::int AS low,
                 count(*) FILTER (WHERE EXISTS (SELECT 1 FROM inventory.inventory_fitment f
                                                 WHERE f.inventory_item_id = i.id AND f.status = 'active'
                                                   AND f.confidence = 'confirmed' AND f.deleted_at IS NULL))::int AS confirmed,
                 avg(i.data_quality_score) AS avg_quality
            FROM inventory.inventory_items i
           WHERE i.vendor_organization_id = ${orgId}::uuid AND i.status = 'active' AND i.deleted_at IS NULL`.execute(scope.db);
        const a = activeRows[0]!;
        const average = a.avg_quality === null ? null : Number(a.avg_quality);
        const inquiries = await this.quality.inquiryFigures(scope, orgId);
        const score = catalogQualityScore({
          activeItems: counts.active,
          confirmedFitmentItems: Number(a.confirmed),
          averageDataQuality: average,
          fulfillmentRate: inquiries.rate,
        });

        // Flagged: an open case, pending review, hidden, or a possible duplicate; low quality only marks a listed item.
        const withCases = await itemsWithOpenCases(scope, this.moderation, orgId);
        const flaggedBase = scope.db
          .selectFrom('inventory.inventory_items')
          .where('vendor_organization_id', '=', orgId)
          .where('status', '<>', 'removed')
          .where('deleted_at', 'is', null)
          .where((eb) =>
            eb.or([
              eb('status', 'in', ['pending_review', 'hidden']),
              eb('duplicate_of_item_id', 'is not', null),
              ...(withCases.size ? [eb('id', 'in', [...withCases])] : []),
            ]),
          );
        const [flaggedRows, flaggedTotal] = await Promise.all([
          flaggedBase
            .select(['id', 'sku', 'name_translations', 'status', 'visibility', 'data_quality_score', 'duplicate_of_item_id', 'updated_at'])
            .orderBy('updated_at', 'desc')
            .orderBy('id', 'desc')
            .limit(MAX_FLAGGED)
            .execute(),
          flaggedBase.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
        ]);
        const flagged = flaggedRows.map((i) => {
          const flags: Flag[] = [];
          if (withCases.has(i.id)) flags.push('open_case');
          if (i.status === 'pending_review') flags.push('pending_review');
          if (i.status === 'hidden') flags.push('hidden');
          if (i.duplicate_of_item_id) flags.push('possible_duplicate');
          if (i.data_quality_score < LOW_QUALITY_BELOW) flags.push('low_quality');
          return {
            id: i.id,
            sku: i.sku,
            name_translations: i.name_translations,
            status: i.status,
            visibility: i.visibility,
            data_quality_score: i.data_quality_score,
            flags,
            updated_at: iso(i.updated_at),
          };
        });
        return {
          counts,
          low_quality_active: Number(a.low),
          average_data_quality: average === null ? null : Math.round(average),
          confirmed_fitment_items: Number(a.confirmed),
          inquiries_90d: inquiries.received,
          inquiry_fulfillment_percent: inquiries.rate === null ? null : Math.round(inquiries.rate * 100),
          measured_response_time_minutes: inquiries.responseMinutes === null ? null : Math.min(inquiries.responseMinutes, 100000),
          catalog_quality_score: score,
          flagged,
          flagged_total: Number(flaggedTotal.n),
        };
      },
      { readOnly: true },
    );
    return { body };
  }
}
