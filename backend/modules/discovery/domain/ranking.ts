// Match scores and reasons (54 §5; 52 MatchResult). Pure functions over the
// search documents. Every score is 0-100, comes with at least one structured
// reason (public data only) and never takes plan, payment or sponsorship as
// an input (54 §5.4). Category trust blends the W3 trust score (S7) with the
// rating evidence; operational fit blends the response time with the next
// open appointment slot when the provider keeps a calendar (S7).

export type ReasonType =
  'capability_evidence' | 'rating_evidence' | 'location' | 'availability' | 'urgency_fit' | 'user_preference' | 'trust_signal' | 'recency';
export type ReasonValues = Record<string, string | number | boolean | null>;
export interface Reason {
  reason_type: ReasonType;
  values: ReasonValues;
}
export interface Scored {
  score: number;
  confidence: 'low' | 'moderate' | 'high';
  reasons: Reason[];
  relevant_to_vehicle: boolean | null;
}

export const CONFIDENCE_LEVEL: Record<string, number> = {
  self_declared: 0,
  low_evidence: 1,
  moderate_evidence: 2,
  strong_evidence: 3,
  verified_expert: 4,
};
/** Capability fit per confidence level (54 §5.1: level 2+ scores high, self-declared near zero). */
const FIT = [0.1, 0.45, 0.8, 0.92, 1];
export const FITMENT_WEIGHT: Record<string, number> = { confirmed: 1, likely: 0.7, uncertain: 0.3 };
const STOCK_WEIGHT: Record<string, number> = { in_stock: 1, low_stock: 0.7, available_on_request: 0.4, out_of_stock: 0 };

export interface VehicleContext {
  brand: string;
  model?: string | null;
  series?: string | null;
  year?: number | null;
}

export interface MatchContext {
  /** Requested service systems and tasks (chips, filters, symptom mappings). */
  services: ReadonlySet<string>;
  partCategories: ReadonlySet<string>;
  vehicle: VehicleContext | null;
  urgency: 'low' | 'medium' | 'high' | 'safety_critical' | null;
  /** Distance at which the distance factor reaches 0. */
  maxDistanceKm: number;
  favorites: ReadonlySet<string>;
  /** Ranking time (availability fit); defaults to now. */
  now?: number;
}

export interface ProviderFacts {
  organization_id: string;
  capabilities: {
    brand: string | null;
    model: string | null;
    series: string | null;
    system: string;
    task: string | null;
    level: number;
    evidence: number;
  }[];
  service_node_ids: string[];
  brand_node_ids: string[];
  model_node_ids: string[];
  overall_rating: number | null;
  review_count: number;
  verified: boolean;
  badges: string[];
  measured_response_time_minutes: number | null;
  response_time_target: string | null;
  activity_status: string;
  service_modes: string[];
  /** 54 §3 trust score (S7), null until scored. */
  trust_score?: number | null;
  /** Earliest open slot (ISO), null without a calendar (S7). */
  next_available_at?: string | null;
}

export interface VendorFacts {
  organization_id: string;
  part_category_node_ids: string[];
  brand_node_ids: string[];
  overall_rating: number | null;
  review_count: number;
  verified: boolean;
  measured_response_time_minutes: number | null;
}

/** Items of one vendor matching the request (from the inventory projection). */
export interface ItemMatch {
  count: number;
  inStock: number;
  /** Best fitment weight for the vehicle (0 when none or no vehicle). */
  fitment: number;
  bestConfidence: string | null;
}

const round2 = (x: number): number => Math.round(x * 100) / 100;
const clamp = (x: number): number => Math.max(0, Math.min(1, x));

/** Category trust from published ratings (trust score in S7): neutral 0.5 without reviews, toward the rating with volume. */
function ratingTrust(rating: number | null, count: number, verified: boolean): number {
  const part = rating === null ? 0.5 : (rating - 1) / 4;
  const w = Math.min(1, count / 10);
  return clamp(0.5 * (1 - w) + part * w + (verified ? 0.05 : 0));
}

/** Category trust (54 §5.1): the trust score blended with the rating evidence once W3 scored the provider. */
function categoryTrust(p: ProviderFacts): number {
  const rating = ratingTrust(p.overall_rating, p.review_count, p.verified);
  return p.trust_score === null || p.trust_score === undefined ? rating : clamp(0.5 * (p.trust_score / 100) + 0.5 * rating);
}

/** Availability fit (54 §5.1 operational: next available slot within the needed window); null without a calendar. */
export function availabilityFit(next: string | null | undefined, now: number): number | null {
  if (!next) return null;
  const days = (Date.parse(next) - now) / 86_400_000;
  return days <= 1 ? 1 : days <= 3 ? 0.85 : days <= 7 ? 0.7 : 0.5;
}

function responseFit(minutes: number | null, target: string | null): number {
  if (minutes !== null) return minutes <= 120 ? 1 : minutes <= 1440 ? 0.7 : 0.4;
  return { within_2h: 0.9, same_day: 0.75, within_24h: 0.6, within_48h: 0.45 }[target ?? ''] ?? 0.5;
}

