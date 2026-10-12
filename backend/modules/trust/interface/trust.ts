// Public interface of the trust module (41 §4.2 interface/). S6 needs the
// public read side only: rating summaries and active public badges of
// organizations for profiles, search cards, map pins and ranking (54 §5),
// read under the public RLS policies (published reviews, active public
// badges). Review writing, invitations, approvals, disputes, trust scoring
// and badge rules arrive in S7 and keep this interface.
import type { L10n, Locale } from '#libs/i18n/index.js';
import type { TxScope } from '#libs/tenancy/index.js';

/** 40 §14.1 RatingSummary (Dec values as strings, e.g. "4.75"). */
export interface RatingSummary {
  overall: string | null;
  count_visit_verified: number;
  count_approved_without_visit: number;
  distribution: { '1': number; '2': number; '3': number; '4': number; '5': number };
  sub_ratings: { dimension: string; average: string }[];
}

/** Rating figures of one organization for cards and ranking. */
export interface RatingFacts {
  /** Average overall rating of published reviews (both confirmation paths), or null without reviews. */
  overall: number | null;
  /** Published (counted) reviews (52 §10 counted review count). */
  count: number;
}

/** 40 §14.1 PublicBadge plus its scope ids (search filters and the make_specialist reason). */
export interface PublicBadgeRecord {
  badge_type: string;
  scope: L10n[];
  scope_node_ids: string[];
  awarded_at: string;
}

export abstract class TrustRead {
  /** Rating figures per organization (absent organizations have no published reviews). */
  abstract ratings(scope: TxScope, orgIds: readonly string[]): Promise<Map<string, RatingFacts>>;
  /** The full 40 RatingSummary of one organization (public.org_get). */
  abstract ratingSummary(scope: TxScope, orgId: string): Promise<RatingSummary>;
  /** Active public badges per provider organization, newest first. */
  abstract badges(scope: TxScope, orgIds: readonly string[], locale: Locale): Promise<Map<string, PublicBadgeRecord[]>>;
  /** The subject organization of a published review (helpful reactions, SEC-BF-9), or null. */
  abstract publishedReviewSubject(scope: TxScope, reviewId: string): Promise<string | null>;
}

/** 40 PublicOrgCard.overall_rating: Dec<1,2> (two decimals at most). */
export const ratingString = (avg: number | null): string | null => (avg === null ? null : String(Math.round(avg * 100) / 100));
