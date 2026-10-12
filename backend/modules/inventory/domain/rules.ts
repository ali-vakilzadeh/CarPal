// Inventory rules without I/O: item data quality and catalog quality
// (54 §7.2), inquiry transitions per side (40 §13.1) and portal groups
// (52 §9), trade-account decisions, and fitment matching for a vehicle
// (54 §7.1).

// ------------------------------------------------------------ quality

export interface ItemQualityFacts {
  images: number;
  partNumbers: boolean;
  category: boolean;
  warrantyNote: boolean;
  description: boolean;
  stockStatus: boolean;
}

/**
 * 52 InventoryItem.data_quality_score (54 §7.2 "images, part numbers,
 * category, warranty note, description, stock status"): each of the six
 * counts the same. Category and stock status are required fields, so every
 * stored item meets them.
 */
export function dataQualityScore(f: ItemQualityFacts): number {
  const met = [f.images > 0, f.partNumbers, f.category, f.warrantyNote, f.description, f.stockStatus].filter(Boolean).length;
  return Math.round((100 * met) / 6);
}

export interface CatalogFacts {
  /** Active items. */
  activeItems: number;
  /** Active items with at least one active, confirmed fitment row. */
  confirmedFitmentItems: number;
  /** Average data_quality_score of active items (0–100), null without items. */
  averageDataQuality: number | null;
  /** inquiry_fulfillment_rate (0–1), null without decidable inquiries. */
  fulfillmentRate: number | null;
}

/**
 * 54 §7.2 catalog quality: fitment coverage 35 %, data completeness 35 %,
 * inquiry fulfillment 30 %. A component without data (no active items, no
 * decidable inquiries yet) is left out and the others are re-weighted; with
 * no data at all the score is 0.
 */
export function catalogQualityScore(f: CatalogFacts): number {
  const parts: [number, number][] = [];
  if (f.activeItems > 0) {
    parts.push([0.35, f.confirmedFitmentItems / f.activeItems]);
    parts.push([0.35, (f.averageDataQuality ?? 0) / 100]);
  }
  if (f.fulfillmentRate !== null) parts.push([0.3, f.fulfillmentRate]);
  const weight = parts.reduce((s, [w]) => s + w, 0);
  if (weight === 0) return 0;
  return Math.round((100 * parts.reduce((s, [w, v]) => s + w * v, 0)) / weight);
}

/**
 * inquiry_fulfillment_rate (54 §3.2, §7.2 "speed and outcome of responses"),
 * over inquiries of the last 90 days: an inquiry is fulfilled when the
 * vendor answered within 24 hours and did not mark it unavailable. Not
 * decidable yet (left out): sent less than 24 hours ago without an answer,
 * or cancelled by the requester before any answer.
 */
export const FULFILLMENT_WINDOW_DAYS = 90;
export const FULFILLMENT_RESPONSE_HOURS = 24;

export function fulfillmentRate(eligible: number, fulfilled: number): number | null {
  return eligible > 0 ? Math.min(1, fulfilled / eligible) : null;
}

/** 40 VendorInsights.inquiry_fulfillment_rate: Dec<1,4>. */
export const rateString = (rate: number | null): string | null => (rate === null ? null : rate.toFixed(4));

// ------------------------------------------------------------ inquiries

export type InquiryStatus = 'sent' | 'answered' | 'reserved' | 'unavailable' | 'completed' | 'cancelled';
export type Side = 'vendor' | 'requester';

/** 40 §13.1 transitions by side. */
const TRANSITIONS: Record<Side, Partial<Record<InquiryStatus, InquiryStatus[]>>> = {
  vendor: {
    sent: ['answered', 'reserved', 'unavailable'],
    answered: ['reserved', 'unavailable', 'completed'],
    reserved: ['answered', 'unavailable', 'completed'],
  },
  requester: {
    sent: ['cancelled'],
    answered: ['cancelled', 'completed'],
    reserved: ['cancelled', 'completed'],
  },
};

export const inquiryTransitionAllowed = (side: Side, from: string, to: string): boolean =>
  (TRANSITIONS[side][from as InquiryStatus] ?? []).includes(to as InquiryStatus);

export const CLOSED_STATUSES: InquiryStatus[] = ['completed', 'unavailable', 'cancelled'];
export const inquiryClosed = (status: string): boolean => (CLOSED_STATUSES as string[]).includes(status);

/** Vendor portal grouping (52 §9 / MVP §11). */
export const INQUIRY_GROUPS: Record<'open' | 'answered' | 'reserved' | 'closed', InquiryStatus[]> = {
  open: ['sent'],
  answered: ['answered'],
  reserved: ['reserved'],
  closed: CLOSED_STATUSES,
};

/** 40 InquiryTransition.reserved_until: ≤ 14 days ahead. */
export const MAX_RESERVATION_MS = 14 * 86_400_000;

// ------------------------------------------------------------ trade accounts

export type TradeStatus = 'requested' | 'approved' | 'rejected' | 'revoked';
export type TradeDecision = 'approve' | 'reject' | 'revoke';

/** trade_accounts.vendor_decide: approve a request (or re-approve), reject a request, revoke an approval. */
const TRADE: Record<TradeDecision, { from: TradeStatus[]; to: TradeStatus }> = {
  approve: { from: ['requested', 'rejected', 'revoked'], to: 'approved' },
  reject: { from: ['requested'], to: 'rejected' },
  revoke: { from: ['approved'], to: 'revoked' },
};

export function tradeDecision(from: string, decision: TradeDecision): TradeStatus | null {
  const t = TRADE[decision];
  return t.from.includes(from as TradeStatus) ? t.to : null;
}

// ------------------------------------------------------------ fitment

export type FitmentConfidence = 'confirmed' | 'likely' | 'uncertain';

export interface FitmentRowFacts {
  brand_node_id: string;
  model_node_id: string | null;
  series_node_id: string | null;
  year_start: number | null;
  year_end: number | null;
  confidence: string;
}

export interface VehicleFacts {
  brand_node_id: string;
  model_node_id?: string | null;
  series_node_id?: string | null;
  year?: number | null;
}

const CONFIDENCE_RANK: Record<FitmentConfidence, number> = { uncertain: 1, likely: 2, confirmed: 3 };

/** A fitment row matches a vehicle when every field the row names agrees with it (a row without a model covers the brand). */
export function fitmentMatches(f: FitmentRowFacts, v: VehicleFacts): boolean {
  if (f.brand_node_id !== v.brand_node_id) return false;
  if (f.model_node_id && v.model_node_id && f.model_node_id !== v.model_node_id) return false;
  if (f.model_node_id && !v.model_node_id) return false;
  if (f.series_node_id && f.series_node_id !== (v.series_node_id ?? null)) return false;
  if (v.year) {
    if (f.year_start !== null && v.year < f.year_start) return false;
    if (f.year_end !== null && v.year > f.year_end) return false;
  }
  return true;
}

/** PublicInventoryCard.fitment_confidence_for_vehicle: the best confidence among matching rows (54 §7.1). */
export function bestConfidence(rows: readonly FitmentRowFacts[], v: VehicleFacts): FitmentConfidence | null {
  let best: FitmentConfidence | null = null;
  for (const r of rows) {
    if (!fitmentMatches(r, v)) continue;
    const c = r.confidence as FitmentConfidence;
    if (!best || CONFIDENCE_RANK[c] > CONFIDENCE_RANK[best]) best = c;
  }
  return best;
}
