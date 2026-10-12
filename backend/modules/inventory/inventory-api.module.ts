// Inventory operations (40 §13) on the api host: the vendor side under
// {vnd}, the requester side under {me} and {org}. Needs InventoryModule,
// OrganizationModule, IdentityModule, VehicleModule, MediaModule,
// TaxonomyModule and BillingModule (global) in the same application.
import { Module } from '@nestjs/common';
import {
  FitmentCreateHandler,
  FitmentDecideHandler,
  FitmentDeleteHandler,
  FitmentListHandler,
  FitmentUpdateHandler,
} from './application/fitment-ops.js';
import {
  InventoryImportCreateHandler,
  InventoryImportErrorReportHandler,
  InventoryImportGetHandler,
  InventoryImportsListHandler,
} from './application/import-ops.js';
import {
  InquiriesCreateHandler,
  InquiriesGetHandler,
  InquiriesListHandler,
  InquiriesMessageHandler,
  InquiriesTransitionHandler,
  InquiriesVendorGetHandler,
  InquiriesVendorListHandler,
  InquiriesVendorMessageHandler,
  InquiriesVendorTransitionHandler,
  InquiryViews,
} from './application/inquiry-ops.js';
import {
  InventoryBulkUpdateHandler,
  InventoryCreateHandler,
  InventoryDeleteHandler,
  InventoryDuplicateMarkHandler,
  InventoryGetHandler,
  InventoryListHandler,
  InventorySearchHandler,
  InventoryUpdateHandler,
  ItemViews,
} from './application/item-ops.js';
import { PublicInventoryGetHandler, PublicOrgInventorySearchHandler } from './application/public-ops.js';
import {
  TradeAccountsCustomerListHandler,
  TradeAccountsRequestHandler,
  TradeAccountsVendorDecideHandler,
  TradeAccountsVendorListHandler,
  TradeViews,
} from './application/trade-ops.js';

@Module({
  providers: [
    ItemViews,
    TradeViews,
    InquiryViews,
    // items
    InventoryListHandler,
    InventorySearchHandler,
    InventoryCreateHandler,
    InventoryGetHandler,
    InventoryUpdateHandler,
    InventoryDeleteHandler,
    InventoryBulkUpdateHandler,
    InventoryDuplicateMarkHandler,
    // fitment
    FitmentListHandler,
    FitmentCreateHandler,
    FitmentUpdateHandler,
    FitmentDeleteHandler,
    FitmentDecideHandler,
    // imports
    InventoryImportCreateHandler,
    InventoryImportsListHandler,
    InventoryImportGetHandler,
    InventoryImportErrorReportHandler,
    // trade accounts
    TradeAccountsVendorListHandler,
    TradeAccountsVendorDecideHandler,
    TradeAccountsRequestHandler,
    TradeAccountsCustomerListHandler,
    // stock inquiries
    InquiriesVendorListHandler,
    InquiriesVendorGetHandler,
    InquiriesVendorMessageHandler,
    InquiriesVendorTransitionHandler,
    InquiriesCreateHandler,
    InquiriesListHandler,
    InquiriesGetHandler,
    InquiriesMessageHandler,
    InquiriesTransitionHandler,
    // §14.3 public reads
    PublicOrgInventorySearchHandler,
    PublicInventoryGetHandler,
  ],
})
export class InventoryApiModule {}
