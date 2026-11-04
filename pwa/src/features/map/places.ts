// Places on a map (P6.T3/T4, Docs/21 S-SHARED-02 "Pins"): one place per business location, from map.pins (W-MAP-01)
// or from search result cards (the W-SRCH-01 pane and the directory map). The kind is told by shape and icon, never
// colour alone: shop = wrench in a circle, parts seller = box in a rounded square, both = both icons, mobile provider
// = a circle outline around its base with the service radius drawn. Ranks 1-3 are numbered for best-match orders
// only (54 §5.5). Dimmed = not matching the advanced-search highlight; still clickable. Since contract 1.1.0 a pin
// alone opens its profile (slug, roles) and its request step (organization id + pin id), and carries verified,
// review_count and its result_id in the map's search session (P14.T4, DI-44). Open now is a server filter
// (map.pins filters.open_now with only_matching, DI-45), never a client one. Pure functions.
import type { MapCluster, MapPin, OrgType, ResultCard } from '@carpal/api-contracts';
import type { Locale } from '@/lib/i18n/locales';
import { orgPath } from '@/lib/seo/urls';
import { distanceM, type Point } from './geo';

export type PlaceKind = 'shop' | 'seller' | 'hybrid' | 'mobile';

export interface Place {
  /** The location id (= MapPin.pin_id). */
  id: string;
  orgId: string;
  /** Opens the public profile (null: no public profile yet). */
  slug: string | null;
  organizationType: OrgType;
  roles: readonly ('provider' | 'vendor')[];
  point: Point;
  kind: PlaceKind;
  name: string;
  rank: number | null;
  dimmed: boolean;
  approximate: boolean;
  radiusKm: number | null;
  rating: string | null;
  reviewCount: number;
  verified: boolean;
  badge: string | null;
  openNow: boolean | null;
  reason: string | null;
  itemCount: number | null;
  relevant: boolean | null;
  /** This organization's result in the map's search session (search.result_event), from the pin or the card. */
  resultId: string | null;
  /** The result card of this business, when the list has it (slug, reasons, distance, next slot). */
  result: ResultCard | null;
}

export interface PlaceCluster {
  id: string;
  point: Point;
  count: number;
  expansionZoom: number;
}

/** At most this many ranks get a number on the map (Docs/21 S-SHARED-02). */
export const NUMBERED_RANKS = 3;
/** Fewer places than this with the vehicle filter on → "Show all nearby" (54 §5.5). */
export const VEHICLE_FILTER_MIN = 3;

export function kindOf(roles: readonly ('provider' | 'vendor')[], radiusKm: number | null): PlaceKind {
  const provider = roles.includes('provider');
  const vendor = roles.includes('vendor');
  if (provider && vendor) return 'hybrid';
  if (vendor) return 'seller';
  return radiusKm && radiusKm > 0 ? 'mobile' : 'shop';
}

/** The rank number drawn on a pin: 1-3 when the order is best match, else none. */
export function rankLabel(rank: number | null, bestMatch: boolean): number | null {
  return bestMatch && rank !== null && rank >= 1 && rank <= NUMBERED_RANKS ? rank : null;
}

/** The profile a place opens: the shop page for providers (and hybrids), else the parts-seller page. */
export function placeHref(place: Pick<Place, 'slug' | 'roles'>, locale: Locale): string | null {
  return orgPath(locale, { slug: place.slug, roles: [...place.roles] });
}

/** Places from map.pins, enriched with the result cards of the same search (by organization) where they exist. */
export function placesFromPins(pins: readonly MapPin[], results: readonly ResultCard[] = []): Place[] {
  const byOrg = new Map<string, ResultCard>();
  for (const r of results) if (!byOrg.has(r.organization.id)) byOrg.set(r.organization.id, r);
  return pins.map((p) => ({
    id: p.pin_id,
    orgId: p.organization_id,
    slug: p.slug ?? byOrg.get(p.organization_id)?.organization.slug ?? null,
    organizationType: p.organization_type,
    roles: p.roles,
    point: p.point,
    kind: kindOf(p.roles, p.service_radius_km),
    name: p.name,
    rank: p.rank,
    dimmed: !p.matches_filters,
    approximate: p.visibility !== 'exact',
    radiusKm: p.service_radius_km,
    rating: p.overall_rating,
    reviewCount: p.review_count,
    verified: p.verified,
    badge: p.badge,
    openNow: p.open_now,
    reason: p.reason_summary?.text ?? null,
    itemCount: p.matching_item_count,
    relevant: p.relevant_to_vehicle,
    resultId: p.result_id ?? byOrg.get(p.organization_id)?.result_id ?? null,
    result: byOrg.get(p.organization_id) ?? null,
  }));
}

