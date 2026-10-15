// Vehicles (40 §12.2): vehicles.list / create / get / update / status_change
// / vin_reveal / vin_decode / status_history / mileage_list / mileage_add,
// under {me}/vehicles and {flt}/vehicles. Active vehicles are limited by
// max_vehicles inside the write transaction (SEC-AZ-9: the subscriber lock
// serializes parallel creates). The VIN is stored only as an envelope, a
// keyed hash and the last four characters (SEC-CR, SEC-OUT-2).
import { Injectable, Optional } from '@nestjs/common';
import { sql } from 'kysely';
import { writeAudit } from '#libs/audit/index.js';
import { ApiError, type FieldError } from '#libs/contract/index.js';
import { CryptoServices, uuidv7 } from '#libs/crypto/index.js';
import { registerConstraintErrors } from '#libs/db/index.js';
import { EntitlementChecker, requireEntitlement } from '#libs/entitlements/index.js';
import { created, Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { FleetDrivers } from '#modules/fleet/interface/fleet.js';
import { UserCards } from '#modules/identity/interface/identity.js';
import { MediaService } from '#modules/media/interface/media.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { toMileage, toStatusHistory, type VehicleRow } from '../api/projections.js';
import { counts, maxModelYear, profileCompleteness, todayUtc } from '../domain/rules.js';
import { VinDecoder } from '../infrastructure/vin-decoder.js';
import { VehicleViews } from '../infrastructure/vehicle-views.js';
import {
  afterId,
  checkVersion,
  failIf,
  loadVehicle,
  openVin,
  sealVin,
  setChangeReason,
  vehicleAccess,
  vehiclesPath,
  type VehicleAccess,
} from './common.js';

registerConstraintErrors({
  // 52 §8: a VIN is unique per owner among non-archived vehicles.
  vehicles_vin_per_owner_uq: { code: 'DUPLICATE', pointer: '/vin', fieldCode: 'not_unique' },
});

export type VehicleWrite = {
  vin?: string;
  license_plate?: string;
  nickname?: string;
  brand_node_id: string;
  model_node_id: string;
  series_node_id?: string;
  year: number;
  engine_type_node_id?: string;
  fuel_type_node_id?: string;
  transmission?: string;
  drivetrain?: string;
  body_style?: string;
  color?: string;
  mileage_km?: number;
  ownership_start_date?: string;
  primary_photo_media_id?: string;
  notes?: string;
};

type VehicleColumns = Omit<VehicleWrite, 'vin'>;
const COLUMNS: (keyof VehicleColumns)[] = [
  'license_plate',
  'nickname',
  'brand_node_id',
  'model_node_id',
  'series_node_id',
  'year',
  'engine_type_node_id',
  'fuel_type_node_id',
  'transmission',
  'drivetrain',
  'body_style',
  'color',
  'mileage_km',
  'ownership_start_date',
  'primary_photo_media_id',
  'notes',
];

/** Field rules the schema cannot express (52 Vehicle: year ≤ current year + 2, ownership start not in the future). */
function fieldErrors(b: Partial<VehicleWrite>): FieldError[] {
  const errors: FieldError[] = [];
  if (b.year !== undefined && b.year > maxModelYear())
    errors.push({ pointer: '/year', code: 'out_of_range', limit: String(maxModelYear()) });
  if (b.ownership_start_date !== undefined && b.ownership_start_date > todayUtc())
    errors.push({ pointer: '/ownership_start_date', code: 'in_future' });
  return errors;
}

/** Vehicle chain (52: model under brand, series under model): 422 TAXONOMY_MISMATCH. */
async function checkChain(taxonomy: TaxonomyResolver, v: { brand_node_id: string; model_node_id: string; series_node_id?: string | null }) {
  await taxonomy.requireDescendant(v.model_node_id, v.brand_node_id, '/model_node_id');
  if (v.series_node_id) await taxonomy.requireDescendant(v.series_node_id, v.model_node_id, '/series_node_id');
}

function completeness(v: Partial<Record<keyof VehicleColumns, unknown>> & { vinPresent: boolean }): number {
  const set = (k: keyof VehicleColumns) => v[k] !== undefined && v[k] !== null;
  return profileCompleteness({
    vinPresent: v.vinPresent,
    licensePlate: set('license_plate'),
    nickname: set('nickname'),
    series: set('series_node_id'),
    engineType: set('engine_type_node_id'),
    fuelType: set('fuel_type_node_id'),
    transmission: set('transmission'),
    bodyStyle: set('body_style'),
    color: set('color'),
    mileage: set('mileage_km'),
    ownershipStart: set('ownership_start_date'),
    photo: set('primary_photo_media_id'),
  });
}

/** Mileage logs record who read the odometer (52 VehicleMileageLog.source). */
const mileageSource = (a: VehicleAccess): 'user' | 'fleet_driver' => (a.driver ? 'fleet_driver' : 'user');

@Injectable()
@Operation('vehicles.list')
export class VehiclesListHandler implements OperationHandler {
  constructor(
    private readonly views: VehicleViews,
    @Optional() private readonly drivers?: FleetDrivers,
  ) {}

  async handle(
    ctx: OperationContext<
      undefined,
      { status?: string; brand_node_id?: string; has_open_issues?: boolean; due_for_service?: boolean; limit: number }
    >,
  ): Promise<OperationResult> {
    const a = vehicleAccess(ctx);
    const q = ctx.query;
    const body = await ctx.tx(
      async (scope) => {
        // SEC-AZ-7: a driver sees only vehicles assigned to them (none when the fleet module is absent: fail closed).
        const assigned = a.driver ? ((await this.drivers?.assignedVehicleIds(scope, a.orgId!, a.userId)) ?? new Set<string>()) : null;
        if (assigned && assigned.size === 0) return ctx.page([], null);
        const fetch = (after: string | undefined, n: number) => {
          let s = scope.db
            .selectFrom('vehicle.vehicles as v')
            .selectAll('v')
            .where('v.owner_type', '=', a.owner.type)
            .where('v.owner_id', '=', a.owner.id)
            .where('v.deleted_at', 'is', null);
          if (assigned) s = s.where('v.id', 'in', [...assigned]);
          if (q.status) s = s.where('v.status', '=', q.status);
          if (q.brand_node_id) s = s.where('v.brand_node_id', '=', q.brand_node_id);
          if (q.has_open_issues !== undefined) {
            const open = sql<boolean>`EXISTS (SELECT 1 FROM vehicle.vehicle_issues i WHERE i.vehicle_id = v.id AND i.deleted_at IS NULL
                                              AND i.status IN ('open','investigating','scheduled'))`;
            s = s.where(q.has_open_issues ? open : sql<boolean>`NOT ${open}`);
          }
          if (q.due_for_service !== undefined) {
            const due = sql<boolean>`EXISTS (SELECT 1 FROM vehicle.maintenance_reminders r WHERE r.vehicle_id = v.id AND r.deleted_at IS NULL
                                             AND r.status IN ('due','overdue'))`;
            s = s.where(q.due_for_service ? due : sql<boolean>`NOT ${due}`);
          }
          if (after) s = s.where('v.id', '<', after);
          return s.orderBy('v.id', 'desc').limit(n).execute();
        };
        const rows: VehicleRow[] = await fetch(afterId(ctx), q.limit + 1);
        const page = rows.slice(0, q.limit);
        return ctx.page(await this.views.many(scope, page), rows.length > q.limit ? { id: page.at(-1)!.id } : null);
      },
      { readOnly: true },
    );
    return { body };
  }
}

/**
 * Creating a vehicle (vehicles.create and fleet CSV imports, W7): taxonomy
 * chain, VIN sealing, max_vehicles inside the caller's transaction (the
 * subscriber lock serializes parallel creates), the first mileage reading and
 * vehicle.created. Returns the stored row (re-read: the mileage trigger
 * mirrors the reading onto the vehicle).
 */
@Injectable()
export class VehicleCreator {
  constructor(
    private readonly taxonomy: TaxonomyResolver,
    private readonly entitlements: EntitlementChecker,
    private readonly media: MediaService,
    private readonly crypto: CryptoServices,
  ) {}

  async create(
    scope: TxScope,
    owner: { type: 'user' | 'organization'; id: string },
    b: VehicleWrite,
    actor: { userId: string; driver: boolean },
  ): Promise<VehicleRow> {
    failIf(fieldErrors(b));
    await checkChain(this.taxonomy, b);
    const id = uuidv7();
    const sealed = b.vin ? sealVin(this.crypto, id, b.vin) : null;
    if (b.primary_photo_media_id)
      await this.media.requireReady(scope, [b.primary_photo_media_id], {
        owner,
        purposes: ['vehicle_photo'],
        pointer: '/primary_photo_media_id',
      });
    // 52 §21: a new vehicle is active and counts toward max_vehicles.
    await requireEntitlement(this.entitlements, scope, owner, 'max_vehicles', 1);
    const values = Object.fromEntries(COLUMNS.filter((k) => b[k] !== undefined).map((k) => [k, b[k]]));
    await scope.db
      .insertInto('vehicle.vehicles')
      .values({
        ...values,
        id,
        owner_type: owner.type,
        owner_id: owner.id,
        brand_node_id: b.brand_node_id,
        model_node_id: b.model_node_id,
        year: b.year,
        ...(sealed ?? {}),
        status: 'active',
        profile_completeness: completeness({ ...b, vinPresent: !!sealed }),
      })
      .execute();
    if (b.mileage_km !== undefined)
      await scope.db
        .insertInto('vehicle.vehicle_mileage_logs')
        .values({
          vehicle_id: id,
          mileage_km: b.mileage_km,
          recorded_at: new Date(),
          source: actor.driver ? 'fleet_driver' : 'user',
          recorded_by: actor.userId,
        })
        .execute();
    await publishEvent(scope, {
      type: 'vehicle.created',
      aggregateType: 'vehicle',
      aggregateId: id,
      payload: { owner_type: owner.type, owner_id: owner.id, vin_present: !!sealed },
    });
    return scope.db.selectFrom('vehicle.vehicles').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  }
}

@Injectable()
@Operation('vehicles.create')
export class VehiclesCreateHandler implements OperationHandler {
  constructor(
    private readonly creator: VehicleCreator,
    private readonly views: VehicleViews,
  ) {}

  async handle(ctx: OperationContext<VehicleWrite>): Promise<OperationResult> {
    const a = vehicleAccess(ctx);
    const body = await ctx.tx(async (scope) => {
      const row = await this.creator.create(scope, a.owner, ctx.body, { userId: a.userId, driver: a.driver });
      return this.views.one(scope, row);
    });
    return created(body, `${vehiclesPath(a)}/${body.id}`);
  }
}

@Injectable()
@Operation('vehicles.get')
export class VehiclesGetHandler implements OperationHandler {
  constructor(private readonly views: VehicleViews) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const a = vehicleAccess(ctx);
    const body = await ctx.tx(async (scope) => this.views.one(scope, await loadVehicle(scope, a, ctx.params.vehicle_id!)), {
      readOnly: true,
    });
    return { body };
  }
}

