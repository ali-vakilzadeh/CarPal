// Vehicle transfers (GD-33, 40 §12 vehicles.transfer_*): one VIN has one
// owner, so a buyer registering an owned VIN asks the current owner ("Did you
// buy this car?"). The owner is never disclosed to the buyer; the owner sees
// the buyer's display name and decides. Acceptance (vehicle.accept_transfer
// definer, the owner's context) moves the vehicle, and with it every record
// linked by vehicle_id; vehicle.transferred lets media, fleet and identity
// move or end what they own. Pending requests expire after 14 days (W15).
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { writeAudit } from '#libs/audit/index.js';
import { ApiError } from '#libs/contract/index.js';
import { CryptoServices } from '#libs/crypto/index.js';
import { registerConstraintErrors } from '#libs/db/index.js';
import { EntitlementChecker, requireEntitlement } from '#libs/entitlements/index.js';
import {
  created,
  iso,
  isoOrNull,
  Operation,
  type OperationContext,
  type OperationHandler,
  type OperationResult,
} from '#libs/http-pipeline/index.js';
import { ScheduledRule } from '#libs/jobs/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import { TxRunner, type TxScope } from '#libs/tenancy/index.js';
import { authorDisplayName, UserCards } from '#modules/identity/interface/identity.js';
import { vinValid } from '../domain/vin.js';
import { afterId, vehicleAccess, vehicleByVinHash, type VehicleAccess } from './common.js';

registerConstraintErrors({
  vehicle_transfers_pending_uq: { code: 'DUPLICATE', pointer: '/vin', fieldCode: 'not_unique' },
});

const TRANSFER_TTL_MS = 14 * 86_400_000;

type TransferRow = {
  id: string;
  created_at: Date;
  updated_at: Date;
  version: number;
  vehicle_id: string;
  from_owner_type: string;
  from_owner_id: string;
  to_owner_type: string;
  to_owner_id: string;
  requested_by_user_id: string;
  vehicle_summary: unknown;
  message: string | null;
  status: string;
  decided_at: Date | null;
  expires_at: Date;
};

const transfersBase = (prefix: VehicleAccess) =>
  prefix.fleet ? `/v1/orgs/${prefix.orgId}/fleet/vehicle-transfers` : '/v1/me/vehicle-transfers';
const isOwner = (t: TransferRow, a: VehicleAccess) => t.from_owner_type === a.owner.type && t.from_owner_id === a.owner.id;

/** 40 VehicleTransfer for one side. */
function toTransfer(t: TransferRow, a: VehicleAccess, requesterDisplay: string | null) {
  const incoming = isOwner(t, a);
  return {
    id: t.id,
    created_at: iso(t.created_at),
    updated_at: iso(t.updated_at),
    version: t.version,
    direction: incoming ? ('incoming' as const) : ('outgoing' as const),
    // The owner sees its vehicle; the buyer only once it is theirs.
    vehicle_id: incoming || t.status === 'accepted' ? t.vehicle_id : null,
    vehicle_summary: t.vehicle_summary as { brand_node_id: string; model_node_id: string; year: number; vin_last4: string | null },
    requester_display: incoming ? requesterDisplay : null,
    message: t.message,
    status: t.status,
    decided_at: isoOrNull(t.decided_at),
    expires_at: iso(t.expires_at),
  };
}

@Injectable()
export class TransferViews {
  constructor(private readonly users: UserCards) {}

  async many(scope: TxScope, rows: TransferRow[], a: VehicleAccess, locale: string) {
    const cards = await this.users.cards(
      scope,
      rows.filter((t) => isOwner(t, a)).map((t) => t.requested_by_user_id),
    );
    return rows.map((t) => toTransfer(t, a, isOwner(t, a) ? authorDisplayName(cards.get(t.requested_by_user_id), locale) : null));
  }
}

async function loadTransfer(scope: TxScope, id: string, lock = false): Promise<TransferRow> {
  // RLS party_read: only the buyer and the current owner see it.
  const q = scope.db.selectFrom('vehicle.vehicle_transfers').selectAll().where('id', '=', id).where('deleted_at', 'is', null);
  const row = (await (lock ? q.forUpdate() : q).executeTakeFirst()) as TransferRow | undefined;
  if (!row) throw new ApiError('NOT_FOUND');
  return row;
}