const distanceFit = (d: number | null, max: number): number => (d === null ? 0.5 : clamp(1 - d / Math.max(max, 1)));

export function vehicleCovers(v: VehicleContext, c: { brand: string | null; model: string | null }): boolean {
  if (!c.brand) return true;
  if (c.brand !== v.brand) return false;
  return !c.model || !v.model || c.model === v.model;
}

/** A fitment row matches a vehicle when every field it names agrees (as the inventory module rates fitment). */
export function fitmentMatches(
  f: { brand: string; model: string | null; series: string | null; year_start: number | null; year_end: number | null },
  v: VehicleContext,
): boolean {
  if (f.brand !== v.brand) return false;
  if (f.model && f.model !== (v.model ?? null)) return false;
  if (f.series && f.series !== (v.series ?? null)) return false;
  if (v.year) {
    if (f.year_start !== null && v.year < f.year_start) return false;
    if (f.year_end !== null && v.year > f.year_end) return false;
  }
  return true;
}

function confidenceOf(score: number, evidence: boolean): Scored['confidence'] {
  if (score >= 60 && evidence) return 'high';
  return score >= 40 || evidence ? 'moderate' : 'low';
}

const urgent = (u: MatchContext['urgency']): boolean => u === 'high' || u === 'safety_critical';

function withBonus(base: number, orgId: string, ctx: MatchContext, reasons: Reason[]): number {
  // 54 §5.1 user preference bonus: +5 for a favourite (fleet preferred partners join in S8), capped at +10.
  if (!ctx.favorites.has(orgId)) return base;
  reasons.push({ reason_type: 'user_preference', values: { favorite: true } });
  return base + 5;
}

/** 54 §5.1 provider match score. */
export function scoreProvider(p: ProviderFacts, distanceKm: number | null, ctx: MatchContext): Scored {
  const reasons: Reason[] = [];
  const v = ctx.vehicle;
  const matching = p.capabilities.filter(
    (c) => (ctx.services.size === 0 || ctx.services.has(c.system) || (!!c.task && ctx.services.has(c.task))) && (!v || vehicleCovers(v, c)),
  );
  const best = matching.reduce<(typeof matching)[number] | null>(
    (a, c) => (!a || c.level > a.level || (c.level === a.level && c.evidence > a.evidence) ? c : a),
    null,
  );
  const coversVehicle = v ? p.brand_node_ids.includes(v.brand) || matching.some((c) => c.brand === v.brand) : null;
  let fit: number;
  if (best) {
    fit = FIT[best.level] ?? 0.1;
    reasons.push({
      reason_type: 'capability_evidence',
      values: { level: best.level, jobs: best.evidence, system_node_id: best.system, task_node_id: best.task, brand_node_id: best.brand },
    });
  } else if (ctx.services.size > 0) {
    // Offered in the service catalogue without evidence yet ("evidence over claims", 54 §5.4).
    fit = 0.1;
    const offered = p.service_node_ids.find((id) => ctx.services.has(id)) ?? null;
    reasons.push({ reason_type: 'capability_evidence', values: { level: 0, offered: true, system_node_id: offered } });
  } else {
    fit = v ? (coversVehicle ? 0.6 : 0.3) : 0.5;
    if (v && coversVehicle) reasons.push({ reason_type: 'capability_evidence', values: { covered: true, brand_node_id: v.brand } });
  }
  const trust = categoryTrust(p);
  if (p.review_count > 0)
    reasons.push({
      reason_type: 'rating_evidence',
      values: { avg_rating: String(round2(p.overall_rating ?? 0)), reviews: p.review_count },
    });
  if (p.verified || p.badges.length)
    reasons.push({ reason_type: 'trust_signal', values: { verified: p.verified, badge: p.badges[0] ?? null } });
  const response = responseFit(p.measured_response_time_minutes, p.response_time_target);
  const slot = availabilityFit(p.next_available_at, ctx.now ?? Date.now());
  const operational = slot === null ? response : (response + slot) / 2;
  if (p.measured_response_time_minutes !== null || p.response_time_target || slot !== null)
    reasons.push({
      reason_type: 'availability',
      values: {
        response_minutes: p.measured_response_time_minutes,
        response_target: p.response_time_target,
        ...(p.next_available_at ? { next_available_at: p.next_available_at } : {}),
      },
    });
  const dist = distanceFit(distanceKm, ctx.maxDistanceKm);
  if (distanceKm !== null) reasons.push({ reason_type: 'location', values: { distance_km: String(Math.round(distanceKm * 10) / 10) } });
  const w = urgent(ctx.urgency) ? [0.35, 0.25, 0.3, 0.1] : [0.4, 0.3, 0.2, 0.1];
  if (urgent(ctx.urgency)) reasons.push({ reason_type: 'urgency_fit', values: { urgency_level: ctx.urgency, fast: operational >= 0.9 } });
  let score = 100 * (w[0]! * fit + w[1]! * trust + w[2]! * operational + w[3]! * dist);
  score = withBonus(score, p.organization_id, ctx, reasons);
  if (reasons.length === 0) reasons.push({ reason_type: 'location', values: { distance_km: null } });
  return {
    score: round2(Math.min(100, score)),
    confidence: confidenceOf(score, !!best && best.level >= 2),
    reasons: reasons.slice(0, 8),
    relevant_to_vehicle: coversVehicle,
  };
}

