// Provider calendar settings (40 §16.3 availability.*) and public.availability
// (40 §14.3). Weekly rules per location (0 = Sunday in the location's time
// zone, DI-29), concurrency and buffers behind ENT(appointment_capacity_tools_
// enabled); time off for one or all locations, listing the confirmed
// appointments it overlaps; open slots computed from rules, buffers, capacity,
// time off and existing appointments (domain/rules.ts openSlots). A
// location without rules has no calendar: no slots are offered (S7).
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { ApiError, type FieldError } from '#libs/contract/index.js';
import { EntitlementChecker, requireEntitlement } from '#libs/entitlements/index.js';
import { ACK, created, Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { ProviderBooking } from '#modules/organization/interface/booking.js';
import { PublicProfiles } from '#modules/organization/interface/public-profiles.js';
import { OrgLocations } from '#modules/organization/interface/vendor-catalog.js';
import { toRule, toTimeOff } from '../api/projections.js';
import { CAPACITY_STATUSES, openSlots, todayIn } from '../domain/rules.js';
import { activeRules, busyIntervals, toRuleInput } from '../infrastructure/calendar.js';
import { afterId, failIf, notFoundAt, pageOf, providerMember } from './common.js';
import { addDays, zonedToUtc } from '#libs/geo/index.js';

/** Calendar edits change the provider's open slots (W2 reindexes its next available slot). */
async function availabilityChanged(scope: TxScope, orgId: string): Promise<void> {
  await publishEvent(scope, {
    type: 'appointment.availability.changed',
    aggregateType: 'organization',
    aggregateId: orgId,
    payload: { organization_id: orgId },
  });
}

type RuleWrite = {
  location_id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  slot_duration_minutes: number;
  appointment_types?: string[];
  max_concurrent_appointments: number;
  buffer_minutes?: number;
  effective_from?: string;
  effective_to?: string;
  status?: 'active' | 'inactive';
};

function ruleErrors(r: Partial<RuleWrite>): FieldError[] {
  const errors: FieldError[] = [];
  if (r.start_time && r.end_time && r.end_time <= r.start_time) errors.push({ pointer: '/end_time', code: 'order' });
  if (r.effective_from && r.effective_to && r.effective_to < r.effective_from) errors.push({ pointer: '/effective_to', code: 'order' });
  return errors;
}

/** ENT(appointment_capacity_tools_enabled: concurrency > 1 or buffers). */
async function capacityTools(checker: EntitlementChecker, scope: TxScope, orgId: string, r: Partial<RuleWrite>): Promise<void> {
  if ((r.max_concurrent_appointments ?? 1) > 1 || (r.buffer_minutes ?? 0) > 0)
    await requireEntitlement(checker, scope, { type: 'organization', id: orgId }, 'appointment_capacity_tools_enabled', 0);
}

@Injectable()
@Operation('availability.rules_list')
export class AvailabilityRulesListHandler implements OperationHandler {
  async handle(ctx: OperationContext<undefined, { location_id?: string; limit: number }>): Promise<OperationResult> {
    const m = providerMember(ctx);
    const after = afterId(ctx);
    const body = await ctx.tx(
      async (scope) => {
        let q = scope.db
          .selectFrom('appointment.provider_availability_rules')
          .selectAll()
          .where('provider_organization_id', '=', m.orgId)
          .where('deleted_at', 'is', null);
        if (ctx.query.location_id) q = q.where('location_id', '=', ctx.query.location_id);
        if (after) q = q.where('id', '>', after);
        const rows = await q
          .orderBy('id')
          .limit(ctx.query.limit + 1)
          .execute();
        return pageOf(ctx, rows, rows.slice(0, ctx.query.limit).map(toRule));
      },
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('availability.rule_create')
export class AvailabilityRuleCreateHandler implements OperationHandler {
  constructor(
    private readonly locations: OrgLocations,
    private readonly entitlements: EntitlementChecker,
  ) {}

  async handle(ctx: OperationContext<RuleWrite>): Promise<OperationResult> {
    const m = providerMember(ctx);
    const b = ctx.body;
    failIf(ruleErrors(b));
    const body = await ctx.tx(async (scope) => {
      if (!(await this.locations.isActive(scope, m.orgId, b.location_id))) throw notFoundAt('/location_id');
      await capacityTools(this.entitlements, scope, m.orgId, b);
      const row = await scope.db
        .insertInto('appointment.provider_availability_rules')
        .values({
          provider_organization_id: m.orgId,
          location_id: b.location_id,
          day_of_week: b.day_of_week,
          start_time: b.start_time,
          end_time: b.end_time,
          slot_duration_minutes: b.slot_duration_minutes,
          appointment_types: b.appointment_types ?? [],
          max_concurrent_appointments: b.max_concurrent_appointments,
          buffer_minutes: b.buffer_minutes ?? 0,
          effective_from: b.effective_from ?? null,
          effective_to: b.effective_to ?? null,
          status: b.status ?? 'active',
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await availabilityChanged(scope, m.orgId);
      return toRule(row);
    });
    return created(body, `/v1/orgs/${m.orgId}/provider/availability-rules/${body.id}`);
  }
}

@Injectable()
@Operation('availability.rule_update')
export class AvailabilityRuleUpdateHandler implements OperationHandler {
  constructor(
    private readonly locations: OrgLocations,
    private readonly entitlements: EntitlementChecker,
  ) {}

  async handle(ctx: OperationContext<Partial<RuleWrite>>): Promise<OperationResult> {
    const m = providerMember(ctx);
    const b = ctx.body;
    const body = await ctx.tx(async (scope) => {
      const r = await scope.db
        .selectFrom('appointment.provider_availability_rules')
        .selectAll()
        .where('id', '=', ctx.params.rule_id!)
        .where('provider_organization_id', '=', m.orgId)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!r) throw new ApiError('NOT_FOUND');
      if (ctx.ifMatch !== r.version) throw new ApiError('VERSION_MISMATCH');
      const current = toRule(r);
      const merged = { ...current, ...b };
      failIf(ruleErrors(merged));
      if (b.location_id && b.location_id !== r.location_id && !(await this.locations.isActive(scope, m.orgId, b.location_id)))
        throw notFoundAt('/location_id');
      if (b.max_concurrent_appointments !== undefined || b.buffer_minutes !== undefined)
        await capacityTools(this.entitlements, scope, m.orgId, merged);
      // Confirmed appointments are not changed (40 availability.rule_update): only future confirmations and slots use the new rule.
      const row = await scope.db
        .updateTable('appointment.provider_availability_rules')
        .set({
          ...(b.location_id !== undefined ? { location_id: b.location_id } : {}),
          ...(b.day_of_week !== undefined ? { day_of_week: b.day_of_week } : {}),
          ...(b.start_time !== undefined ? { start_time: b.start_time } : {}),
          ...(b.end_time !== undefined ? { end_time: b.end_time } : {}),
          ...(b.slot_duration_minutes !== undefined ? { slot_duration_minutes: b.slot_duration_minutes } : {}),
          ...(b.appointment_types !== undefined ? { appointment_types: b.appointment_types } : {}),
          ...(b.max_concurrent_appointments !== undefined ? { max_concurrent_appointments: b.max_concurrent_appointments } : {}),
          ...(b.buffer_minutes !== undefined ? { buffer_minutes: b.buffer_minutes } : {}),
          ...(b.effective_from !== undefined ? { effective_from: b.effective_from } : {}),
          ...(b.effective_to !== undefined ? { effective_to: b.effective_to } : {}),
          ...(b.status !== undefined ? { status: b.status } : {}),
        })
        .where('id', '=', r.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await availabilityChanged(scope, m.orgId);
      return toRule(row);
    });
    return { body };
  }
}

@Injectable()
@Operation('availability.rule_delete')
export class AvailabilityRuleDeleteHandler implements OperationHandler {
  async handle(ctx: OperationContext): Promise<OperationResult> {
    const m = providerMember(ctx);
    await ctx.tx(async (scope) => {
      const r = await scope.db
        .updateTable('appointment.provider_availability_rules')
        .set({ status: 'inactive' })
        .where('id', '=', ctx.params.rule_id!)
        .where('provider_organization_id', '=', m.orgId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) === 0) throw new ApiError('NOT_FOUND');
      await availabilityChanged(scope, m.orgId);
    });
    return { body: ACK };
  }
}

@Injectable()
@Operation('availability.time_off_list')
export class AvailabilityTimeOffListHandler implements OperationHandler {
  async handle(ctx: OperationContext<undefined, { from?: string; to?: string; limit: number }>): Promise<OperationResult> {
    const m = providerMember(ctx);
    const after = afterId(ctx);
    const body = await ctx.tx(
      async (scope) => {
        let q = scope.db
          .selectFrom('appointment.provider_time_off')
          .selectAll()
          .where('provider_organization_id', '=', m.orgId)
          .where('deleted_at', 'is', null);
        if (ctx.query.from) q = q.where('end_at', '>', new Date(`${ctx.query.from}T00:00:00Z`));
        if (ctx.query.to) q = q.where('start_at', '<', new Date(`${addDays(ctx.query.to, 1)}T00:00:00Z`));
        if (after) q = q.where('id', '>', after);
        const rows = await q
          .orderBy('id')
          .limit(ctx.query.limit + 1)
          .execute();
        return pageOf(ctx, rows, rows.slice(0, ctx.query.limit).map(toTimeOff));
      },
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('availability.time_off_create')
export class AvailabilityTimeOffCreateHandler implements OperationHandler {
  constructor(private readonly locations: OrgLocations) {}

  async handle(
    ctx: OperationContext<{ location_id?: string; start_at: string; end_at: string; reason?: string }>,
  ): Promise<OperationResult> {
    const m = providerMember(ctx);
    const b = ctx.body;
    if (Date.parse(b.end_at) <= Date.parse(b.start_at)) failIf([{ pointer: '/end_at', code: 'order' }]);
    const body = await ctx.tx(async (scope) => {
      if (b.location_id && !(await this.locations.isActive(scope, m.orgId, b.location_id))) throw notFoundAt('/location_id');
      const row = await scope.db
        .insertInto('appointment.provider_time_off')
        .values({
          provider_organization_id: m.orgId,
          location_id: b.location_id ?? null,
          start_at: new Date(b.start_at),
          end_at: new Date(b.end_at),
          reason: b.reason ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      // Overlapping confirmed appointments stay as they are; the provider decides what to do with them.
      let q = scope.db
        .selectFrom('appointment.appointments')
        .select('id')
        .where('provider_organization_id', '=', m.orgId)
        .where('status', 'in', [...CAPACITY_STATUSES])
        .where('deleted_at', 'is', null)
        .where('confirmed_start_at', '<', row.end_at)
        .where(sql<boolean>`coalesce(confirmed_end_at, confirmed_start_at + interval '1 minute') > ${row.start_at}`);
      if (row.location_id) q = q.where('provider_location_id', '=', row.location_id);
      const conflicts = await q.orderBy('confirmed_start_at').limit(200).execute();
      await availabilityChanged(scope, m.orgId);
      return { time_off: toTimeOff(row), conflicting_appointment_ids: conflicts.map((c) => c.id) };
    });
    return created(body, `/v1/orgs/${m.orgId}/provider/time-off/${body.time_off.id}`);
  }
}

@Injectable()
@Operation('availability.time_off_cancel')
export class AvailabilityTimeOffCancelHandler implements OperationHandler {
  async handle(ctx: OperationContext): Promise<OperationResult> {
    const m = providerMember(ctx);
    await ctx.tx(async (scope) => {
      const r = await scope.db
        .updateTable('appointment.provider_time_off')
        .set({ status: 'cancelled' })
        .where('id', '=', ctx.params.time_off_id!)
        .where('provider_organization_id', '=', m.orgId)
        .where('status', '=', 'active')
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) === 0) throw new ApiError('NOT_FOUND');
      await availabilityChanged(scope, m.orgId);
    });
    return { body: ACK };
  }
}

type AvailabilityQuery = { location_id: string; from: string; days: number; appointment_type?: string };

@Injectable()
@Operation('public.availability')
export class PublicAvailabilityHandler implements OperationHandler {
  constructor(
    private readonly profiles: PublicProfiles,
    private readonly booking: ProviderBooking,
  ) {}

  async handle(ctx: OperationContext<undefined, AvailabilityQuery>): Promise<OperationResult> {
    const orgId = ctx.params.org_id!;
    const q = ctx.query;
    const body = await ctx.tx(
      async (scope) => {
        const card = (await this.profiles.cards(scope, [orgId])).get(orgId);
        if (!card?.roles.includes('provider')) throw new ApiError('NOT_FOUND');
        const pins = (await this.profiles.pins(scope, [orgId])).get(orgId) ?? [];
        if (!pins.some((p) => p.location_id === q.location_id))
          throw ApiError.validation([{ pointer: '/location_id', code: 'reference_not_found' }], 'REFERENCE_NOT_FOUND');
        const location = (await this.booking.locations(scope, [q.location_id], ctx.locale)).get(q.location_id);
        if (!location) return { slots: [] };
        const rules = (await activeRules(scope, orgId, q.location_id)).map(toRuleInput);
        if (rules.length === 0) return { slots: [] };
        const now = new Date();
        // Never before today in the location's time zone.
        const from = q.from < todayIn(location.timezone, now) ? todayIn(location.timezone, now) : q.from;
        const start = zonedToUtc(from, '00:00', location.timezone);
        const end = zonedToUtc(addDays(from, q.days), '00:00', location.timezone);
        const [busy, timeOff] = await Promise.all([
          busyIntervals(scope, orgId, q.location_id, start, end),
          scope.db
            .selectFrom('appointment.provider_time_off')
            .select(['start_at', 'end_at'])
            .where('provider_organization_id', '=', orgId)
            .where('status', '=', 'active')
            .where('deleted_at', 'is', null)
            .where((eb) => eb.or([eb('location_id', 'is', null), eb('location_id', '=', q.location_id)]))
            .where('start_at', '<', end)
            .where('end_at', '>', start)
            .execute(),
        ]);
        return {
          slots: openSlots({
            rules,
            timezone: location.timezone,
            from,
            days: q.days,
            busy,
            timeOff: timeOff.map((t) => ({ start: new Date(t.start_at), end: new Date(t.end_at) })),
            now,
            ...(q.appointment_type ? { type: q.appointment_type } : {}),
          }),
        };
      },
      { readOnly: true },
    );
    return { body, cache: { public: 60 } };
  }
}