@Injectable()
@Operation('vehicles.update')
export class VehiclesUpdateHandler implements OperationHandler {
  constructor(
    private readonly taxonomy: TaxonomyResolver,
    private readonly media: MediaService,
    private readonly crypto: CryptoServices,
    private readonly views: VehicleViews,
  ) {}

  async handle(ctx: OperationContext<Partial<VehicleWrite>>): Promise<OperationResult> {
    const a = vehicleAccess(ctx);
    const b = ctx.body;
    failIf(fieldErrors(b));
    const body = await ctx.tx(async (scope) => {
      const v = await loadVehicle(scope, a, ctx.params.vehicle_id!, true);
      checkVersion(v.version, ctx.ifMatch);
      const merged = {
        brand_node_id: b.brand_node_id ?? v.brand_node_id,
        model_node_id: b.model_node_id ?? v.model_node_id,
        series_node_id: b.series_node_id ?? v.series_node_id,
      };
      if (b.brand_node_id || b.model_node_id || b.series_node_id) await checkChain(this.taxonomy, merged);
      if (b.primary_photo_media_id && b.primary_photo_media_id !== v.primary_photo_media_id)
        await this.media.requireReady(scope, [b.primary_photo_media_id], {
          owner: a.owner,
          purposes: ['vehicle_photo'],
          pointer: '/primary_photo_media_id',
        });
      const set: Record<string, unknown> = Object.fromEntries(COLUMNS.filter((k) => b[k] !== undefined).map((k) => [k, b[k]]));
      const newVin = b.vin !== undefined && !(v.vin_hash && this.crypto.hmac.verify('vin-hash', b.vin, v.vin_hash));
      if (newVin) {
        // A new VIN is re-sealed and re-checked for duplicates (unique per owner; warning across owners).
        Object.assign(set, sealVin(this.crypto, v.id, b.vin!), {
          vin_decode_status: 'not_attempted',
          vin_decoded_at: null,
          vin_decoder_source: null,
        });
      } else if (Object.keys(set).length && (v.vin_decode_status === 'decoded' || v.vin_decode_status === 'partial')) {
        // 52: every field can be overridden manually, even after decoding.
        set.vin_decode_status = 'manual';
      }
      if (Object.keys(set).length === 0) return this.views.one(scope, v);
      set.profile_completeness = completeness({ ...v, ...set, vinPresent: v.vin_hash !== null || newVin });
      const row = await scope.db.updateTable('vehicle.vehicles').set(set).where('id', '=', v.id).returningAll().executeTakeFirstOrThrow();
      if (b.mileage_km !== undefined && b.mileage_km !== v.mileage_km)
        await scope.db
          .insertInto('vehicle.vehicle_mileage_logs')
          .values({ vehicle_id: v.id, mileage_km: b.mileage_km, recorded_at: new Date(), source: mileageSource(a), recorded_by: a.userId })
          .execute();
      await publishEvent(scope, {
        type: 'vehicle.updated',
        aggregateType: 'vehicle',
        aggregateId: v.id,
        payload: { fields: Object.keys(b).sort() },
      });
      return this.views.one(scope, b.mileage_km !== undefined ? await loadVehicle(scope, a, v.id) : row);
    });
    return { body };
  }
}

