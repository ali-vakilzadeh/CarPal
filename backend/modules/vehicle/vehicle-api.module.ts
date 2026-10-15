// Vehicle operations (40 §12) on the api host, under {me}/vehicles and
// {flt}/vehicles, plus provider.service_record_create on {prv}. Needs
// VehicleModule, IdentityModule, OrganizationModule, MediaModule,
// TaxonomyModule, BillingModule and InventoryModule (global) in the same
// application.
import { Module } from '@nestjs/common';
import {
  TransferViews,
  VehicleTransferCancelHandler,
  VehicleTransferDecideHandler,
  VehicleTransferRequestHandler,
  VehicleTransfersListHandler,
} from './application/transfer-ops.js';
import type { CarpalConfig } from '#libs/config/index.js';
import { CARPAL_CONFIG } from '#libs/runtime/index.js';
import {
  DocumentRules,
  VehicleDocumentCreateHandler,
  VehicleDocumentDeleteHandler,
  VehicleDocumentsListHandler,
  VehicleDocumentUpdateHandler,
} from './application/document-ops.js';
import {
  IssuesCreateHandler,
  IssuesGetHandler,
  IssuesListHandler,
  IssuesStatusChangeHandler,
  IssuesUpdateHandler,
  IssueViews,
} from './application/issue-ops.js';
import {
  RemindersCreateHandler,
  RemindersDeleteHandler,
  RemindersListHandler,
  RemindersUpdateHandler,
} from './application/reminder-ops.js';
import {
  ProviderServiceRecordCreateHandler,
  ServiceRecordRules,
  ServiceRecordsCreateHandler,
  ServiceRecordsDeleteHandler,
  ServiceRecordsEvidenceAddHandler,
  ServiceRecordsEvidenceRemoveHandler,
  ServiceRecordsGetHandler,
  ServiceRecordsListHandler,
  ServiceRecordsUpdateHandler,
  ServiceRecordViews,
} from './application/service-record-ops.js';
import {
  VehiclesCreateHandler,
  VehiclesGetHandler,
  VehiclesListHandler,
  VehiclesMileageAddHandler,
  VehiclesMileageListHandler,
  VehiclesStatusChangeHandler,
  VehiclesStatusHistoryHandler,
  VehiclesUpdateHandler,
  VehiclesVinDecodeHandler,
  VehiclesVinRevealHandler,
} from './application/vehicle-ops.js';
import { VehicleViews } from './infrastructure/vehicle-views.js';
import { LocalVinDecoder, UnconfiguredVinDecoder, VinDecoder } from './infrastructure/vin-decoder.js';

@Module({
  providers: [
    // vehicle transfers (GD-33)
    TransferViews,
    VehicleTransferRequestHandler,
    VehicleTransfersListHandler,
    VehicleTransferDecideHandler,
    VehicleTransferCancelHandler,
    // Lite: local model-year decoding; full: a regional decoder adapter is still to be written (503 until then).
    {
      provide: VinDecoder,
      useFactory: (config: CarpalConfig) => (config.infra === 'lite' ? new LocalVinDecoder() : new UnconfiguredVinDecoder()),
      inject: [CARPAL_CONFIG],
    },
    VehicleViews,
    DocumentRules,
    ServiceRecordRules,
    ServiceRecordViews,
    IssueViews,
    // vehicles
    VehiclesListHandler,
    VehiclesCreateHandler,
    VehiclesGetHandler,
    VehiclesUpdateHandler,
    VehiclesStatusChangeHandler,
    VehiclesVinRevealHandler,
    VehiclesVinDecodeHandler,
    VehiclesStatusHistoryHandler,
    VehiclesMileageListHandler,
    VehiclesMileageAddHandler,
    // documents
    VehicleDocumentsListHandler,
    VehicleDocumentCreateHandler,
    VehicleDocumentUpdateHandler,
    VehicleDocumentDeleteHandler,
    // service history
    ServiceRecordsListHandler,
    ServiceRecordsCreateHandler,
    ServiceRecordsGetHandler,
    ServiceRecordsUpdateHandler,
    ServiceRecordsDeleteHandler,
    ServiceRecordsEvidenceAddHandler,
    ServiceRecordsEvidenceRemoveHandler,
    ProviderServiceRecordCreateHandler,
    // issues
    IssuesListHandler,
    IssuesCreateHandler,
    IssuesGetHandler,
    IssuesUpdateHandler,
    IssuesStatusChangeHandler,
    // reminders
    RemindersListHandler,
    RemindersCreateHandler,
    RemindersUpdateHandler,
    RemindersDeleteHandler,
  ],
})
export class VehicleApiModule {}
