// Vendor figures other modules compute and the organization module stores
// on the vendor profile (52 VendorProfile): the catalog quality score (54
// §7.2, computed by inventory from items, fitment and inquiries) and the
// measured inquiry response time. And the location check for records that
// name a business location (inventory items).
import type { TxScope } from '#libs/tenancy/index.js';

export interface VendorFigures {
  catalogQualityScore?: number;
  measuredResponseTimeMinutes?: number | null;
}

export abstract class VendorCatalog {
  /**
   * Writes the figures on the vendor profile in the caller's transaction
   * (the vendor member's or the system context). The row is touched only
   * when a value changes, because every write moves the profile's version
   * (ETag). No-op while the vendor has no profile.
   */
  abstract record(scope: TxScope, vendorOrgId: string, figures: VendorFigures): Promise<void>;
}

export abstract class OrgLocations {
  /** True when the location is an active location of the organization (member context). */
  abstract isActive(scope: TxScope, orgId: string, locationId: string): Promise<boolean>;
}
