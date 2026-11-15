// Inventory's references to organizations for an organization merge (backend S22, BR-08): items move unless the
// surviving vendor already lists the SKU (the merged organization's item is retired), imports and inquiries move,
// trade accounts move unless they link the two organizations or the target already has the same account.
import { keyedRef, moveRef, type OrgReference } from '#modules/organization/interface/org-references.js';

export function inventoryOrgReferences(): OrgReference[] {
  return [
    keyedRef('inventory.items', {
      table: 'inventory.inventory_items',
      columns: ['vendor_organization_id'],
      key: ['sku'],
      unique: "%.status <> 'removed' AND %.deleted_at IS NULL",
    }),
    moveRef('inventory.import_batches', { table: 'inventory.inventory_import_batches', columns: ['vendor_organization_id'] }),
    keyedRef('inventory.trade_accounts', {
      table: 'inventory.vendor_trade_accounts',
      columns: ['vendor_organization_id', 'trade_customer_organization_id'],
      key: 'pair',
      pair: true,
    }),
    moveRef('inventory.inquiries', {
      table: 'inventory.stock_inquiries',
      columns: ['vendor_organization_id', 'requester_organization_id'],
    }),
  ];
}
