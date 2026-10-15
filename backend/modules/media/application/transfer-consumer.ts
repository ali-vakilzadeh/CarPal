// vehicle.transferred (GD-33): the vehicle's photos, documents and issue
// photos belonged to the previous owner and now belong to the buyer, so they
// stay readable with the vehicle. Worker, system context; idempotent.
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { EventEnvelope } from '#libs/infra/index.js';
import { EventConsumer } from '#libs/outbox/index.js';
import { TxRunner } from '#libs/tenancy/index.js';

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

@Injectable()
export class VehicleTransferMediaConsumer extends EventConsumer {
  readonly name = 'media.vehicle_transferred';
  readonly subjects = ['vehicle.transferred'];

  constructor(private readonly tx: TxRunner) {
    super();
  }

  async handle(e: EventEnvelope): Promise<void> {
    const p = e.payload;
    const issues = ids(p.issue_ids);
    await this.tx.run({ actorType: 'system' }, ({ db }) =>
      sql`UPDATE media.media_assets a SET owner_type = ${String(p.to_owner_type)}, owner_id = ${String(p.to_owner_id)}::uuid
           WHERE a.owner_type = ${String(p.from_owner_type)} AND a.owner_id = ${String(p.from_owner_id)}::uuid
             AND (a.id = ANY (${ids(p.media_asset_ids)}::uuid[])
                  OR a.id IN (SELECT m.media_asset_id FROM media.media_attachments m
                               WHERE (m.attached_to_type = 'vehicle' AND m.attached_to_id = ${e.aggregateId}::uuid)
                                  OR (m.attached_to_type = 'vehicle_issue' AND m.attached_to_id = ANY (${issues}::uuid[]))))`.execute(db),
    );
  }
}