@Injectable()
@Operation('vehicles.transfer_request')
export class VehicleTransferRequestHandler implements OperationHandler {
  constructor(
    private readonly crypto: CryptoServices,
    private readonly entitlements: EntitlementChecker,
    private readonly views: TransferViews,
  ) {}

  async handle(ctx: OperationContext<{ vin: string; message?: string }>): Promise<OperationResult> {
    const a = vehicleAccess(ctx);
    if (!vinValid(ctx.body.vin)) throw ApiError.validation([{ pointer: '/vin', code: 'pattern' }], 'VIN_INVALID');
    const body = await ctx.tx(async (scope) => {
      const v = await vehicleByVinHash(scope, this.crypto.hmac.digest('vin-hash', ctx.body.vin));
      if (!v) throw ApiError.validation([{ pointer: '/vin', code: 'reference_not_found' }], 'REFERENCE_NOT_FOUND');
      if (v.owner_type === a.owner.type && v.owner_id === a.owner.id)
        throw ApiError.validation([{ pointer: '/vin', code: 'not_unique' }], 'DUPLICATE');
      // The vehicle will count toward the buyer's plan once accepted.
      await requireEntitlement(this.entitlements, scope, a.owner, 'max_vehicles', 1);
      const row = (await scope.db
        .insertInto('vehicle.vehicle_transfers')
        .values({
          vehicle_id: v.id,
          from_owner_type: v.owner_type,
          from_owner_id: v.owner_id,
          to_owner_type: a.owner.type,
          to_owner_id: a.owner.id,
          requested_by_user_id: a.userId,
          vehicle_summary: JSON.stringify({
            brand_node_id: v.brand_node_id,
            model_node_id: v.model_node_id,
            year: v.year,
            vin_last4: v.vin_last4,
          }),
          message: ctx.body.message ?? null,
          expires_at: new Date(Date.now() + TRANSFER_TTL_MS),
        })
        .returningAll()
        .executeTakeFirstOrThrow()) as TransferRow;
      await publishEvent(scope, {
        type: 'vehicle.transfer.requested',
        aggregateType: 'vehicle_transfer',
        aggregateId: row.id,
        payload: { from_owner_type: row.from_owner_type, from_owner_id: row.from_owner_id, requested_by_user_id: a.userId },
      });
      return (await this.views.many(scope, [row], a, ctx.locale))[0]!;
    });
    return created(body, `${transfersBase(a)}/${body.id}`);
  }
}

@Injectable()
@Operation('vehicles.transfers_list')
export class VehicleTransfersListHandler implements OperationHandler {
  constructor(private readonly views: TransferViews) {}

