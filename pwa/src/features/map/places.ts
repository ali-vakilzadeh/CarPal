// Places on a map (P6.T3/T4, Docs/21 S-SHARED-02 "Pins"): one place per business location, from map.pins (W-MAP-01)
// or from search result cards (the W-SRCH-01 pane and the directory map). The kind is told by shape and icon, never
// colour alone: shop = wrench in a circle, parts seller = box in a rounded square, both = both icons, mobile provider
// = a circle outline around its base with the service radius drawn. Ranks 1-3 are numbered for best-match orders
// only (54 §5.5). Dimmed = not matching the advanced-search highlight; still clickable. Pure functions.
import type { MapCluster, MapPin, ResultCard } from '@carpal/api-contracts';
import { distanceM, type Point } from './geo';

export type PlaceKind = 'shop' | 'seller' | 'hybrid' | 'mobile';

export interface Place {
  /** The location id (= MapPin.pin_id). */
  id: string;
  orgId: string;
  point: Point;
  kind: PlaceKind;
  name: string;
  rank: number | null;
  dimmed: boolean;
  approximate: boolean;
  radiusKm: number | null;
  rating: string | null;
  badge: string | null;
  openNow: boolean | null;
  reason: string | null;
  itemCount: number | null;
  relevant: boolean | null;
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

/** Places from map.pins, joined with the result cards of the same search (by organization). */
export function placesFromPins(pins: readonly MapPin[], results: readonly ResultCard[] = []): Place[] {
  const byOrg = new Map<string, ResultCard>();
  for (const r of results) if (!byOrg.has(r.organization.id)) byOrg.set(r.organization.id, r);
  return pins.map((p) => ({
    id: p.pin_id,
    orgId: p.organization_id,
    point: p.point,
    kind: kindOf(p.roles, p.service_radius_km),
    name: p.name,
    rank: p.rank,
    dimmed: !p.matches_filters,
    approximate: p.visibility !== 'exact',
    radiusKm: p.service_radius_km,
    rating: p.overall_rating,
    badge: p.badge,
    openNow: p.open_now,
    reason: p.reason_summary?.text ?? null,
    itemCount: p.matching_item_count,
    relevant: p.relevant_to_vehicle,
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
      point: loc.point,
      kind: kindOf(r.organization.roles, loc.service_radius_km),
      name: r.organization.name,
      rank: r.rank,
      dimmed: false,
      approximate: loc.visibility !== 'exact',
      radiusKm: loc.service_radius_km,
      rating: r.organization.overall_rating,
      badge: r.organization.top_badges[0] ?? null,
      openNow: r.open_now,
      reason: r.reasons[0]?.summary.text ?? null,
      itemCount: r.matching_item_count,
      relevant: r.relevant_to_vehicle,
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
    return pin ? { ...pin, rank: pin.rank ?? r.rank, result: r.result } : r;
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
  openNow: boolean;
  hideOthers: boolean;
}

/** Client-side view filters: the layer chips, Open now (map.pins has no open-now filter) and "Hide others". */
export function visiblePlaces(places: readonly Place[], v: ViewFilters): Place[] {
  return places.filter((p) => {
    const isShop = p.kind !== 'seller';
    const isSeller = p.kind === 'seller' || p.kind === 'hybrid';
    if (!((v.shops && isShop) || (v.sellers && isSeller))) return false;
    if (v.openNow && p.openNow !== true) return false;
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

export function highlightCounts(places: readonly Place[]): { matching: number; others: number } {
  const others = places.filter((p) => p.dimmed).length;
  return { matching: places.length - others, others };
}
