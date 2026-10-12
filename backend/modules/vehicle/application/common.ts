// Helpers shared by the vehicle use cases (40 §12). Every operation exists
// under {me}/vehicles (personal: owner user, RLS owner_all on core.me()) and
// {flt}/vehicles (fleet: owner organization, the path organization already
// authorized with its role group). Fleet drivers reach a path vehicle only
// with an assignment (checked by the authorizer, SEC-AZ-7); lists are
// filtered here.
import { sql } from 'kysely';
import { ApiError, type FieldError } from '#libs/contract/index.js';
import type { CryptoServices } from '#libs/crypto/index.js';
import type { OperationContext } from '#libs/http-pipeline/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import type { VehicleRow } from '../api/projections.js';
import { vinLast4, vinValid } from '../domain/vin.js';

export interface VehicleAccess {
  userId: string;
  /** Fleet prefix ({flt}/vehicles). */
  fleet: boolean;
  orgId: string | null;
  role: string | null;
  /** 52 Vehicle.owner_type / owner_id of vehicles on this prefix. */
  owner: { type: 'user' | 'organization'; id: string };
  /** The caller is a fleet driver (only assigned vehicles, SEC-AZ-7). */
  driver: boolean;
  /** Qualifiers of the satisfied tags, e.g. "own reports" (DRV(own reports)). */
  qualifiers: string[];
}

export function vehicleAccess(ctx: OperationContext): VehicleAccess {
  if (ctx.principal.kind !== 'user') throw new ApiError('NOT_FOUND');
  const userId = ctx.principal.userId;
  const org = ctx.access.org;
  if (org)
    return {
      userId,
      fleet: true,
      orgId: org.id,
      role: org.role,
      owner: { type: 'organization', id: org.id },
      driver: ctx.access.driverScoped,
      qualifiers: ctx.access.qualifiers,
    };
  return { userId, fleet: false, orgId: null, role: null, owner: { type: 'user', id: userId }, driver: false, qualifiers: [] };
}

/** Path prefix of the vehicle routes for Location headers. */
export const vehiclesPath = (a: VehicleAccess): string => (a.fleet ? `/v1/orgs/${a.orgId}/fleet/vehicles` : '/v1/me/vehicles');

/** The vehicle of the path, owned on this prefix (SEC-AZ-3 owner predicate + RLS). */
export async function loadVehicle(scope: TxScope, a: VehicleAccess, vehicleId: string, lock = false): Promise<VehicleRow> {
  const q = scope.db
    .selectFrom('vehicle.vehicles')
    .selectAll()
    .where('id', '=', vehicleId)
    .where('owner_type', '=', a.owner.type)
    .where('owner_id', '=', a.owner.id)
    .where('deleted_at', 'is', null);
  const row = await (lock ? q.forUpdate() : q).executeTakeFirst();
  if (!row) throw new ApiError('NOT_FOUND');
  return row;
}

/** ETAG operations: compares the stored version with If-Match (SEC-IC-4). */
export function checkVersion(version: number, ifMatch: number | undefined): void {
  if (ifMatch === undefined) throw new ApiError('PRECONDITION_REQUIRED');
  if (version !== ifMatch) throw new ApiError('VERSION_MISMATCH');
}

type Position = { id?: string } | undefined;

/** Keyset position (UUIDv7 ids: id order is creation order). */
export const afterId = (ctx: OperationContext): string | undefined => (ctx.cursor as Position)?.id;

/** Page<T> from `limit + 1` rows ordered by id. */
export function pageOf<R extends { id: string }, T>(ctx: OperationContext<unknown, { limit: number }>, rows: R[], map: (r: R) => T) {
  const limit = ctx.query.limit;
  const page = rows.slice(0, limit);
  return ctx.page(page.map(map), rows.length > limit ? { id: page.at(-1)!.id } : null);
}

export function failIf(errors: FieldError[]): void {
  if (errors.length) throw ApiError.validation(errors);
}

export const notFoundAt = (pointer: string): ApiError =>
  ApiError.validation([{ pointer, code: 'reference_not_found' }], 'REFERENCE_NOT_FOUND');

/** jsonb columns: arrays must be serialized (pg would send a PostgreSQL array). */
export const json = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));

/** Sealed VIN columns (40 SEC-CR): AES-256-GCM envelope bound to the row, keyed hash for duplicates, last four. */
export function sealVin(crypto: CryptoServices, vehicleId: string, vin: string) {
  if (!vinValid(vin)) throw ApiError.validation([{ pointer: '/vin', code: 'pattern' }], 'VIN_INVALID');
  return {
    vin_encrypted: crypto.envelope.encrypt(vin, `vehicle.vin:${vehicleId}`),
    vin_hash: crypto.hmac.digest('vin-hash', vin),
    vin_last4: vinLast4(vin),
  };
}

export const openVin = (crypto: CryptoServices, row: Pick<VehicleRow, 'id' | 'vin_encrypted'>): string | null =>
  row.vin_encrypted ? crypto.envelope.decryptString(row.vin_encrypted, `vehicle.vin:${row.id}`) : null;

/** Sets the reason the status-history trigger records (vehicle.tg_vehicle_status_history reads app.change_reason). */
export async function setChangeReason(scope: TxScope, reason: string | null): Promise<void> {
  await sql`SELECT set_config('app.change_reason', ${reason ?? ''}, true)`.execute(scope.db);
}