  async handle(
    ctx: OperationContext<undefined, { direction?: 'incoming' | 'outgoing'; status?: string; limit: number }>,
  ): Promise<OperationResult> {
    const a = vehicleAccess(ctx);
    const q = ctx.query;
    const body = await ctx.tx(
      async (scope) => {
        const side = (prefix: 'from' | 'to') =>
          sql<boolean>`(${sql.ref(`${prefix}_owner_type`)} = ${a.owner.type} AND ${sql.ref(`${prefix}_owner_id`)} = ${a.owner.id}::uuid)`;
        let s = scope.db.selectFrom('vehicle.vehicle_transfers').selectAll().where('deleted_at', 'is', null);
        s =
          q.direction === 'incoming'
            ? s.where(side('from'))
            : q.direction === 'outgoing'
              ? s.where(side('to'))
              : s.where(sql<boolean>`(${side('from')} OR ${side('to')})`);
        if (q.status) s = s.where('status', '=', q.status);
        const after = afterId(ctx);
        if (after) s = s.where('id', '>', after);
        const rows = (await s
          .orderBy('id')
          .limit(q.limit + 1)
          .execute()) as TransferRow[];
        const page = rows.slice(0, q.limit);
        return ctx.page(await this.views.many(scope, page, a, ctx.locale), rows.length > q.limit ? { id: page.at(-1)!.id } : null);
      },
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('vehicles.transfer_decide')
export class VehicleTransferDecideHandler implements OperationHandler {
  constructor(private readonly views: TransferViews) {}

  async handle(ctx: OperationContext<{ decision: 'accept' | 'reject' }>): Promise<OperationResult> {
    const a = vehicleAccess(ctx);
    const body = await ctx.tx(async (scope) => {
      const t = await loadTransfer(scope, ctx.params.transfer_id!, true);
      // Only the current owner decides; the buyer gets 404 (SEC-AZ-2).
      if (!isOwner(t, a)) throw new ApiError('NOT_FOUND');
      if (t.status !== 'pending' || new Date(t.expires_at).getTime() <= Date.now())
        throw new ApiError('INVALID_TRANSITION', { detail: `transfer is ${t.status === 'pending' ? 'expired' : t.status}` });
      if (ctx.body.decision === 'accept') {
        // Records follow vehicle_id; collect what other modules own so they can move it (vehicle.transferred).
        const docs = await scope.db
          .selectFrom('vehicle.vehicle_documents')
          .select('media_asset_id')
          .where('vehicle_id', '=', t.vehicle_id)
          .where('deleted_at', 'is', null)
          .execute();
        const issues = await scope.db.selectFrom('vehicle.vehicle_issues').select('id').where('vehicle_id', '=', t.vehicle_id).execute();
        const photo = await scope.db
          .selectFrom('vehicle.vehicles')
          .select('primary_photo_media_id')
          .where('id', '=', t.vehicle_id)
          .executeTakeFirst();
        await sql`SELECT * FROM vehicle.accept_transfer(${t.id}::uuid)`.execute(scope.db);
        await publishEvent(scope, {
          type: 'vehicle.transferred',
          aggregateType: 'vehicle',
          aggregateId: t.vehicle_id,
          payload: {
            from_owner_type: t.from_owner_type,
            from_owner_id: t.from_owner_id,
            to_owner_type: t.to_owner_type,
            to_owner_id: t.to_owner_id,
            media_asset_ids: [
              ...docs.map((d) => d.media_asset_id),
              ...(photo?.primary_photo_media_id ? [photo.primary_photo_media_id] : []),
            ],
            issue_ids: issues.map((i) => i.id),
          },
        });
      } else {
        await scope.db
          .updateTable('vehicle.vehicle_transfers')
          .set({ status: 'rejected', decided_by: a.userId, decided_at: new Date() })
          .where('id', '=', t.id)
          .execute();
      }
      const row = await loadTransfer(scope, t.id);
      await publishEvent(scope, {
        type: 'vehicle.transfer.decided',
        aggregateType: 'vehicle_transfer',
        aggregateId: t.id,
        payload: {
          status: row.status,
          requested_by_user_id: t.requested_by_user_id,
          to_owner_type: t.to_owner_type,
          to_owner_id: t.to_owner_id,
        },
      });
      await writeAudit(scope, {
        action: 'vehicle.transfer_decided',
        entityType: 'vehicle_transfer',
        entityId: t.id,
        previous: 'pending',
        next: row.status,
      });
      return (await this.views.many(scope, [row], a, ctx.locale))[0]!;
    });
    return { body };
  }
}

@Injectable()
@Operation('vehicles.transfer_cancel')
export class VehicleTransferCancelHandler implements OperationHandler {
  constructor(private readonly views: TransferViews) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const a = vehicleAccess(ctx);
    const body = await ctx.tx(async (scope) => {
      const t = await loadTransfer(scope, ctx.params.transfer_id!, true);
      if (t.to_owner_type !== a.owner.type || t.to_owner_id !== a.owner.id) throw new ApiError('NOT_FOUND');
      if (t.status !== 'pending') throw new ApiError('INVALID_TRANSITION', { detail: `transfer is ${t.status}` });
      const row = (await scope.db
        .updateTable('vehicle.vehicle_transfers')
        .set({ status: 'cancelled' })
        .where('id', '=', t.id)
        .returningAll()
        .executeTakeFirstOrThrow()) as TransferRow;
      return (await this.views.many(scope, [row], a, ctx.locale))[0]!;
    });
    return { body };
  }
}

/** W15: pending transfer requests expire after 14 days. */
@Injectable()
export class VehicleTransferExpiryRule extends ScheduledRule {
  readonly name = 'vehicle.transfer_expiry';
  readonly everyMs = 3_600_000;

  constructor(private readonly tx: TxRunner) {
    super();
  }

  async run(): Promise<number> {
    const r = await this.tx.run({ actorType: 'system' }, ({ db }) =>
      db
        .updateTable('vehicle.vehicle_transfers')
        .set({ status: 'expired' })
        .where('status', '=', 'pending')
        .where('expires_at', '<=', new Date())
        .executeTakeFirst(),
    );
    return Number(r.numUpdatedRows);
  }
}