/** Places from result cards (one per location; cards without a public location are left out). */
export function placesFromResults(results: readonly ResultCard[]): Place[] {
  const seen = new Set<string>();
  const out: Place[] = [];
  for (const r of results) {
    const loc = r.location;
    if (!loc || seen.has(loc.location_id)) continue;
    seen.add(loc.location_id);
    out.push({
      id: loc.location_id,
      orgId: r.organization.id,
      slug: r.organization.slug,
      organizationType: r.organization.organization_type,
      roles: r.organization.roles,
      point: loc.point,
      kind: kindOf(r.organization.roles, loc.service_radius_km),
      name: r.organization.name,
      rank: r.rank,
      dimmed: false,
      approximate: loc.visibility !== 'exact',
      radiusKm: loc.service_radius_km,
      rating: r.organization.overall_rating,
      reviewCount: r.organization.review_count,
      verified: r.organization.verified,
      badge: r.organization.top_badges[0] ?? null,
      openNow: r.open_now,
      reason: r.reasons[0]?.summary.text ?? null,
      itemCount: r.matching_item_count,
      relevant: r.relevant_to_vehicle,
      resultId: r.result_id,
      result: r,
    });
  }
  return out;
}

/**
 * The list of W-MAP-01: every result card of the area's search (also those whose pins are inside a cluster), with
 * the pin's flags where the pin is drawn, then pins that have no card.
 */
export function mergePlaces(fromResults: readonly Place[], fromPins: readonly Place[]): Place[] {
  const pins = new Map(fromPins.map((p) => [p.id, p]));
  const out = fromResults.map((r) => {
    const pin = pins.get(r.id);
    return pin ? { ...pin, rank: pin.rank ?? r.rank, resultId: pin.resultId ?? r.resultId, result: r.result } : r;
  });
  const seen = new Set(out.map((p) => p.id));
  for (const p of fromPins) if (!seen.has(p.id)) out.push(p);
  return out;
}

export function clustersFrom(clusters: readonly MapCluster[]): PlaceCluster[] {
  return clusters.map((c) => ({ id: c.cluster_id, point: c.point, count: c.count, expansionZoom: c.expansion_zoom }));
}

export interface ViewFilters {
  shops: boolean;
  sellers: boolean;
  hideOthers: boolean;
}

/** Client-side view filters: the layer chips and "Hide others" (Open now is a server filter since 1.1.0, DI-45). */
export function visiblePlaces(places: readonly Place[], v: ViewFilters): Place[] {
  return places.filter((p) => {
    const isShop = p.kind !== 'seller';
    const isSeller = p.kind === 'seller' || p.kind === 'hybrid';
    if (!((v.shops && isShop) || (v.sellers && isSeller))) return false;
    if (v.hideOthers && p.dimmed) return false;
    return true;
  });
}

/**
 * The list order: rank first (the search's order), then closeness to the map centre — after "Search this area" the
 * list says "Sorted by closeness to the map centre" (Docs/22 W-MAP-01).
 */
export function listOrder(places: readonly Place[], center: Point, byDistance: boolean): Place[] {
  const d = new Map(places.map((p) => [p.id, distanceM(center, p.point)]));
  return [...places].sort((a, b) =>
    byDistance ? d.get(a.id)! - d.get(b.id)! : (a.rank ?? 1e9) - (b.rank ?? 1e9) || d.get(a.id)! - d.get(b.id)!,
  );
}
