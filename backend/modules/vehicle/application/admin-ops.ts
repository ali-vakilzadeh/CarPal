// Vehicles on the admin plane (backend S23, admin console BR-16, DI-07; 40 admin.user_vehicles): A-USR-02 Vehicles.
// Brand, model, year and status only; the VIN shows its last four characters and the plate its last two. Documents,
// notes, mileage and history are never read here. PURP PII: the purpose is bound to the user in the path (S14).
import { Injectable } from '@nestjs/common';
import { ApiError } from '#libs/contract/index.js';
import { iso, Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import type { L10n } from '#libs/i18n/index.js';
import { auditStaffRead, staffOf } from '#modules/admin/interface/admin.js';
import { UserCards } from '#modules/identity/interface/identity.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { afterId } from './common.js';

/** "•••• 42": the plate's last two characters, the rest replaced (SEC-OUT-2 spirit: enough to tell two cars apart). */
export function maskPlate(plate: string | null): string | null {
  const p = plate?.trim();
  if (!p) return null;
  return `•••• ${p.slice(-2)}`;
}

@Injectable()
@Operation('admin.user_vehicles')
export class AdminUserVehiclesHandler implements OperationHandler {
  constructor(
    private readonly taxonomy: TaxonomyResolver,
    private readonly users: UserCards,
  ) {}

  async handle(ctx: OperationContext<undefined, { status?: string; limit: number }>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const userId = ctx.params.user_id!;
    const after = afterId(ctx);
    const rows = await ctx.tx(async (scope) => {
      if (!(await this.users.cards(scope, [userId])).has(userId)) throw new ApiError('NOT_FOUND');
      await auditStaffRead(scope, s, 'user', userId, 'vehicles (summary)');
      let q = scope.db
        .selectFrom('vehicle.vehicles')
        .select(['id', 'brand_node_id', 'model_node_id', 'series_node_id', 'year', 'status', 'vin_last4', 'license_plate', 'created_at'])
        .where('owner_type', '=', 'user')
        .where('owner_id', '=', userId)
        .where('deleted_at', 'is', null);
      if (ctx.query.status) q = q.where('status', '=', ctx.query.status as never);
      if (after) q = q.where('id', '<', after);
      return q
        .orderBy('id', 'desc')
        .limit(ctx.query.limit + 1)
        .execute();
    });
    const page = rows.slice(0, ctx.query.limit);
    const labels = await this.taxonomy.labels(
      page.flatMap((v) => [v.brand_node_id, v.model_node_id, v.series_node_id].filter((x): x is string => !!x)),
      ctx.locale,
    );
    const fallback = { text: '—', locale: 'en' } as L10n;
    const items = page.map((v) => ({
      id: v.id,
      brand: labels.get(v.brand_node_id) ?? fallback,
      model: labels.get(v.model_node_id) ?? fallback,
      series: v.series_node_id ? (labels.get(v.series_node_id) ?? null) : null,
      year: v.year,
      status: v.status,
      vin_last4: v.vin_last4,
      plate_masked: maskPlate(v.license_plate),
      created_at: iso(v.created_at),
    }));
    return { body: ctx.page(items, rows.length > ctx.query.limit ? { id: page.at(-1)!.id } : null) };
  }
}
