// Public projections of organizations for discovery (S6: public.org_get,
// search cards and map pins), read in an anonymous or user RLS context
// (public_read policies). Only published profiles are returned. Locations
// follow SEC-OUT-4: the public point only, and no street line for
// approximate locations. Ratings, badges and portfolio thumbnails belong to
// trust and discovery and are added by the caller.
import type { L10n, Locale } from '#libs/i18n/index.js';
import type { TxScope } from '#libs/tenancy/index.js';

/** 40 §14.1 PublicLocation. */
export interface PublicLocation {
  id: string;
  name: string | null;
  point: { lat: number; lng: number } | null;
  visibility: 'exact' | 'approximate';
  address: { address_line_1: string | null; city: string; region: string | null; country: string };
  service_radius_km: number | null;
  hours: unknown;
  open_now: boolean | null;
  timezone: string;
  access_instructions: L10n | null;
}

/** 40 §14.1 PublicLocationPin. */
export interface PublicLocationPin {
  location_id: string;
  point: { lat: number; lng: number };
  visibility: 'exact' | 'approximate';
  service_radius_km: number | null;
  city: string;
}

/** The organization-owned parts of 40 PublicOrgProfile (provider.badges excluded: trust module). */
export interface PublicProfileParts {
  id: string;
  slug: string | null;
  name: string;
  organization_type: string;
  roles: ('provider' | 'vendor')[];
  verified: boolean;
  price_tier: string | null;
  measured_response_time_minutes: number | null;
  logo_url: string | null;
  description: L10n | null;
  website: string | null;
  contact_channels: unknown[];
  locations: PublicLocation[];
  provider: Record<string, unknown> | null;
  vendor: Record<string, unknown> | null;
}

/** A published vendor (active organization, published vendor profile). */
export interface PublishedVendor {
  orgId: string;
  /** 52 VendorProfile.trade_customers_supported: trade accounts may be requested. */
  tradeCustomersSupported: boolean;
}

export abstract class PublicProfiles {
  /** The public parts of an organization with a published provider or vendor profile; null otherwise. */
  abstract profile(scope: TxScope, orgId: string, locale: Locale, now?: Date): Promise<PublicProfileParts | null>;
  /** The organizations among `orgIds` that are published vendors (public items and trade accounts follow the vendor's publication). */
  abstract vendors(scope: TxScope, orgIds: readonly string[]): Promise<Map<string, PublishedVendor>>;
  /** Map pins (one per active location) of organizations with a published profile. */
  abstract pins(scope: TxScope, orgIds: readonly string[]): Promise<Map<string, PublicLocationPin[]>>;
}
