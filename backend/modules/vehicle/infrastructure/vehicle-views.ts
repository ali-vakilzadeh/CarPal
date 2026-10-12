// Derived values of 40 Vehicle, computed per request in the owner's context
// and batched for lists: open issues, the next reminder date, the primary
// photo URL (media, signed for the owner) and the duplicate VIN warning
// (definer vehicle.duplicate_vin_flags: other owners stay invisible).
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { TxScope } from '#libs/tenancy/index.js';
import { MediaService } from '#modules/media/interface/media.js';
import { toVehicle, type VehicleDerived, type VehicleRow } from '../api/projections.js';

@Injectable()
export class VehicleViews {
  constructor(private readonly media: MediaService) {}

  async derived(scope: TxScope, rows: readonly VehicleRow[]): Promise<Map<string, VehicleDerived>> {
    const ids = rows.map((r) => r.id);
    const out = new Map<string, VehicleDerived>();
    if (ids.length === 0) return out;
    const issues = await scope.db
      .selectFrom('vehicle.vehicle_issues')
      .select(['vehicle_id', (eb) => eb.fn.countAll<string>().as('n')])
      .where('vehicle_id', 'in', ids)
      .where('status', 'in', ['open', 'investigating', 'scheduled'])
      .where('deleted_at', 'is', null)
      .groupBy('vehicle_id')
      .execute();
    const reminders = await scope.db
      .selectFrom('vehicle.maintenance_reminders')
      .select(['vehicle_id', (eb) => eb.fn.min<string>('due_by_date').as('next')])
      .where('vehicle_id', 'in', ids)
      .where('status', 'in', ['upcoming', 'due', 'overdue'])
      .where('due_by_date', 'is not', null)
      .where('deleted_at', 'is', null)
      .groupBy('vehicle_id')
      .execute();
    const { rows: dup } = await sql<{ id: string }>`SELECT id FROM vehicle.duplicate_vin_flags(${sql.val(ids)}::uuid[])`.execute(scope.db);
    const photos = await this.media.assetUrls(
      scope,
      rows.map((r) => r.primary_photo_media_id).filter((x): x is string => !!x),
    );
    const openIssues = new Map(issues.map((i) => [i.vehicle_id, Number(i.n)]));
    const next = new Map(reminders.map((r) => [r.vehicle_id, r.next]));
    const duplicates = new Set(dup.map((d) => d.id));
    for (const r of rows)
      out.set(r.id, {
        // Driver assignments arrive with the fleet module (S8).
        assignedDriver: null,
        openIssueCount: openIssues.get(r.id) ?? 0,
        nextReminderDue: next.get(r.id) ?? null,
        primaryPhotoUrl: r.primary_photo_media_id ? (photos.get(r.primary_photo_media_id) ?? null) : null,
        duplicateVinWarning: duplicates.has(r.id),
      });
    return out;
  }

  async one(scope: TxScope, row: VehicleRow) {
    return toVehicle(row, (await this.derived(scope, [row])).get(row.id)!);
  }

  async many(scope: TxScope, rows: readonly VehicleRow[]) {
    const d = await this.derived(scope, rows);
    return rows.map((r) => toVehicle(r, d.get(r.id)!));
  }
}
