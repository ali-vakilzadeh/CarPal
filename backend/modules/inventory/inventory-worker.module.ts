// Inventory work on the worker deployable: W15 rules (41 §6.3). The W7
// import and bulk-update queues are hosted by workers/import-jobs.
import { Module } from '@nestjs/common';
import { CatalogQualityRule, InquiryReservationRule } from './application/inventory-rules.js';

@Module({ providers: [InquiryReservationRule, CatalogQualityRule] })
export class InventoryWorkerModule {}
