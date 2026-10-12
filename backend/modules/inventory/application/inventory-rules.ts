// W15 rules of the inventory module (41 §6.3), system context:
//   inventory.reservation_expiry (every 15 min) releases reservations past
//     reserved_until: the inquiry goes back to answered (still open).
//   inventory.catalog_quality (daily) recomputes item data quality (image
//     attachments change outside this module) and every vendor's catalog
//     quality and response time (54 §7.2).
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { ScheduledRule } from '#libs/jobs/index.js';
import { TxRunner } from '#libs/tenancy/index.js';
import { CatalogQuality } from './common.js';

@Injectable()
export class InquiryReservationRule extends ScheduledRule {
  readonly name = 'inventory.reservation_expiry';
  readonly everyMs = 15 * 60_000;

  constructor(private readonly tx: TxRunner) {
    super();
  }

  async run(): Promise<number> {
    const rows = await this.tx.run({ actorType: 'system' }, ({ db }) =>
      db
        .updateTable('inventory.stock_inquiries')
        .set({ status: 'answered', reserved_until: null })
        .where('status', '=', 'reserved')
        .where('reserved_until', '<', sql<Date>`now()`)
        .where('deleted_at', 'is', null)
        .returning('id')
        .execute(),
    );
    return rows.length;
  }
}

@Injectable()
export class CatalogQualityRule extends ScheduledRule {
  readonly name = 'inventory.catalog_quality';
  readonly everyMs = 86_400_000;

  constructor(
    private readonly tx: TxRunner,
    private readonly quality: CatalogQuality,
  ) {
    super();
  }

  async run(): Promise<number> {
    const vendors = await this.tx.run({ actorType: 'system' }, ({ db }) =>
      db
        .selectFrom('inventory.inventory_items')
        .select('vendor_organization_id')
        .where('deleted_at', 'is', null)
        .groupBy('vendor_organization_id')
        .execute(),
    );
    for (const v of vendors)
      await this.tx.run({ actorType: 'system' }, async (scope) => {
        await this.quality.scoreCatalog(scope, v.vendor_organization_id);
        await this.quality.refreshVendor(scope, v.vendor_organization_id);
      });
    return vendors.length;
  }
}