@Injectable()
@Operation('vehicles.status_change')
export class VehiclesStatusChangeHandler implements OperationHandler {
  constructor(
    private readonly entitlements: EntitlementChecker,
    private readonly views: VehicleViews,
  ) {}

  async handle(ctx: OperationContext<{ status: string; reason?: string }>): Promise<OperationResult> {
    const a = vehicleAccess(ctx);
    const b = ctx.body;
    const body = await ctx.tx(async (scope) => {
      const v = await loadVehicle(scope, a, ctx.params.vehicle_id!, true);
      if (v.status === b.status) return this.views.one(scope, v);
      // Returning a vehicle to active or in_repair counts toward the limit (40 vehicles.status_change).
      if (!counts(v.status) && counts(b.status)) await requireEntitlement(this.entitlements, scope, a.owner, 'max_vehicles', 1);
      await setChangeReason(scope, b.reason ?? null);
      const row = await scope.db
        .updateTable('vehicle.vehicles')
        .set({ status: b.status })
        .where('id', '=', v.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await publishEvent(scope, {
        type: 'vehicle.updated',
        aggregateType: 'vehicle',
        aggregateId: v.id,
        payload: { fields: ['status'], old_status: v.status, new_status: b.status },
      });
      return this.views.one(scope, row);
    });
    return { body };
  }
}

@Injectable()
@Operation('vehicles.vin_reveal')
export class VehiclesVinRevealHandler implements OperationHandler {
  constructor(private readonly crypto: CryptoServices) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const a = vehicleAccess(ctx);
    const body = await ctx.tx(async (scope) => {
      const v = await loadVehicle(scope, a, ctx.params.vehicle_id!);
      const vin = openVin(this.crypto, v);
      if (!vin) throw new ApiError('NOT_FOUND', { detail: 'vehicle has no VIN' });
      // SEC-OUT-2: every reveal is audited (AUD); the response is never cached (PII).
      await writeAudit(scope, { action: 'vehicle.vin_revealed', entityType: 'vehicle', entityId: v.id });
      return { vin };
    });
    return { body };
  }
}