/** 54 §5.2 vendor match score. */
export function scoreVendor(vd: VendorFacts, items: ItemMatch | undefined, distanceKm: number | null, ctx: MatchContext): Scored {
  const reasons: Reason[] = [];
  const v = ctx.vehicle;
  const fitment = v ? (items?.fitment ?? 0) : 0.5;
  if (items && items.count > 0)
    reasons.push({ reason_type: 'capability_evidence', values: { matching_items: items.count, fitment_confidence: items.bestConfidence } });
  const stock = items ? (items.count ? (items.inStock > 0 ? 1 : 0.3) : 0.2) : 0.5;
  if (items?.inStock) reasons.push({ reason_type: 'availability', values: { in_stock_items: items.inStock } });
  const dist = distanceFit(distanceKm, ctx.maxDistanceKm);
  if (distanceKm !== null) reasons.push({ reason_type: 'location', values: { distance_km: String(Math.round(distanceKm * 10) / 10) } });
  const rating = ratingTrust(vd.overall_rating, vd.review_count, vd.verified);
  if (vd.review_count > 0)
    reasons.push({
      reason_type: 'rating_evidence',
      values: { avg_rating: String(round2(vd.overall_rating ?? 0)), reviews: vd.review_count },
    });
  if (vd.verified) reasons.push({ reason_type: 'trust_signal', values: { verified: true, badge: null } });
  const response = responseFit(vd.measured_response_time_minutes, null);
  const relevance =
    ctx.partCategories.size === 0 ? 0.5 : vd.part_category_node_ids.some((c) => ctx.partCategories.has(c)) ? 1 : items?.count ? 0.8 : 0.3;
  let score = 100 * (0.3 * fitment + 0.2 * stock + 0.15 * dist + 0.15 * rating + 0.1 * response + 0.1 * relevance);
  score = withBonus(score, vd.organization_id, ctx, reasons);
  if (reasons.length === 0) reasons.push({ reason_type: 'location', values: { distance_km: null } });
  const relevant = v ? (items?.fitment ?? 0) > 0 || vd.brand_node_ids.includes(v.brand) : null;
  return {
    score: round2(Math.min(100, score)),
    confidence: confidenceOf(score, fitment >= 0.7),
    reasons: reasons.slice(0, 8),
    relevant_to_vehicle: relevant,
  };
}

export interface ItemFacts {
  stock_status: string;
  data_quality_score: number;
  condition: string;
  price_on_request: boolean;
  fitmentWeight: number;
  bestConfidence: string | null;
}

/** 54 §5.3 inventory item score. */
export function scoreItem(
  i: ItemFacts,
  vendorRating: { overall: number | null; count: number },
  distanceKm: number | null,
  ctx: MatchContext,
  conditions: readonly string[] | undefined,
): Scored {
  const reasons: Reason[] = [];
  const fit = ctx.vehicle ? i.fitmentWeight : 0.5;
  if (i.bestConfidence) reasons.push({ reason_type: 'capability_evidence', values: { fitment_confidence: i.bestConfidence } });
  const stock = STOCK_WEIGHT[i.stock_status] ?? 0.3;
  reasons.push({ reason_type: 'availability', values: { stock_status: i.stock_status } });
  const rating = ratingTrust(vendorRating.overall, vendorRating.count, false);
  if (vendorRating.count > 0)
    reasons.push({
      reason_type: 'rating_evidence',
      values: { avg_rating: String(round2(vendorRating.overall ?? 0)), reviews: vendorRating.count },
    });
  const dist = distanceFit(distanceKm, ctx.maxDistanceKm);
  if (distanceKm !== null) reasons.push({ reason_type: 'location', values: { distance_km: String(Math.round(distanceKm * 10) / 10) } });
  const completeness = clamp(i.data_quality_score / 100);
  const priceFit = (conditions?.length ? (conditions.includes(i.condition) ? 1 : 0.3) : 0.6) * (i.price_on_request ? 0.8 : 1);
  const score = 100 * (0.35 * fit + 0.2 * stock + 0.15 * rating + 0.1 * dist + 0.1 * completeness + 0.1 * priceFit);
  return {
    score: round2(Math.min(100, score)),
    confidence: confidenceOf(score, i.fitmentWeight >= 0.7),
    reasons: reasons.slice(0, 8),
    relevant_to_vehicle: ctx.vehicle ? i.fitmentWeight > 0 : null,
  };
}
