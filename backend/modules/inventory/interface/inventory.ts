// Public interface of the inventory module (41 §4.2 interface/): item
// visibility checks for references in other modules' bodies (SEC-AZ-4,
// e.g. ServiceRecord.parts_used), and the public item projections discovery
// (S6) serves through public.org_inventory_search / public.inventory_get.
// Public items follow 52 §21: vendor published, item active, visibility
// public, or trade_only for members of an organization with an approved
// trade account; price_trade only for those (SEC-OUT-1).
import type { L10n, Locale } from '#libs/i18n/index.js';
import type { TxScope } from '#libs/tenancy/index.js';

/** 40 §14.1 PublicInventoryCard. */
export interface PublicInventoryCard {
  id: string;
  name: L10n;
  part_origin: string;
  condition: string;
  part_category: L10n;
  /** The public price, or the trade price for callers with an approved trade account. */
  price: { amount: string; currency: string } | null;
  price_on_request: boolean;
  stock_status: string;
  fitment_confidence_for_vehicle: 'confirmed' | 'likely' | 'uncertain' | null;
  image_url: string | null;
}

/** The item-owned parts of 40 PublicInventoryItem (vendor card and location pin come from the organization module). */
export interface PublicInventoryItemParts extends PublicInventoryCard {
  vendor_organization_id: string;
  location_id: string | null;
  description: L10n | null;
  brand: string | null;
  oem_numbers: string[];
  aftermarket_numbers: string[];
  position: string[];
  warranty_note: string | null;
  fitment: {
    brand: L10n;
    model: L10n | null;
    series: L10n | null;
    year_start: number | null;
    year_end: number | null;
    engine: L10n | null;
    confidence: 'confirmed' | 'likely' | 'uncertain';
  }[];
  is_trade_price: boolean;
}

/** A vehicle to rate fitment against (40 public.org_inventory_search `vehicle`). */
export interface FitmentVehicle {
  brand_node_id: string;
  model_node_id?: string | null;
  series_node_id?: string | null;
  year?: number | null;
}

export abstract class InventoryRead {
  /**
   * The items among `ids` the caller's context may reference: its own
   * vendor's items, or public (and permitted trade-only) active items of
   * published vendors.
   */
  abstract visibleIds(scope: TxScope, ids: readonly string[]): Promise<Set<string>>;
  /**
   * Public cards of items visible to the caller, in the caller's RLS context
   * (anonymous, user, or `asOrganization` set as the context organization by
   * the caller after authorizing it, for trade prices).
   */
  abstract publicCards(
    scope: TxScope,
    ids: readonly string[],
    o: { locale: Locale; vehicle?: FitmentVehicle | null },
  ): Promise<Map<string, PublicInventoryCard>>;
  /** The item-owned parts of a public item, or null when the caller may not see it. */
  abstract publicItem(scope: TxScope, id: string, o: { locale: Locale }): Promise<PublicInventoryItemParts | null>;
}