@Injectable()
@Operation('vehicles.vin_decode')
export class VehiclesVinDecodeHandler implements OperationHandler {
  constructor(
    private readonly crypto: CryptoServices,
    private readonly decoder: VinDecoder,
  ) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const a = vehicleAccess(ctx);
    const v = await ctx.tx((scope) => loadVehicle(scope, a, ctx.params.vehicle_id!), { readOnly: true });
    const vin = openVin(this.crypto, v);
    if (!vin) throw new ApiError('INVALID_TRANSITION', { detail: 'no_vin' });
    const decoded = await this.decoder.decode(vin);
    await ctx.tx(async (scope) => {
      const cur = await loadVehicle(scope, a, v.id, true);
      // Suggestions only (applying them is a normal update); the attempt is recorded on the vehicle.
      if (cur.vin_hash && v.vin_hash && cur.vin_hash.equals(v.vin_hash))
        await scope.db
          .updateTable('vehicle.vehicles')
          .set({ vin_decode_status: decoded.status, vin_decoder_source: decoded.source, vin_decoded_at: new Date() })
          .where('id', '=', cur.id)
          .execute();
    });
    return { body: { decode_status: decoded.status, suggested: decoded.suggested, decoder_source: decoded.source } };
  }
}

@Injectable()
@Operation('vehicles.status_history')
export class VehiclesStatusHistoryHandler implements OperationHandler {
  constructor(private readonly users: UserCards) {}

