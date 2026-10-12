// Maintenance reminders (40 §12.2, 52 MaintenanceReminder): reminders.list /
// create / update / delete. Owners add manual reminders due by date,
// mileage or both; rule, AI and fleet-policy reminders are only snoozed,
// completed or dismissed. The status (upcoming → due → overdue) is computed
// at every write and by the hourly W15 rule (reminder-rule.ts).
import { Injectable } from '@nestjs/common';
import { ApiError, type FieldError } from '#libs/contract/index.js';
import { ACK, created, Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { toReminder, type ReminderRow, type VehicleRow } from '../api/projections.js';
import { reminderStatus, todayUtc } from '../domain/rules.js';
import { afterId, checkVersion, failIf, loadVehicle, pageOf, vehicleAccess, vehiclesPath } from './common.js';

type ReminderWrite = {
  reminder_type: string;
  title: string;
  reason?: string;
  due_by_mileage_km?: number;
  due_by_date?: string;
  priority: 'low' | 'medium' | 'high';
};
type ReminderPatch = Partial<ReminderWrite> & { snoozed_until?: string; status?: 'completed' | 'dismissed' };

const FINAL = ['completed', 'dismissed'];

async function loadReminder(scope: TxScope, v: VehicleRow, id: string, lock = false): Promise<ReminderRow> {
  const q = scope.db
    .selectFrom('vehicle.maintenance_reminders')
    .selectAll()
    .where('id', '=', id)
    .where('vehicle_id', '=', v.id)
    .where('deleted_at', 'is', null);
  const row = await (lock ? q.forUpdate() : q).executeTakeFirst();
  if (!row) throw new ApiError('NOT_FOUND');
  return row;
}

@Injectable()
@Operation('reminders.list')
export class RemindersListHandler implements OperationHandler {
  async handle(ctx: OperationContext<undefined, { status?: string; limit: number }>): Promise<OperationResult> {
    const a = vehicleAccess(ctx);
    const after = afterId(ctx);
    const rows = await ctx.tx(
      async (scope) => {
        const v = await loadVehicle(scope, a, ctx.params.vehicle_id!);
        let q = scope.db
          .selectFrom('vehicle.maintenance_reminders')
          .selectAll()
          .where('vehicle_id', '=', v.id)
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
    return { body: pageOf(ctx, rows, toReminder) };
  }
}

@Injectable()
@Operation('reminders.create')
export class RemindersCreateHandler implements OperationHandler {
  async handle(ctx: OperationContext<ReminderWrite>): Promise<OperationResult> {
    const a = vehicleAccess(ctx);
    const b = ctx.body;
    const today = todayUtc();
    const errors: FieldError[] = [];
    // C: at least one due field; a due date is today or later when created (52).
    if (b.due_by_date === undefined && b.due_by_mileage_km === undefined)
      errors.push({ pointer: '/due_by_date', code: 'conditional_required' });
    if (b.due_by_date !== undefined && b.due_by_date < today) errors.push({ pointer: '/due_by_date', code: 'in_past' });
    failIf(errors);
    const row = await ctx.tx(async (scope) => {
      const v = await loadVehicle(scope, a, ctx.params.vehicle_id!);
      const status = reminderStatus(
        { status: 'upcoming', due_by_date: b.due_by_date ?? null, due_by_mileage_km: b.due_by_mileage_km ?? null, snoozed_until: null },
        v.mileage_km,
        today,
      );
      return scope.db
        .insertInto('vehicle.maintenance_reminders')
        .values({
          vehicle_id: v.id,
          reminder_type: b.reminder_type,
          title: b.title,
          reason: b.reason ?? null,
          source: 'manual',
          due_by_mileage_km: b.due_by_mileage_km ?? null,
          due_by_date: b.due_by_date ?? null,
          priority: b.priority,
          status,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    return created(toReminder(row), `${vehiclesPath(a)}/${row.vehicle_id}/reminders/${row.id}`);
  }
}

@Injectable()
@Operation('reminders.update')
export class RemindersUpdateHandler implements OperationHandler {
  async handle(ctx: OperationContext<ReminderPatch>): Promise<OperationResult> {
    const a = vehicleAccess(ctx);
    const b = ctx.body;
    const today = todayUtc();
    if (b.snoozed_until !== undefined && b.snoozed_until <= today) failIf([{ pointer: '/snoozed_until', code: 'in_past' }]);
    const row = await ctx.tx(async (scope) => {
      const v = await loadVehicle(scope, a, ctx.params.vehicle_id!);
      const r = await loadReminder(scope, v, ctx.params.reminder_id!, true);
      checkVersion(r.version, ctx.ifMatch);
      if (FINAL.includes(r.status)) throw new ApiError('INVALID_TRANSITION', { detail: `reminder is ${r.status}` });
      const edits = (['reminder_type', 'title', 'reason', 'due_by_mileage_km', 'due_by_date', 'priority'] as const).filter(
        (k) => b[k] !== undefined,
      );
      // Only manual reminders are edited; others are snoozed, completed or dismissed (40 reminders.update).
      if (edits.length && r.source !== 'manual') throw new ApiError('INVALID_TRANSITION', { detail: 'not_editable' });
      const merged = {
        status: (b.status ?? r.status) as ReminderRow['status'],
        due_by_date: b.due_by_date ?? r.due_by_date,
        due_by_mileage_km: b.due_by_mileage_km ?? r.due_by_mileage_km,
        snoozed_until: b.snoozed_until ?? r.snoozed_until,
      };
      const set: Record<string, unknown> = Object.fromEntries(edits.map((k) => [k, b[k]]));
      if (b.snoozed_until !== undefined) set.snoozed_until = b.snoozed_until;
      set.status = reminderStatus(merged as Parameters<typeof reminderStatus>[0], v.mileage_km, today);
      return scope.db.updateTable('vehicle.maintenance_reminders').set(set).where('id', '=', r.id).returningAll().executeTakeFirstOrThrow();
    });
    return { body: toReminder(row) };
  }
}

@Injectable()
@Operation('reminders.delete')
export class RemindersDeleteHandler implements OperationHandler {
  async handle(ctx: OperationContext): Promise<OperationResult> {
    const a = vehicleAccess(ctx);
    await ctx.tx(async (scope) => {
      const v = await loadVehicle(scope, a, ctx.params.vehicle_id!);
      const r = await loadReminder(scope, v, ctx.params.reminder_id!, true);
      if (r.source !== 'manual') throw new ApiError('INVALID_TRANSITION', { detail: 'not_editable' });
      await scope.db.updateTable('vehicle.maintenance_reminders').set({ deleted_at: new Date() }).where('id', '=', r.id).execute();
    });
    return { body: ACK };
  }
}
