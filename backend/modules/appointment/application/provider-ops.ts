// Provider operations (40 §16.3) under {prv}/appointments and {prv}/calendar.
// Confirmation re-checks capacity in the same transaction (Capacity, advisory
// lock per location); completion writes the appointment's service record
// through the vehicle interface (appointment_verified) and publishes
// appointment.completed, from which the trust module creates the review
// invitation (W4) and counts the evidence (W3). Internal notes stay with the
// provider; the requester's contact is shown only through
// appointment.requester_contact (provider.appointments_get, PII).
import { Injectable } from '@nestjs/common';
import { ApiError, type FieldError } from '#libs/contract/index.js';
import { created, Operation, ACK, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import { localParts, zonedToUtc, addDays } from '#libs/geo/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { OrgMemberships, UserCards, authorDisplayName } from '#modules/identity/interface/identity.js';
import { ProviderBooking } from '#modules/organization/interface/booking.js';
import { OrgLocations } from '#modules/organization/interface/vendor-catalog.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { VehicleService } from '#modules/vehicle/interface/vehicles.js';
import { toParticipant, toTimeOff, type AppointmentRow } from '../api/projections.js';
import { capacityCells, CAPACITY_STATUSES, OPEN_REQUEST_STATUSES, PROVIDER_GROUPS, transitionAllowed } from '../domain/rules.js';
import { activeRules, busyIntervals, toRuleInput } from '../infrastructure/calendar.js';
import { afterId, AppointmentViews, failIf, loadAsProvider, notFoundAt, pageOf, providerMember, setSide } from './common.js';
import { PreVisitReports } from './pre-visit.js';
import { Confirmation, listNotes, NoteViews, statusChanged } from './requester-ops.js';

type ProviderListQuery = {
  status?: string;
  group?: keyof typeof PROVIDER_GROUPS;
  location_id?: string;
  from?: string;
  to?: string;
  limit: number;
};

@Injectable()
@Operation('provider.appointments_list')
export class ProviderAppointmentsListHandler implements OperationHandler {
  constructor(private readonly views: AppointmentViews) {}

  async handle(ctx: OperationContext<undefined, ProviderListQuery>): Promise<OperationResult> {
    const m = providerMember(ctx);
    const q = ctx.query;
    const after = afterId(ctx);
    const body = await ctx.tx(
      async (scope) => {
        let s = scope.db
          .selectFrom('appointment.appointments')
          .selectAll()
          .where('provider_organization_id', '=', m.orgId)
          .where('status', '<>', 'draft')
          .where('deleted_at', 'is', null);
        if (q.status) s = s.where('status', '=', q.status as AppointmentRow['status']);
        if (q.group) s = s.where('status', 'in', [...PROVIDER_GROUPS[q.group]] as AppointmentRow['status'][]);
        const tz = ctx.timezone ?? 'UTC';
        if (q.group === 'today') {
          const today = localParts(new Date(), tz).date;
          s = s
            .where('confirmed_start_at', '>=', zonedToUtc(today, '00:00', tz))
            .where('confirmed_start_at', '<', zonedToUtc(addDays(today, 1), '00:00', tz));
        }
        if (q.group === 'upcoming') s = s.where('confirmed_start_at', '>', new Date());
        if (q.location_id) s = s.where('provider_location_id', '=', q.location_id);
        if (q.from) s = s.where('confirmed_start_at', '>=', zonedToUtc(q.from, '00:00', tz));
        if (q.to) s = s.where('confirmed_start_at', '<', zonedToUtc(addDays(q.to, 1), '00:00', tz));
        if (after) s = s.where('id', '<', after);
        const rows = await s
          .orderBy('id', 'desc')
          .limit(q.limit + 1)
          .execute();
        return pageOf(ctx, rows, await this.views.many(scope, rows.slice(0, q.limit), 'provider', ctx.locale));
      },
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('provider.appointments_get')
export class ProviderAppointmentsGetHandler implements OperationHandler {
  constructor(private readonly views: AppointmentViews) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const m = providerMember(ctx);
    const body = await ctx.tx(
      async (scope) =>
        this.views.one(scope, await loadAsProvider(scope, m.orgId, ctx.params.appointment_id!), 'provider', ctx.locale, { contact: true }),
      { readOnly: true },
    );
    return { body };
  }
}

type ProviderUpdate = {
  provider_location_id?: string;
  estimated_duration_minutes?: number;
  estimated_completion_from?: string;
  estimated_completion_to?: string;
  parts_availability_note?: string | null;
  cost_estimate?: { amount: string; currency: string };
};

@Injectable()
@Operation('provider.appointments_update')
export class ProviderAppointmentsUpdateHandler implements OperationHandler {
  constructor(
    private readonly locations: OrgLocations,
    private readonly views: AppointmentViews,
  ) {}

  async handle(ctx: OperationContext<ProviderUpdate>): Promise<OperationResult> {
    const m = providerMember(ctx);
    const b = ctx.body;
    const body = await ctx.tx(async (scope) => {
      const a = await loadAsProvider(scope, m.orgId, ctx.params.appointment_id!, true);
      if (ctx.ifMatch !== a.version) throw new ApiError('VERSION_MISMATCH');
      if (['completed', 'cancelled', 'no_show'].includes(a.status)) throw new ApiError('INVALID_TRANSITION', { detail: a.status });
      if (b.provider_location_id && b.provider_location_id !== a.provider_location_id) {
        // A confirmed appointment holds capacity at its location: it moves only before confirmation.
        if (!(OPEN_REQUEST_STATUSES as readonly string[]).includes(a.status))
          throw new ApiError('INVALID_TRANSITION', { detail: 'location fixed' });
        if (!(await this.locations.isActive(scope, m.orgId, b.provider_location_id))) throw notFoundAt('/provider_location_id');
      }
      const from = b.estimated_completion_from ?? a.estimated_completion_from;
      const to = b.estimated_completion_to ?? a.estimated_completion_to;
      if (from && to && new Date(to) < new Date(from)) failIf([{ pointer: '/estimated_completion_to', code: 'order' }]);
      const row = await scope.db
        .updateTable('appointment.appointments')
        .set({
          ...(b.provider_location_id !== undefined ? { provider_location_id: b.provider_location_id } : {}),
          ...(b.estimated_duration_minutes !== undefined ? { estimated_duration_minutes: b.estimated_duration_minutes } : {}),
          ...(b.estimated_completion_from !== undefined ? { estimated_completion_from: new Date(b.estimated_completion_from) } : {}),
          ...(b.estimated_completion_to !== undefined ? { estimated_completion_to: new Date(b.estimated_completion_to) } : {}),
          ...(b.parts_availability_note !== undefined ? { parts_availability_note: b.parts_availability_note } : {}),
          ...(b.cost_estimate ? { cost_estimate_amount: b.cost_estimate.amount, cost_estimate_currency: b.cost_estimate.currency } : {}),
        })
        .where('id', '=', a.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      // Fleet cost thresholds and approvals belong to the fleet module (S8): no fleet.approval.requested before it exists.
      return this.views.one(scope, row, 'provider', ctx.locale);
    });
    return { body };
  }
}

type Money = { amount: string; currency: string };
type ProviderTransition = {
  to: string;
  confirmed_start_at?: string;
  confirmed_end_at?: string;
  estimated_duration_minutes?: number;
  proposed_start_at?: string;
  proposed_end_at?: string;
  note?: string;
  cancellation_reason?: string;
  parts_availability_note?: string;
  estimated_completion_from?: string;
  estimated_completion_to?: string;
  final_cost?: Money;
  service_record?: {
    service_system_node_id: string;
    service_task_node_id?: string;
    description?: string;
    parts_used?: { name: string; part_number?: string; quantity: number; inventory_item_id?: string }[];
    cost_breakdown?: Record<string, string>;
    warranty_note?: string;
    mileage_km?: number;
  };
};

@Injectable()
@Operation('provider.appointments_transition')
export class ProviderAppointmentsTransitionHandler implements OperationHandler {
  constructor(
    private readonly confirmation: Confirmation,
    private readonly records: VehicleService,
    private readonly taxonomy: TaxonomyResolver,
    private readonly views: AppointmentViews,
  ) {}

  async handle(ctx: OperationContext<ProviderTransition>): Promise<OperationResult> {
    const m = providerMember(ctx);
    const b = ctx.body;
    const now = Date.now();
    const errors: FieldError[] = [];
    if (b.to === 'confirmed') {
      if (!b.confirmed_start_at) errors.push({ pointer: '/confirmed_start_at', code: 'conditional_required' });
      else if (Date.parse(b.confirmed_start_at) <= now) errors.push({ pointer: '/confirmed_start_at', code: 'in_past' });
      if (b.confirmed_start_at && b.confirmed_end_at && Date.parse(b.confirmed_end_at) <= Date.parse(b.confirmed_start_at))
        errors.push({ pointer: '/confirmed_end_at', code: 'order' });
    }
    if (b.to === 'alternative_proposed' && b.proposed_start_at && b.proposed_end_at) {
      if (Date.parse(b.proposed_start_at) <= now) errors.push({ pointer: '/proposed_start_at', code: 'in_past' });
      if (Date.parse(b.proposed_end_at) <= Date.parse(b.proposed_start_at)) errors.push({ pointer: '/proposed_end_at', code: 'order' });
    }
    if (b.to === 'requested') throw new ApiError('INVALID_TRANSITION', { detail: 'provider cannot set requested' });
    failIf(errors);
    if (b.to === 'completed' && b.service_record) {
      await this.taxonomy.require(b.service_record.service_system_node_id, ['service_system'], '/service_record/service_system_node_id');
      if (b.service_record.service_task_node_id) {
        await this.taxonomy.require(b.service_record.service_task_node_id, ['service_task'], '/service_record/service_task_node_id');
        await this.taxonomy.requireDescendant(
          b.service_record.service_task_node_id,
          b.service_record.service_system_node_id,
          '/service_record/service_task_node_id',
        );
      }
    }
    const body = await ctx.tx(async (scope) => {
      const a = await loadAsProvider(scope, m.orgId, ctx.params.appointment_id!, true);
      if (!transitionAllowed('provider', a.status, b.to)) throw new ApiError('INVALID_TRANSITION', { detail: `${a.status} -> ${b.to}` });
      let row: AppointmentRow;
      switch (b.to) {
        case 'confirmed':
          await setSide(scope, 'provider', null);
          row = await this.confirmation.confirm(
            scope,
            a,
            {
              start: new Date(b.confirmed_start_at!),
              end: b.confirmed_end_at ? new Date(b.confirmed_end_at) : null,
              duration: b.estimated_duration_minutes ?? null,
            },
            'provider',
          );
          return this.views.one(scope, row, 'provider', ctx.locale);
        case 'alternative_proposed':
          await setSide(scope, 'provider', b.note ?? null);
          row = await this.update(scope, a.id, {
            status: 'alternative_proposed',
            proposed_start_at: new Date(b.proposed_start_at!),
            proposed_end_at: new Date(b.proposed_end_at!),
          });
          break;
        case 'cancelled':
          await setSide(scope, 'provider', b.cancellation_reason ?? null);
          row = await this.update(scope, a.id, {
            status: 'cancelled',
            cancelled_by: 'provider',
            cancellation_reason: b.cancellation_reason!,
            check_in_token_hash: null,
          });
          break;
        case 'no_show':
          if (!a.confirmed_start_at || new Date(a.confirmed_start_at).getTime() > now)
            throw new ApiError('INVALID_TRANSITION', { detail: 'before the scheduled time' });
          await setSide(scope, 'provider', null);
          row = await this.update(scope, a.id, { status: 'no_show', check_in_token_hash: null });
          break;
        case 'awaiting_parts':
          await setSide(scope, 'provider', b.parts_availability_note ?? null);
          row = await this.update(scope, a.id, {
            status: 'awaiting_parts',
            ...(b.parts_availability_note !== undefined ? { parts_availability_note: b.parts_availability_note } : {}),
            ...(b.estimated_completion_from ? { estimated_completion_from: new Date(b.estimated_completion_from) } : {}),
            ...(b.estimated_completion_to ? { estimated_completion_to: new Date(b.estimated_completion_to) } : {}),
          });
          break;
        case 'completed':
          row = await this.complete(scope, a, b);
          return this.views.one(scope, row, 'provider', ctx.locale);
        default:
          await setSide(scope, 'provider', null);
          row = await this.update(scope, a.id, { status: b.to as AppointmentRow['status'] });
      }
      await statusChanged(scope, a, row, 'provider');
      return this.views.one(scope, row, 'provider', ctx.locale);
    });
    return { body };
  }

  private update(scope: TxScope, id: string, set: Record<string, unknown>): Promise<AppointmentRow> {
    return scope.db.updateTable('appointment.appointments').set(set).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
  }

  /** 52 §21 completion: through confirmed / checked_in, with completed_at and the service record (one per appointment). */
  private async complete(scope: TxScope, a: AppointmentRow, b: ProviderTransition): Promise<AppointmentRow> {
    await setSide(scope, 'provider', null);
    const row = await this.update(scope, a.id, { status: 'completed', check_in_token_hash: null });
    const sr = b.service_record;
    const system = sr?.service_system_node_id ?? a.service_system_node_id;
    let recordId: string | null = null;
    if (system) {
      recordId = await this.records.recordAppointmentService(scope, {
        vehicleId: a.vehicle_id,
        appointmentId: a.id,
        providerOrganizationId: a.provider_organization_id,
        serviceDate: new Date(row.completed_at!).toISOString().slice(0, 10),
        serviceSystemNodeId: system,
        serviceTaskNodeId: sr ? (sr.service_task_node_id ?? null) : a.service_task_node_id,
        description: sr?.description ?? null,
        mileageKm: sr?.mileage_km ?? null,
        partsUsed: (sr?.parts_used ?? []).map((p) => ({
          name: p.name,
          ...(p.part_number ? { part_number: p.part_number } : {}),
          quantity: p.quantity,
        })),
        cost: b.final_cost ?? null,
        costBreakdown: sr?.cost_breakdown ?? null,
        warrantyNote: sr?.warranty_note ?? null,
      });
    }
    await statusChanged(scope, a, row, 'provider');
    await publishEvent(scope, {
      type: 'appointment.completed',
      aggregateType: 'appointment',
      aggregateId: row.id,
      payload: {
        provider_organization_id: row.provider_organization_id,
        requester_user_id: row.requester_user_id,
        requester_type: row.requester_type,
        requester_organization_id: row.requester_organization_id,
        vehicle_id: row.vehicle_id,
        service_system_node_id: system,
        service_record_id: recordId,
        organization_id: row.provider_organization_id,
      },
    });
    return row;
  }
}

@Injectable()
@Operation('provider.participants_list')
export class ProviderParticipantsListHandler implements OperationHandler {
  constructor(private readonly users: UserCards) {}

  async handle(ctx: OperationContext<undefined, { limit: number }>): Promise<OperationResult> {
    const m = providerMember(ctx);
    const body = await ctx.tx(
      async (scope) => {
        const a = await loadAsProvider(scope, m.orgId, ctx.params.appointment_id!);
        const after = afterId(ctx);
        let q = scope.db
          .selectFrom('appointment.appointment_participants')
          .selectAll()
          .where('appointment_id', '=', a.id)
          .where('status', '=', 'active')
          .where('deleted_at', 'is', null);
        if (after) q = q.where('id', '>', after);
        const rows = await q
          .orderBy('id')
          .limit(ctx.query.limit + 1)
          .execute();
        const users = await this.users.cards(
          scope,
          rows.map((r) => r.user_id),
        );
        return pageOf(
          ctx,
          rows,
          rows.slice(0, ctx.query.limit).map((p) => toParticipant(p, authorDisplayName(users.get(p.user_id), ctx.locale))),
        );
      },
      { readOnly: true },
    );
    return { body };
  }
}

const PROVIDER_ROLES = ['provider_owner', 'provider_manager', 'provider_staff'];

@Injectable()
@Operation('provider.participant_add')
export class ProviderParticipantAddHandler implements OperationHandler {
  constructor(
    private readonly memberships: OrgMemberships,
    private readonly users: UserCards,
  ) {}

  async handle(ctx: OperationContext<{ user_id: string; participant_role: 'service_advisor' | 'technician' }>): Promise<OperationResult> {
    const m = providerMember(ctx);
    const body = await ctx.tx(async (scope) => {
      const a = await loadAsProvider(scope, m.orgId, ctx.params.appointment_id!);
      const member = await this.memberships.findLive(scope, m.orgId, { userId: ctx.body.user_id });
      if (!member || member.status !== 'active' || !PROVIDER_ROLES.includes(member.role))
        throw ApiError.validation([{ pointer: '/user_id', code: 'reference_not_found' }], 'REFERENCE_NOT_FOUND');
      const existing = await scope.db
        .selectFrom('appointment.appointment_participants')
        .selectAll()
        .where('appointment_id', '=', a.id)
        .where('user_id', '=', ctx.body.user_id)
        .where('participant_role', '=', ctx.body.participant_role)
        .where('status', '=', 'active')
        .executeTakeFirst();
      const row =
        existing ??
        (await scope.db
          .insertInto('appointment.appointment_participants')
          .values({
            appointment_id: a.id,
            user_id: ctx.body.user_id,
            organization_id: m.orgId,
            participant_role: ctx.body.participant_role,
          })
          .returningAll()
          .executeTakeFirstOrThrow());
      const users = await this.users.cards(scope, [row.user_id]);
      return toParticipant(row, authorDisplayName(users.get(row.user_id), ctx.locale));
    });
    return created(body, `/v1/orgs/${m.orgId}/provider/appointments/${ctx.params.appointment_id}/participants/${body.id}`);
  }
}

@Injectable()
@Operation('provider.participant_remove')
export class ProviderParticipantRemoveHandler implements OperationHandler {
  async handle(ctx: OperationContext): Promise<OperationResult> {
    const m = providerMember(ctx);
    await ctx.tx(async (scope) => {
      const a = await loadAsProvider(scope, m.orgId, ctx.params.appointment_id!);
      // Only the provider's own staff assignments; the requester side stays.
      const r = await scope.db
        .updateTable('appointment.appointment_participants')
        .set({ status: 'removed' })
        .where('id', '=', ctx.params.participant_id!)
        .where('appointment_id', '=', a.id)
        .where('organization_id', '=', m.orgId)
        .where('participant_role', 'in', ['service_advisor', 'technician'])
        .where('status', '=', 'active')
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) === 0) throw new ApiError('NOT_FOUND');
    });
    return { body: ACK };
  }
}

@Injectable()
@Operation('provider.notes_list')
export class ProviderNotesListHandler implements OperationHandler {
  constructor(private readonly notes: NoteViews) {}

  async handle(ctx: OperationContext<undefined, { limit: number }>): Promise<OperationResult> {
    const m = providerMember(ctx);
    const body = await ctx.tx(
      async (scope) => {
        const a = await loadAsProvider(scope, m.orgId, ctx.params.appointment_id!);
        const rows = await listNotes(scope, a.id, false, afterId(ctx), ctx.query.limit);
        return pageOf(ctx, rows, await this.notes.many(scope, a, rows.slice(0, ctx.query.limit), 'provider', ctx.locale));
      },
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('provider.note_create')
export class ProviderNoteCreateHandler implements OperationHandler {
  constructor(private readonly notes: NoteViews) {}

  async handle(ctx: OperationContext<{ note_type: 'internal' | 'customer_visible'; body: string; content_locale: string }>) {
    const m = providerMember(ctx);
    const body = await ctx.tx(async (scope) => {
      const a = await loadAsProvider(scope, m.orgId, ctx.params.appointment_id!);
      const n = await scope.db
        .insertInto('appointment.appointment_notes')
        .values({
          appointment_id: a.id,
          author_user_id: m.userId,
          author_side: 'provider',
          note_type: ctx.body.note_type,
          body: ctx.body.body,
          content_locale: ctx.body.content_locale,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      if (n.note_type === 'customer_visible')
        await publishEvent(scope, {
          type: 'appointment.note_added',
          aggregateType: 'appointment',
          aggregateId: a.id,
          payload: { author_side: 'provider', note_type: 'customer_visible', requester_user_id: a.requester_user_id },
        });
      return (await this.notes.many(scope, a, [n], 'provider', ctx.locale))[0]!;
    });
    return created(body, `/v1/orgs/${m.orgId}/provider/appointments/${ctx.params.appointment_id}/notes`) satisfies OperationResult;
  }
}

@Injectable()
@Operation('pre_visit.provider_get')
export class PreVisitProviderGetHandler implements OperationHandler {
  constructor(private readonly reports: PreVisitReports) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const m = providerMember(ctx);
    const body = await ctx.tx(
      async (scope) => {
        const a = await loadAsProvider(scope, m.orgId, ctx.params.appointment_id!);
        const view = await this.reports.view(scope, a, 'provider', ctx.locale);
        if (!view) throw new ApiError('NOT_FOUND');
        return view;
      },
      { readOnly: true },
    );
    return { body };
  }
}

const MAX_CALENDAR_DAYS = 31;

@Injectable()
@Operation('provider.calendar')
export class ProviderCalendarHandler implements OperationHandler {
  constructor(
    private readonly booking: ProviderBooking,
    private readonly views: AppointmentViews,
  ) {}

  async handle(ctx: OperationContext<undefined, { from: string; to: string; location_id?: string }>): Promise<OperationResult> {
    const m = providerMember(ctx);
    const q = ctx.query;
    const days = Math.round((Date.parse(`${q.to}T00:00:00Z`) - Date.parse(`${q.from}T00:00:00Z`)) / 86_400_000) + 1;
    if (days < 1) failIf([{ pointer: '/to', code: 'order' }]);
    if (days > MAX_CALENDAR_DAYS) failIf([{ pointer: '/to', code: 'out_of_range' }]);
    const body = await ctx.tx(
      async (scope) => {
        const locationIds = q.location_id ? [q.location_id] : await this.booking.locationIds(scope, m.orgId);
        const locations = await this.booking.locations(scope, locationIds, ctx.locale);
        if (q.location_id && locations.get(q.location_id)?.organizationId !== m.orgId) throw new ApiError('NOT_FOUND');
        const tz = locations.get(locationIds[0] ?? '')?.timezone ?? ctx.timezone ?? 'UTC';
        const from = zonedToUtc(q.from, '00:00', tz);
        const to = zonedToUtc(addDays(q.to, 1), '00:00', tz);
        let s = scope.db
          .selectFrom('appointment.appointments')
          .selectAll()
          .where('provider_organization_id', '=', m.orgId)
          .where('status', 'in', [...CAPACITY_STATUSES, 'completed', 'no_show'])
          .where('confirmed_start_at', '>=', from)
          .where('confirmed_start_at', '<', to)
          .where('deleted_at', 'is', null);
        if (q.location_id) s = s.where('provider_location_id', '=', q.location_id);
        const rows = await s.orderBy('confirmed_start_at').orderBy('id').limit(500).execute();
        let t = scope.db
          .selectFrom('appointment.provider_time_off')
          .selectAll()
          .where('provider_organization_id', '=', m.orgId)
          .where('status', '=', 'active')
          .where('deleted_at', 'is', null)
          .where('start_at', '<', to)
          .where('end_at', '>', from);
        if (q.location_id) t = t.where((eb) => eb.or([eb('location_id', 'is', null), eb('location_id', '=', q.location_id!)]));
        const timeOff = await t.orderBy('start_at').limit(100).execute();
        const capacity = [];
        for (const id of locationIds) {
          const loc = locations.get(id);
          if (!loc) continue;
          const rules = (await activeRules(scope, m.orgId, id)).map(toRuleInput);
          if (rules.length === 0) continue;
          const busy = await busyIntervals(scope, m.orgId, id, from, to);
          for (const c of capacityCells({ rules, timezone: loc.timezone, from: q.from, days, busy }))
            capacity.push({ location_id: c.location_id, start_at: c.start_at, end_at: c.end_at, used: c.used, max: c.max });
        }
        return {
          from: from.toISOString(),
          to: to.toISOString(),
          appointments: await this.views.many(scope, rows, 'provider', ctx.locale),
          time_off: timeOff.map(toTimeOff),
          capacity: capacity.slice(0, 2000),
        };
      },
      { readOnly: true },
    );
    return { body };
  }
}