  async handle(ctx: OperationContext<undefined, { limit: number }>): Promise<OperationResult> {
    const a = vehicleAccess(ctx);
    const after = afterId(ctx);
    const body = await ctx.tx(
      async (scope) => {
        const v = await loadVehicle(scope, a, ctx.params.vehicle_id!);
        let q = scope.db.selectFrom('vehicle.vehicle_status_history').selectAll().where('vehicle_id', '=', v.id);
        if (after) q = q.where('id', '<', after);
        const rows = await q
          .orderBy('id', 'desc')
          .limit(ctx.query.limit + 1)
          .execute();
        const page = rows.slice(0, ctx.query.limit);
        const cards = await this.users.cards(
          scope,
          page.map((r) => r.changed_by),
        );
        return ctx.page(
          page.map((r) => toStatusHistory(r, displayName(cards.get(r.changed_by)?.displayName))),
          rows.length > ctx.query.limit ? { id: page.at(-1)!.id } : null,
        );
      },
      { readOnly: true },
    );
    return { body };
  }
}

/** Str<2,50> display of an actor: the user's display name, else the platform (system changes, anonymized users). */
export function displayName(name: string | null | undefined): string {
  const n = name?.trim();
  return n && n.length >= 2 ? n.slice(0, 50) : 'CarPal';
}

type MileagePosition = { r: string; id: string } | undefined;

@Injectable()
@Operation('vehicles.mileage_list')
export class VehiclesMileageListHandler implements OperationHandler {
  async handle(ctx: OperationContext<undefined, { limit: number }>): Promise<OperationResult> {
    const a = vehicleAccess(ctx);
    const pos = ctx.cursor as MileagePosition;
    const body = await ctx.tx(
      async (scope) => {
        const v = await loadVehicle(scope, a, ctx.params.vehicle_id!);
        let q = scope.db
          .selectFrom('vehicle.vehicle_mileage_logs')
          .selectAll()
          .where('vehicle_id', '=', v.id)
          .where('deleted_at', 'is', null);
        // Newest reading first (readings may be back-dated): keyset on (recorded_at, id).
        if (pos) q = q.where(sql<boolean>`(recorded_at, id) < (${new Date(pos.r)}, ${pos.id}::uuid)`);
        const rows = await q
          .orderBy('recorded_at', 'desc')
          .orderBy('id', 'desc')
          .limit(ctx.query.limit + 1)
          .execute();
        const page = rows.slice(0, ctx.query.limit);
        const last = page.at(-1);
        return ctx.page(
          page.map(toMileage),
          rows.length > ctx.query.limit && last ? { r: new Date(last.recorded_at).toISOString(), id: last.id } : null,
        );
      },
      { readOnly: true },
    );
    return { body };
  }
}

/** Readings may be at most a few minutes ahead of the server clock (device clocks drift). */
const CLOCK_SKEW_MS = 5 * 60_000;

@Injectable()
@Operation('vehicles.mileage_add')
export class VehiclesMileageAddHandler implements OperationHandler {
  async handle(ctx: OperationContext<{ mileage_km: number; recorded_at: string }>): Promise<OperationResult> {
    const a = vehicleAccess(ctx);
    const b = ctx.body;
    if (new Date(b.recorded_at).getTime() > Date.now() + CLOCK_SKEW_MS) failIf([{ pointer: '/recorded_at', code: 'in_future' }]);
    const row = await ctx.tx(async (scope) => {
      const v = await loadVehicle(scope, a, ctx.params.vehicle_id!, true);
      // 52: a lower reading than the previous one is accepted with a warning (the trigger sets lower_than_previous).
      const log = await scope.db
        .insertInto('vehicle.vehicle_mileage_logs')
        .values({
          vehicle_id: v.id,
          mileage_km: b.mileage_km,
          recorded_at: new Date(b.recorded_at),
          source: mileageSource(a),
          recorded_by: a.userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      if (v.mileage_km === null) await refreshCompleteness(scope, v.id);
      return log;
    });
    return created(toMileage(row), `${vehiclesPath(a)}/${ctx.params.vehicle_id}/mileage`);
  }
}

/** Recomputes profile_completeness after a change made outside vehicles.update (first mileage reading). */
async function refreshCompleteness(scope: TxScope, vehicleId: string): Promise<void> {
  const v = await scope.db.selectFrom('vehicle.vehicles').selectAll().where('id', '=', vehicleId).executeTakeFirstOrThrow();
  const score = completeness({ ...v, vinPresent: v.vin_hash !== null });
  if (score !== v.profile_completeness)
    await scope.db.updateTable('vehicle.vehicles').set({ profile_completeness: score }).where('id', '=', vehicleId).execute();
}
