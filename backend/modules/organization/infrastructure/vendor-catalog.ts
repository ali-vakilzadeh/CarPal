// VendorCatalog and OrgLocations (interface/vendor-catalog.ts).
import { Injectable } from '@nestjs/common';
import type { TxScope } from '#libs/tenancy/index.js';
import { OrgLocations, VendorCatalog, type VendorFigures } from '../interface/vendor-catalog.js';

@Injectable()
export class DbVendorCatalog extends VendorCatalog {
  async record(scope: TxScope, vendorOrgId: string, f: VendorFigures): Promise<void> {
    const set: { catalog_quality_score?: number; measured_response_time_minutes?: number | null } = {};
    if (f.catalogQualityScore !== undefined) set.catalog_quality_score = Math.max(0, Math.min(100, Math.round(f.catalogQualityScore)));
    if (f.measuredResponseTimeMinutes !== undefined)
      set.measured_response_time_minutes =
        f.measuredResponseTimeMinutes === null ? null : Math.max(0, Math.round(f.measuredResponseTimeMinutes));
    if (Object.keys(set).length === 0) return;
    await scope.db
      .updateTable('organization.vendor_profiles')
      .set(set)
      .where('organization_id', '=', vendorOrgId)
      .where('deleted_at', 'is', null)
      .where((eb) =>
        eb.or([
          ...(set.catalog_quality_score !== undefined ? [eb('catalog_quality_score', 'is distinct from', set.catalog_quality_score)] : []),
          ...(set.measured_response_time_minutes !== undefined
            ? [eb('measured_response_time_minutes', 'is distinct from', set.measured_response_time_minutes)]
            : []),
        ]),
      )
      .execute();
  }
}

@Injectable()
export class DbOrgLocations extends OrgLocations {
  async isActive(scope: TxScope, orgId: string, locationId: string): Promise<boolean> {
    const row = await scope.db
      .selectFrom('organization.organization_locations')
      .select('id')
      .where('id', '=', locationId)
      .where('organization_id', '=', orgId)
      .where('status', '=', 'active')
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return !!row;
  }
}
