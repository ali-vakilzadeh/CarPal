// Appointments on the admin plane (backend S23, admin console BR-16, DI-07; 40 admin.user_appointments): A-USR-02
// Appointments. The appointments a user requested, with the business, vehicle card, type, status and dates; never the
// description, notes, contact data or the exact address. PURP PII: the purpose is bound to the user in the path (S14).
import { Injectable } from '@nestjs/common';
import { ApiError } from '#libs/contract/index.js';
import {
  iso,
  isoOrNull,
  Operation,
  type OperationContext,
  type OperationHandler,
  type OperationResult,
} from '#libs/http-pipeline/index.js';
import type { L10n } from '#libs/i18n/index.js';
import { auditStaffRead, staffOf } from '#modules/admin/interface/admin.js';
import { UserCards } from '#modules/identity/interface/identity.js';
import { OrgCards, toOrgSummary } from '#modules/organization/interface/org-cards.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { VehicleCards } from '#modules/vehicle/interface/vehicles.js';
import { afterId } from './common.js';

@Injectable()
@Operation('admin.user_appointments')
export class AdminUserAppointmentsHandler implements OperationHandler {
  constructor(
    private readonly users: UserCards,
    private readonly orgs: OrgCards,
    private readonly vehicles: VehicleCards,
    private readonly taxonomy: TaxonomyResolver,
  ) {}

  async handle(ctx: OperationContext<undefined, { status?: string; limit: number }>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const userId = ctx.params.user_id!;
    const after = afterId(ctx);
    const { page, more, cards, vehicles } = await ctx.tx(async (scope) => {
      if (!(await this.users.cards(scope, [userId])).has(userId)) throw new ApiError('NOT_FOUND');
      await auditStaffRead(scope, s, 'user', userId, 'appointments (summary)');
      let q = scope.db
        .selectFrom('appointment.appointments')
        .select([
          'id',
          'provider_organization_id',
          'requester_type',
          'requester_organization_id',
          'vehicle_id',
          'appointment_type',
          'service_mode',
          'service_system_node_id',
          'source',
          'urgency_level',
          'safety_flag',
          'status',
          'cancelled_by',
          'created_at',
          'confirmed_start_at',
          'completed_at',
        ])
        .where('requester_user_id', '=', userId)
        .where('deleted_at', 'is', null);
      if (ctx.query.status) q = q.where('status', '=', ctx.query.status as never);
      if (after) q = q.where('id', '<', after);
      const rows = await q
        .orderBy('id', 'desc')
        .limit(ctx.query.limit + 1)
        .execute();
      const page = rows.slice(0, ctx.query.limit);
      const [cards, vehicles] = await Promise.all([
        this.orgs.cards(scope, [
          ...page.map((a) => a.provider_organization_id),
          ...page.map((a) => a.requester_organization_id).filter((x): x is string => !!x),
        ]),
        this.vehicles.cards(
          scope,
          page.map((a) => a.vehicle_id),
        ),
      ]);
      return { page, more: rows.length > ctx.query.limit, cards, vehicles };
    });
    const labels = await this.taxonomy.labels(
      [...page.map((a) => a.service_system_node_id), ...[...vehicles.values()].flatMap((v) => [v.brandNodeId, v.modelNodeId])].filter(
        (x): x is string => !!x,
      ),
      ctx.locale,
    );
    const fallback = { text: '—', locale: 'en' } as L10n;
    const summary = (id: string | null) => {
      const c = id ? cards.get(id) : undefined;
      return c ? toOrgSummary(c) : null;
    };
    const items = page.map((a) => {
      const v = vehicles.get(a.vehicle_id);
      return {
        id: a.id,
        provider: summary(a.provider_organization_id),
        requester_type: a.requester_type,
        requester_organization: summary(a.requester_organization_id),
        vehicle: v
          ? { id: v.id, brand: labels.get(v.brandNodeId) ?? fallback, model: labels.get(v.modelNodeId) ?? fallback, year: v.year }
          : null,
        appointment_type: a.appointment_type,
        service_mode: a.service_mode,
        service_system: a.service_system_node_id ? (labels.get(a.service_system_node_id) ?? null) : null,
        source: a.source,
        urgency_level: a.urgency_level,
        safety_flag: a.safety_flag,
        status: a.status,
        cancelled_by: a.cancelled_by,
        created_at: iso(a.created_at),
        confirmed_start_at: isoOrNull(a.confirmed_start_at),
        completed_at: isoOrNull(a.completed_at),
      };
    });
    return { body: ctx.page(items, more ? { id: page.at(-1)!.id } : null) };
  }
}
