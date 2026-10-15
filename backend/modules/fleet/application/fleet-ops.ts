// Fleet management (40 §18.2; 52 FleetProfile, FleetVehicleAssignment,
// FleetPreferredPartner, FleetApproval; MVP Module K). Under {flt}: the fleet
// profile (its first save activates a draft fleet, GD-19; enabling the
// approval workflow needs fleet_approval_workflow_enabled), the dashboard,
// driver assignments (one active per vehicle, drivers are fleet_driver
// members), preferred providers and approved vendors, and approvals (repair
// requests, provider selections, cost estimates): the requester never
// approves their own request and every decision is audited.
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { writeAudit } from '#libs/audit/index.js';
import { ApiError, type FieldError } from '#libs/contract/index.js';
import { registerConstraintErrors } from '#libs/db/index.js';
import { EntitlementChecker, requireEntitlement } from '#libs/entitlements/index.js';
import { created, Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import type { Locale } from '#libs/i18n/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { AppointmentFacts } from '#modules/appointment/interface/appointments.js';
import { authorDisplayName, OrgMemberships, UserCards } from '#modules/identity/interface/identity.js';
import { OrgLifecycle } from '#modules/organization/interface/lifecycle.js';
import { OrgCards, toOrgSummary } from '#modules/organization/interface/org-cards.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { VehicleCards, VehicleService } from '#modules/vehicle/interface/vehicles.js';
import {
  amount,
  toApproval,
  toAssignment,
  toPartner,
  toProfile,
  type ApprovalRow,
  type OrgSummaryView,
  type PartnerRow,
} from '../api/projections.js';
import { approvalRequested, DriverNames } from '../infrastructure/fleet-services.js';

registerConstraintErrors({
  fleet_vehicle_assignments_active_uq: 'DUPLICATE',
  fleet_preferred_partners_uq: 'DUPLICATE',
  fleet_approvals_no_self_approval: 'SELF_APPROVAL_FORBIDDEN',
});

export interface FleetMember {
  userId: string;
  orgId: string;
  role: string;
}

export function fleetMember(ctx: OperationContext): FleetMember {
  const org = ctx.access.org;
  if (ctx.principal.kind !== 'user' || !org) throw new ApiError('NOT_FOUND');
  return { userId: ctx.principal.userId, orgId: org.id, role: org.role };
}

type Position = { id?: string } | undefined;
export const afterId = (ctx: OperationContext): string | undefined => (ctx.cursor as Position)?.id;

export function pageOf<R extends { id: string }, T>(ctx: OperationContext<unknown, { limit: number }>, rows: R[], items: T[]) {
  const limit = ctx.query.limit;
  return ctx.page(items.slice(0, limit), rows.length > limit ? { id: rows[limit - 1]!.id } : null);
}

export const notFoundAt = (pointer: string): ApiError =>
  ApiError.validation([{ pointer, code: 'reference_not_found' }], 'REFERENCE_NOT_FOUND');

const failIf = (errors: FieldError[]) => {
  if (errors.length) throw ApiError.validation(errors);
};

/** The fleet's own vehicle (fleet context): 422 at the pointer otherwise. */
async function fleetVehicle(vehicles: VehicleCards, scope: TxScope, orgId: string, vehicleId: string, pointer: string) {
  const v = await vehicles.visible(scope, vehicleId);
  if (!v || v.ownerType !== 'organization' || v.ownerId !== orgId) throw notFoundAt(pointer);
  return v;
}

// ------------------------------------------------------------------ profile

type ProfileWrite = {
  fleet_size: number;
  industry?: string;
  approval_workflow_enabled: boolean;
  cost_approval_threshold_amount?: string;
  preferred_provider_mode: string;
  reporting_currency: string;
};

async function loadProfile(scope: TxScope, orgId: string, lock = false) {
  const q = scope.db.selectFrom('fleet.fleet_profiles').selectAll().where('organization_id', '=', orgId).where('deleted_at', 'is', null);
  return (lock ? q.forUpdate() : q).executeTakeFirst();
}

@Injectable()
@Operation('fleet.profile_get')
export class FleetProfileGetHandler implements OperationHandler {
  async handle(ctx: OperationContext): Promise<OperationResult> {
    const m = fleetMember(ctx);
    const body = await ctx.tx(
      async (scope) => {
        const p = await loadProfile(scope, m.orgId);
        if (!p) throw new ApiError('NOT_FOUND');
        return toProfile(p);
      },
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('fleet.profile_put')
export class FleetProfilePutHandler implements OperationHandler {
  constructor(
    private readonly entitlements: EntitlementChecker,
    private readonly lifecycle: OrgLifecycle,
  ) {}

  async handle(ctx: OperationContext<ProfileWrite>): Promise<OperationResult> {
    const m = fleetMember(ctx);
    const b = ctx.body;
    const body = await ctx.tx(async (scope) => {
      const p = await loadProfile(scope, m.orgId, true);
      // ETAG(if exists): an existing profile needs If-Match; the first save creates it.
      if (p) {
        if (ctx.ifMatch === undefined) throw new ApiError('PRECONDITION_REQUIRED');
        if (ctx.ifMatch !== p.version) throw new ApiError('VERSION_MISMATCH');
      }
      // ENT(fleet_approval_workflow_enabled: if enabling).
      if (b.approval_workflow_enabled && !p?.approval_workflow_enabled)
        await requireEntitlement(this.entitlements, scope, { type: 'organization', id: m.orgId }, 'fleet_approval_workflow_enabled', 0);
      const values = {
        fleet_size: b.fleet_size,
        industry: b.industry ?? null,
        approval_workflow_enabled: b.approval_workflow_enabled,
        cost_approval_threshold_amount: b.cost_approval_threshold_amount ?? null,
        preferred_provider_mode: b.preferred_provider_mode,
        reporting_currency: b.reporting_currency,
      };
      const row = p
        ? await scope.db.updateTable('fleet.fleet_profiles').set(values).where('id', '=', p.id).returningAll().executeTakeFirstOrThrow()
        : await scope.db
            .insertInto('fleet.fleet_profiles')
            .values({ ...values, organization_id: m.orgId })
            .returningAll()
            .executeTakeFirstOrThrow();
      // GD-19 (S8): a fleet organization becomes active with its fleet profile.
      const activated = await this.lifecycle.activate(scope, m.orgId);
      await writeAudit(scope, {
        action: p ? 'fleet.profile_updated' : 'fleet.profile_created',
        entityType: 'fleet_profile',
        entityId: row.id,
        previous: p
          ? JSON.stringify({
              workflow: p.approval_workflow_enabled,
              threshold: p.cost_approval_threshold_amount,
              mode: p.preferred_provider_mode,
            })
          : null,
        next: JSON.stringify({
          workflow: row.approval_workflow_enabled,
          threshold: row.cost_approval_threshold_amount,
          mode: row.preferred_provider_mode,
          activated,
        }),
      });
      return toProfile(row);
    });
    return { body };
  }
}

@Injectable()
@Operation('fleet.dashboard')
export class FleetDashboardHandler implements OperationHandler {
  constructor(
    private readonly vehicles: VehicleCards,
    private readonly appointments: AppointmentFacts,
    private readonly taxonomy: TaxonomyResolver,
  ) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const m = fleetMember(ctx);
    const body = await ctx.tx(
      async (scope) => {
        const now = new Date();
        const figures = await this.vehicles.fleetDashboard(scope, m.orgId);
        const profile = await loadProfile(scope, m.orgId);
        const monthStart = `${now.toISOString().slice(0, 7)}-01`;
        const yearAgo = new Date(now.getTime() - 365 * 86_400_000).toISOString().slice(0, 10);
        const records = await this.vehicles.fleetServiceRecords(scope, m.orgId, yearAgo, now.toISOString().slice(0, 10));
        const pending = await scope.db
          .selectFrom('fleet.fleet_approvals')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('fleet_organization_id', '=', m.orgId)
          .where('status', 'in', ['pending', 'needs_more_info'])
          .where('deleted_at', 'is', null)
          .executeTakeFirstOrThrow();
        const active = (await this.appointments.fleetAppointments(scope, m.orgId, new Date(now.getTime() - 180 * 86_400_000), now)).filter(
          (a) => ['checked_in', 'in_progress', 'awaiting_parts', 'ready_for_pickup'].includes(a.status),
        );
        const currency = profile?.reporting_currency ?? null;
        const spend = records
          .filter((r) => r.serviceDate >= monthStart && r.costAmount !== null && r.currency === currency)
          .reduce((a, r) => a + Number(r.costAmount), 0);
        const repairs = new Map<string, number>();
        for (const r of records) repairs.set(r.vehicleId, (repairs.get(r.vehicleId) ?? 0) + 1);
        const top = [...repairs.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5);
        const labels = await vehicleLabels(
          this.vehicles,
          this.taxonomy,
          scope,
          m.orgId,
          top.map(([id]) => id),
          ctx.locale,
        );
        return {
          total_vehicles: figures.total,
          due_for_service: figures.dueForService,
          active_repairs: Math.max(active.length, figures.inRepair),
          open_issues: figures.openIssues,
          pending_approvals: Number(pending.n),
          month_spend: currency ? { amount: amount(spend), currency } : null,
          most_repaired_vehicles: top.map(([id, n]) => ({
            vehicle_id: id,
            label: labels.get(id) ?? 'Vehicle',
            repairs: Math.min(n, 10_000),
          })),
          driver_reported_issues: figures.driverReportedIssues,
        };
      },
      { readOnly: true },
    );
    return { body };
  }
}

/** "Nickname" or "Brand Model Year" (taxonomy labels in the reader's locale), ≤ 120 characters. */
export async function vehicleLabels(
  vehicles: VehicleCards,
  taxonomy: TaxonomyResolver,
  scope: TxScope,
  orgId: string,
  ids: readonly string[],
  locale: Locale,
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await vehicles.fleetVehicles(scope, orgId, ids);
  const names = await taxonomy.labels(
    rows.flatMap((r) => [r.brandNodeId, r.modelNodeId]),
    locale,
  );
  return new Map(
    rows.map((r) => [
      r.id,
      (r.nickname ?? `${names.get(r.brandNodeId)?.text ?? ''} ${names.get(r.modelNodeId)?.text ?? ''} ${r.year}`.trim()).slice(0, 120) ||
        'Vehicle',
    ]),
  );
}

// ------------------------------------------------------------------ assignments

@Injectable()
@Operation('fleet.assignments_list')
export class FleetAssignmentsListHandler implements OperationHandler {
  constructor(private readonly names: DriverNames) {}

  async handle(ctx: OperationContext<undefined, { status?: string; driver_user_id?: string; vehicle_id?: string; limit: number }>) {
    const m = fleetMember(ctx);
    const q = ctx.query;
    const after = afterId(ctx);
    const body = await ctx.tx(
      async (scope) => {
        let s = scope.db
          .selectFrom('fleet.fleet_vehicle_assignments')
          .selectAll()
          .where('fleet_organization_id', '=', m.orgId)
          .where('deleted_at', 'is', null);
        if (q.status) s = s.where('status', '=', q.status);
        if (q.driver_user_id) s = s.where('driver_user_id', '=', q.driver_user_id);
        if (q.vehicle_id) s = s.where('vehicle_id', '=', q.vehicle_id);
        if (after) s = s.where('id', '<', after);
        const rows = await s
          .orderBy('id', 'desc')
          .limit(q.limit + 1)
          .execute();
        const page = rows.slice(0, q.limit);
        // CNS(fleet_driver_data_visibility: driver details): names only with the driver's consent.
        const names = await this.names.names(
          scope,
          m.orgId,
          page.map((r) => r.driver_user_id),
          ctx.locale,
        );
        return pageOf(
          ctx,
          rows,
          page.map((r) => toAssignment(r, names.get(r.driver_user_id)!)),
        );
      },
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('fleet.assignment_set')
export class FleetAssignmentSetHandler implements OperationHandler {
  constructor(
    private readonly vehicles: VehicleCards,
    private readonly members: OrgMemberships,
    private readonly names: DriverNames,
  ) {}

  async handle(ctx: OperationContext<{ driver_user_id: string }>): Promise<OperationResult> {
    const m = fleetMember(ctx);
    const driverId = ctx.body.driver_user_id;
    const body = await ctx.tx(async (scope) => {
      const v = await this.vehicles.visible(scope, ctx.params.vehicle_id!);
      if (!v || v.ownerType !== 'organization' || v.ownerId !== m.orgId) throw new ApiError('NOT_FOUND');
      // 52 FleetVehicleAssignment: the driver is an active member with role fleet_driver.
      const member = await this.members.findLive(scope, m.orgId, { userId: driverId });
      if (!member || member.status !== 'active' || member.role !== 'fleet_driver') throw notFoundAt('/driver_user_id');
      const current = await scope.db
        .selectFrom('fleet.fleet_vehicle_assignments')
        .selectAll()
        .where('vehicle_id', '=', v.id)
        .where('status', '=', 'active')
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (current?.driver_user_id === driverId)
        return toAssignment(current, (await this.names.names(scope, m.orgId, [driverId], ctx.locale)).get(driverId)!);
      if (current)
        await scope.db
          .updateTable('fleet.fleet_vehicle_assignments')
          .set({ status: 'ended', ended_at: sql<Date>`greatest(now(), assigned_at)` })
          .where('id', '=', current.id)
          .execute();
      const row = await scope.db
        .insertInto('fleet.fleet_vehicle_assignments')
        .values({ fleet_organization_id: m.orgId, vehicle_id: v.id, driver_user_id: driverId, assigned_by: m.userId })
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeAudit(scope, {
        action: 'fleet.driver_assigned',
        entityType: 'vehicle',
        entityId: v.id,
        previous: current ? `driver ${current.driver_user_id}` : 'unassigned',
        next: `driver ${driverId}`,
      });
      return toAssignment(row, (await this.names.names(scope, m.orgId, [driverId], ctx.locale)).get(driverId)!);
    });
    return { body };
  }
}

@Injectable()
@Operation('fleet.assignment_end')
export class FleetAssignmentEndHandler implements OperationHandler {
  async handle(ctx: OperationContext): Promise<OperationResult> {
    const m = fleetMember(ctx);
    await ctx.tx(async (scope) => {
      const row = await scope.db
        .updateTable('fleet.fleet_vehicle_assignments')
        .set({ status: 'ended', ended_at: sql<Date>`greatest(now(), assigned_at)` })
        .where('fleet_organization_id', '=', m.orgId)
        .where('vehicle_id', '=', ctx.params.vehicle_id!)
        .where('status', '=', 'active')
        .returning(['id', 'driver_user_id'])
        .executeTakeFirst();
      if (!row) throw new ApiError('NOT_FOUND');
      await writeAudit(scope, {
        action: 'fleet.driver_unassigned',
        entityType: 'vehicle',
        entityId: ctx.params.vehicle_id!,
        previous: `driver ${row.driver_user_id}`,
        next: 'unassigned',
      });
    });
    return { body: { ok: true } };
  }
}

// ------------------------------------------------------------------ partners

type PartnerWrite = {
  partner_organization_id: string;
  relationship_type: 'preferred_provider' | 'approved_vendor';
  service_system_node_id?: string;
  part_category_node_id?: string;
  priority: number;
  notes?: string;
};

const PROVIDER_TYPES = ['provider', 'hybrid_provider_vendor'];
const VENDOR_TYPES = ['vendor', 'hybrid_provider_vendor'];

function partnerScopeErrors(type: string, b: Partial<PartnerWrite>): FieldError[] {
  const errors: FieldError[] = [];
  if (type !== 'preferred_provider' && b.service_system_node_id)
    errors.push({ pointer: '/service_system_node_id', code: 'conditional_forbidden' });
  if (type !== 'approved_vendor' && b.part_category_node_id)
    errors.push({ pointer: '/part_category_node_id', code: 'conditional_forbidden' });
  return errors;
}

async function summaries(orgs: OrgCards, scope: TxScope, ids: readonly string[]): Promise<Map<string, OrgSummaryView>> {
  const cards = await orgs.cards(scope, ids);
  return new Map([...cards].map(([id, c]) => [id, toOrgSummary(c)]));
}

const UNKNOWN_ORG = (id: string): OrgSummaryView => ({
  id,
  name: 'Unknown',
  organization_type: 'provider',
  slug: null,
  logo_url: null,
  status: 'archived',
  verification_status: 'unverified',
});

@Injectable()
@Operation('fleet.partners_list')
export class FleetPartnersListHandler implements OperationHandler {
  constructor(private readonly orgs: OrgCards) {}

  async handle(ctx: OperationContext<undefined, { relationship_type?: string; limit: number }>): Promise<OperationResult> {
    const m = fleetMember(ctx);
    const after = afterId(ctx);
    const body = await ctx.tx(
      async (scope) => {
        let s = scope.db
          .selectFrom('fleet.fleet_preferred_partners')
          .selectAll()
          .where('fleet_organization_id', '=', m.orgId)
          .where('deleted_at', 'is', null);
        if (ctx.query.relationship_type) s = s.where('relationship_type', '=', ctx.query.relationship_type);
        if (after) s = s.where('id', '<', after);
        const rows = await s
          .orderBy('id', 'desc')
          .limit(ctx.query.limit + 1)
          .execute();
        const page = rows.slice(0, ctx.query.limit);
        const orgs = await summaries(
          this.orgs,
          scope,
          page.map((p) => p.partner_organization_id),
        );
        return pageOf(
          ctx,
          rows,
          page.map((p) => toPartner(p, orgs.get(p.partner_organization_id) ?? UNKNOWN_ORG(p.partner_organization_id))),
        );
      },
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('fleet.partner_create')
export class FleetPartnerCreateHandler implements OperationHandler {
  constructor(private readonly orgs: OrgCards) {}

  async handle(ctx: OperationContext<PartnerWrite>): Promise<OperationResult> {
    const m = fleetMember(ctx);
    const b = ctx.body;
    failIf(partnerScopeErrors(b.relationship_type, b));
    if (b.partner_organization_id === m.orgId) throw notFoundAt('/partner_organization_id');
    const body = await ctx.tx(async (scope) => {
      const partner = (await this.orgs.cards(scope, [b.partner_organization_id])).get(b.partner_organization_id);
      const types = b.relationship_type === 'preferred_provider' ? PROVIDER_TYPES : VENDOR_TYPES;
      if (!partner || !types.includes(partner.organizationType) || ['merged', 'archived'].includes(partner.status))
        throw notFoundAt('/partner_organization_id');
      const row = await scope.db
        .insertInto('fleet.fleet_preferred_partners')
        .values({
          fleet_organization_id: m.orgId,
          partner_organization_id: b.partner_organization_id,
          relationship_type: b.relationship_type,
          service_system_node_id: b.service_system_node_id ?? null,
          part_category_node_id: b.part_category_node_id ?? null,
          priority: b.priority,
          notes: b.notes ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeAudit(scope, {
        action: 'fleet.partner_added',
        entityType: 'fleet_partner',
        entityId: row.id,
        next: `${b.relationship_type} ${b.partner_organization_id}`,
      });
      return toPartner(row, toOrgSummary(partner));
    });
    return created(body, `/v1/orgs/${m.orgId}/fleet/partners/${body.id}`);
  }
}

@Injectable()
@Operation('fleet.partner_update')
export class FleetPartnerUpdateHandler implements OperationHandler {
  constructor(private readonly orgs: OrgCards) {}

  async handle(ctx: OperationContext<Partial<Omit<PartnerWrite, 'partner_organization_id'>> & { status?: 'active' | 'inactive' }>) {
    const m = fleetMember(ctx);
    const b = ctx.body;
    const body = await ctx.tx(async (scope) => {
      const p = (await scope.db
        .selectFrom('fleet.fleet_preferred_partners')
        .selectAll()
        .where('id', '=', ctx.params.partner_id!)
        .where('fleet_organization_id', '=', m.orgId)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst()) as PartnerRow | undefined;
      if (!p) throw new ApiError('NOT_FOUND');
      if (ctx.ifMatch !== p.version) throw new ApiError('VERSION_MISMATCH');
      const type = b.relationship_type ?? p.relationship_type;
      failIf(
        partnerScopeErrors(type, {
          service_system_node_id: b.service_system_node_id ?? p.service_system_node_id ?? undefined,
          part_category_node_id: b.part_category_node_id ?? p.part_category_node_id ?? undefined,
        }),
      );
      if (b.relationship_type && b.relationship_type !== p.relationship_type) {
        const partner = (await this.orgs.cards(scope, [p.partner_organization_id])).get(p.partner_organization_id);
        if (!partner || !(type === 'preferred_provider' ? PROVIDER_TYPES : VENDOR_TYPES).includes(partner.organizationType))
          failIf([{ pointer: '/relationship_type', code: 'enum' }]);
      }
      const row = await scope.db
        .updateTable('fleet.fleet_preferred_partners')
        .set({
          ...(b.relationship_type !== undefined ? { relationship_type: b.relationship_type } : {}),
          ...(b.service_system_node_id !== undefined ? { service_system_node_id: b.service_system_node_id } : {}),
          ...(b.part_category_node_id !== undefined ? { part_category_node_id: b.part_category_node_id } : {}),
          ...(b.priority !== undefined ? { priority: b.priority } : {}),
          ...(b.notes !== undefined ? { notes: b.notes } : {}),
          ...(b.status !== undefined ? { status: b.status } : {}),
        })
        .where('id', '=', p.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeAudit(scope, {
        action: 'fleet.partner_updated',
        entityType: 'fleet_partner',
        entityId: p.id,
        previous: `${p.status} p${p.priority}`,
        next: `${row.status} p${row.priority}`,
      });
      const orgs = await summaries(this.orgs, scope, [row.partner_organization_id]);
      return toPartner(row, orgs.get(row.partner_organization_id) ?? UNKNOWN_ORG(row.partner_organization_id));
    });
    return { body };
  }
}

// ------------------------------------------------------------------ approvals

/** FleetApproval views: selected provider, requester and approver by display name. */
@Injectable()
export class ApprovalViews {
  constructor(
    private readonly orgs: OrgCards,
    private readonly users: UserCards,
  ) {}

  async many(scope: TxScope, rows: ApprovalRow[], locale: Locale) {
    const providers = await summaries(
      this.orgs,
      scope,
      rows.map((r) => r.selected_provider_organization_id).filter((x): x is string => !!x),
    );
    const users = await this.users.cards(
      scope,
      rows.flatMap((r) => [r.requested_by_user_id, r.approver_user_id]).filter((x): x is string => !!x),
    );
    return rows.map((r) =>
      toApproval(r, {
        provider: r.selected_provider_organization_id
          ? (providers.get(r.selected_provider_organization_id) ?? UNKNOWN_ORG(r.selected_provider_organization_id))
          : null,
        requestedBy: authorDisplayName(users.get(r.requested_by_user_id), locale),
        approver: r.approver_user_id ? authorDisplayName(users.get(r.approver_user_id), locale) : null,
      }),
    );
  }
}

async function loadApproval(scope: TxScope, orgId: string, id: string, lock = false): Promise<ApprovalRow> {
  const q = scope.db
    .selectFrom('fleet.fleet_approvals')
    .selectAll()
    .where('id', '=', id)
    .where('fleet_organization_id', '=', orgId)
    .where('deleted_at', 'is', null);
  const row = await (lock ? q.forUpdate() : q).executeTakeFirst();
  if (!row) throw new ApiError('NOT_FOUND');
  return row;
}

@Injectable()
@Operation('fleet.approvals_list')
export class FleetApprovalsListHandler implements OperationHandler {
  constructor(private readonly views: ApprovalViews) {}

  async handle(ctx: OperationContext<undefined, { status?: string; approval_type?: string; vehicle_id?: string; limit: number }>) {
    const m = fleetMember(ctx);
    const q = ctx.query;
    const after = afterId(ctx);
    const body = await ctx.tx(
      async (scope) => {
        let s = scope.db
          .selectFrom('fleet.fleet_approvals')
          .selectAll()
          .where('fleet_organization_id', '=', m.orgId)
          .where('deleted_at', 'is', null);
        if (q.status) s = s.where('status', '=', q.status);
        if (q.approval_type) s = s.where('approval_type', '=', q.approval_type);
        if (q.vehicle_id) s = s.where('vehicle_id', '=', q.vehicle_id);
        if (after) s = s.where('id', '<', after);
        const rows = await s
          .orderBy('id', 'desc')
          .limit(q.limit + 1)
          .execute();
        return pageOf(ctx, rows, await this.views.many(scope, rows.slice(0, q.limit), ctx.locale));
      },
      { readOnly: true },
    );
    return { body };
  }
}

type ApprovalCreate = {
  approval_type: 'repair_request' | 'provider_selection' | 'cost_estimate';
  vehicle_id: string;
  related_issue_id?: string;
  related_appointment_id?: string;
  selected_provider_organization_id?: string;
  cost_estimate?: { amount: string; currency: string };
};

@Injectable()
@Operation('fleet.approval_create')
export class FleetApprovalCreateHandler implements OperationHandler {
  constructor(
    private readonly vehicles: VehicleCards,
    private readonly appointments: AppointmentFacts,
    private readonly orgs: OrgCards,
    private readonly views: ApprovalViews,
  ) {}

  async handle(ctx: OperationContext<ApprovalCreate>): Promise<OperationResult> {
    const m = fleetMember(ctx);
    const b = ctx.body;
    const errors: FieldError[] = [];
    if (b.approval_type === 'provider_selection' && !b.selected_provider_organization_id)
      errors.push({ pointer: '/selected_provider_organization_id', code: 'conditional_required' });
    if (b.approval_type === 'cost_estimate' && !b.cost_estimate) errors.push({ pointer: '/cost_estimate', code: 'conditional_required' });
    if (b.approval_type !== 'cost_estimate' && b.cost_estimate) errors.push({ pointer: '/cost_estimate', code: 'conditional_forbidden' });
    failIf(errors);
    const body = await ctx.tx(async (scope) => {
      await fleetVehicle(this.vehicles, scope, m.orgId, b.vehicle_id, '/vehicle_id');
      if (b.related_issue_id) {
        const issue = await this.vehicles.issue(scope, b.related_issue_id);
        if (!issue || issue.vehicleId !== b.vehicle_id) throw notFoundAt('/related_issue_id');
      }
      if (b.related_appointment_id) {
        const a = (await this.appointments.visits(scope, [b.related_appointment_id])).get(b.related_appointment_id);
        if (!a || a.requesterOrgId !== m.orgId || a.vehicleId !== b.vehicle_id) throw notFoundAt('/related_appointment_id');
      }
      if (b.selected_provider_organization_id) {
        const p = (await this.orgs.cards(scope, [b.selected_provider_organization_id])).get(b.selected_provider_organization_id);
        if (!p || !PROVIDER_TYPES.includes(p.organizationType) || p.status !== 'active')
          throw notFoundAt('/selected_provider_organization_id');
      }
      const row = await scope.db
        .insertInto('fleet.fleet_approvals')
        .values({
          fleet_organization_id: m.orgId,
          vehicle_id: b.vehicle_id,
          approval_type: b.approval_type,
          related_issue_id: b.related_issue_id ?? null,
          related_appointment_id: b.related_appointment_id ?? null,
          selected_provider_organization_id: b.selected_provider_organization_id ?? null,
          cost_estimate_amount: b.cost_estimate?.amount ?? null,
          cost_estimate_currency: b.cost_estimate?.currency ?? null,
          requested_by_user_id: m.userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await approvalRequested(scope, row);
      return (await this.views.many(scope, [row], ctx.locale))[0]!;
    });
    return created(body, `/v1/orgs/${m.orgId}/fleet/approvals/${body.id}`);
  }
}

@Injectable()
@Operation('fleet.approval_get')
export class FleetApprovalGetHandler implements OperationHandler {
  constructor(private readonly views: ApprovalViews) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const m = fleetMember(ctx);
    const body = await ctx.tx(
      async (scope) => (await this.views.many(scope, [await loadApproval(scope, m.orgId, ctx.params.approval_id!)], ctx.locale))[0]!,
      {
        readOnly: true,
      },
    );
    return { body };
  }
}

type ApprovalDecision = {
  decision: 'approved' | 'rejected' | 'needs_more_info';
  decision_reason?: string;
  selected_provider_organization_id?: string;
};

@Injectable()
@Operation('fleet.approval_decide')
export class FleetApprovalDecideHandler implements OperationHandler {
  constructor(
    private readonly views: ApprovalViews,
    private readonly orgs: OrgCards,
    private readonly vehicles: VehicleService,
  ) {}

  async handle(ctx: OperationContext<ApprovalDecision>): Promise<OperationResult> {
    const m = fleetMember(ctx);
    const b = ctx.body;
    const body = await ctx.tx(async (scope) => {
      const a = await loadApproval(scope, m.orgId, ctx.params.approval_id!, true);
      if (a.requested_by_user_id === m.userId) throw new ApiError('SELF_APPROVAL_FORBIDDEN', { detail: 'own request' });
      if (!['pending', 'needs_more_info'].includes(a.status)) throw new ApiError('INVALID_TRANSITION', { detail: a.status });
      if (b.selected_provider_organization_id) {
        // 40 ApprovalDecision: a provider may be chosen at once for a repair request only.
        if (a.approval_type !== 'repair_request' || b.decision !== 'approved')
          failIf([{ pointer: '/selected_provider_organization_id', code: 'conditional_forbidden' }]);
        const p = (await this.orgs.cards(scope, [b.selected_provider_organization_id])).get(b.selected_provider_organization_id);
        if (!p || !PROVIDER_TYPES.includes(p.organizationType) || p.status !== 'active')
          throw notFoundAt('/selected_provider_organization_id');
      }
      const row = await scope.db
        .updateTable('fleet.fleet_approvals')
        .set({
          status: b.decision,
          approver_user_id: m.userId,
          decided_at: sql<Date>`now()`,
          decision_reason: b.decision_reason ?? null,
          ...(b.selected_provider_organization_id ? { selected_provider_organization_id: b.selected_provider_organization_id } : {}),
        })
        .where('id', '=', a.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (a.related_issue_id && b.decision !== 'needs_more_info')
        await this.vehicles.setIssueApproval(scope, a.related_issue_id, b.decision);
      await writeAudit(scope, {
        action: 'fleet.approval_decided',
        entityType: 'fleet_approval',
        entityId: a.id,
        reason: b.decision_reason ?? null,
        previous: a.status,
        next: `${b.decision} (${a.approval_type})`,
      });
      await publishEvent(scope, {
        type: 'fleet.approval.decided',
        aggregateType: 'fleet_approval',
        aggregateId: a.id,
        payload: {
          organization_id: m.orgId,
          approval_id: a.id,
          approval_type: a.approval_type,
          status: b.decision,
          vehicle_id: a.vehicle_id,
          requested_by_user_id: a.requested_by_user_id,
        },
      });
      return (await this.views.many(scope, [row], ctx.locale))[0]!;
    });
    return { body };
  }
}
