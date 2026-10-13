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

/** The organization-owned parts of 40 PublicOrgCard (rating, review count, badges and portfolio thumbnail come from trust and discovery). */
export interface PublicOrgCardParts {
  id: string;
  slug: string | null;
  name: string;
  organization_type: string;
  roles: ('provider' | 'vendor')[];
  verified: boolean;
  price_tier: string | null;
  measured_response_time_minutes: number | null;
  logo_url: string | null;
}

/** A public location as indexed (52 §10 geo_point = the public point, SEC-OUT-4). */
export interface SearchLocation {
  location_id: string;
  point: { lat: number; lng: number };
  visibility: 'exact' | 'approximate';
  service_radius_km: number | null;
  city: string;
  hours: unknown;
  timezone: string;
}

/**
 * Everything the search projections (52 §10 ProviderSearchDoc / VendorSearchDoc)
 * need from the organization module for one published organization. Text in
 * every locale; taxonomy as node ids. No contact data, no street lines.
 */
export interface OrgSearchSource {
  id: string;
  slug: string | null;
  name: string;
  organization_type: string;
  verified: boolean;
  /** 54 §3 Organization.trust_score (0–100), null until W3 scored it. */
  trust_score: number | null;
  description_translations: Record<string, string> | null;
  locations: SearchLocation[];
  provider: {
    provider_type: string;
    service_modes: string[];
    price_tier: string;
    warranty_offered: boolean;
    response_time_target: string | null;
    measured_response_time_minutes: number | null;
    languages_spoken: string[];
    profile_completeness: number;
    activity_status: string;
    amenity_node_ids: string[];
    /** Active public service categories (system or task nodes). */
    category_node_ids: string[];
    coverage: { brand_node_id: string; model_node_id: string | null; series_node_id: string | null }[];
    /** Approved public capabilities (52 ProviderCapability, ≥ low_evidence). */
    capabilities: {
      brand_node_id: string | null;
      model_node_id: string | null;
      series_node_id: string | null;
      service_system_node_id: string;
      service_task_node_id: string | null;
      confidence_level: string;
      evidence_count: number;
    }[];
    certification_types: string[];
    published_portfolio_count: number;
  } | null;
  vendor: {
    vendor_type: string;
    delivery_options: string[];
    trade_customers_supported: boolean;
    default_price_visibility: string;
    catalog_quality_score: number;
    measured_response_time_minutes: number | null;
    coverage: { node_id: string; coverage_type: string }[];
  } | null;
}

/** 40 §19.1 PublicPortfolioItem without the organization card (added by the caller). */
export interface PublicPortfolioParts {
  id: string;
  organization_id: string;
  title: string;
  description: string | null;
  content_locale: string;
  vehicle: { brand: L10n | null; model: L10n | null; series: L10n | null };
  service_system: L10n;
  service_task: L10n | null;
  tags: { node_id: string; label: L10n }[];
  job_date: string | null;
  caption: string | null;
  media: unknown[];
  like_count: number;
  published_at: string;
}

/** A published portfolio item as indexed (52 §10 CommunitySearchDoc, entity_type portfolio_item). */
export interface PortfolioSearchSource {
  id: string;
  organization_id: string;
  title: string;
  description: string | null;
  caption: string | null;
  content_locale: string;
  node_ids: string[];
  published_at: Date;
}

export interface PortfolioQuery {
  service_system_node_id?: string;
  brand_node_id?: string;
  /** Keyset: published_at desc, id desc. */
  after?: { published_at: string; id: string };
  limit: number;
}

export abstract class PublicProfiles {
  /** The public parts of an organization with a published provider or vendor profile; null otherwise. */
  abstract profile(scope: TxScope, orgId: string, locale: Locale, now?: Date): Promise<PublicProfileParts | null>;
  /** The organizations among `orgIds` that are published vendors (public items and trade accounts follow the vendor's publication). */
  abstract vendors(scope: TxScope, orgIds: readonly string[]): Promise<Map<string, PublishedVendor>>;
  /** Map pins (one per active location) of organizations with a published profile. */
  abstract pins(scope: TxScope, orgIds: readonly string[]): Promise<Map<string, PublicLocationPin[]>>;
  /** The organization with a published profile and this slug (public.org_get), or null. */
  abstract idBySlug(scope: TxScope, slug: string): Promise<string | null>;
  /** Card parts of organizations with a published profile (follows, favourites, search cards). */
  abstract cards(scope: TxScope, orgIds: readonly string[]): Promise<Map<string, PublicOrgCardParts>>;
  /** Search sources of organizations with a published profile; absent ids are not (or no longer) public. */
  abstract searchSources(scope: TxScope, orgIds: readonly string[]): Promise<Map<string, OrgSearchSource>>;
  /** Organizations with a published profile, by id (reconciliation pages). */
  abstract publishedIds(scope: TxScope, afterId: string | null, limit: number): Promise<string[]>;
  /**
   * Organizations whose public projection may have changed after `since`
   * (organization, profiles, locations, catalog, coverage, capabilities,
   * certifications, portfolio), oldest change first, with the newest change time.
   */
  abstract changedSince(scope: TxScope, since: Date, limit: number): Promise<{ ids: string[]; until: Date | null }>;
  /** Published public portfolio items of a provider, newest first (public.org_portfolio). */
  abstract portfolio(scope: TxScope, orgId: string, q: PortfolioQuery, locale: Locale): Promise<PublicPortfolioParts[]>;
  /** Published public portfolio items by id (showcases.get, feeds); absent when not public. */
  abstract portfolioItems(scope: TxScope, ids: readonly string[], locale: Locale): Promise<Map<string, PublicPortfolioParts>>;
  /** Published public portfolio items as indexed (community search projection). */
  abstract portfolioSources(scope: TxScope, ids: readonly string[]): Promise<Map<string, PortfolioSearchSource>>;
  /** Ids of a provider's published portfolio items (reindexing an organization). */
  abstract portfolioIds(scope: TxScope, orgId: string): Promise<string[]>;
  /**
   * A portfolio item visible in the caller's context (its own organization's
   * items in any status, or published public ones), for references such as
   * PostWrite.portfolio_item_id; null when unknown.
   */
  abstract portfolioItemStatus(
    scope: TxScope,
    itemId: string,
  ): Promise<{ organizationId: string; status: string; customerConsentStatus: string } | null>;
}

/** 40 §14.1 PublicOrgCard. */
export interface PublicOrgCard extends PublicOrgCardParts {
  overall_rating: string | null;
  review_count: number;
  top_badges: string[];
  portfolio_thumbnail_url: string | null;
}

/**
 * Full public cards of organizations with a published profile: the
 * organization parts plus ratings and top badges (trust) and the newest
 * publicly servable portfolio image (media). Used by every module that shows
 * an organization publicly (search results, follows, favourites, inventory,
 * posts, answers).
 */
export abstract class PublicOrgCards {
  abstract cards(scope: TxScope, orgIds: readonly string[], locale: Locale): Promise<Map<string, PublicOrgCard>>;
}
