// PublicOrgCards (interface/public-profiles.ts): organization card parts with
// trust figures (published reviews, active public badges) and the newest
// publicly servable portfolio image. Reads in the caller's context under the
// public policies; explicit filters keep a system context equivalent.
import { Injectable, Optional } from '@nestjs/common';
import { sql } from 'kysely';
import type { Locale } from '#libs/i18n/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { MediaService } from '#modules/media/interface/media.js';
import { ratingString, TrustRead, type PublicBadgeRecord, type RatingFacts } from '#modules/trust/interface/trust.js';
import { PublicOrgCards, PublicProfiles, type PublicOrgCard } from '../interface/public-profiles.js';

@Injectable()
export class DbPublicOrgCards extends PublicOrgCards {
  constructor(
    private readonly profiles: PublicProfiles,
    @Optional() private readonly trust?: TrustRead,
    @Optional() private readonly media?: MediaService,
  ) {
    super();
  }

  /** The newest published public portfolio items per provider (at most 3 each). */
  async #recentPortfolio(scope: TxScope, orgIds: string[]): Promise<{ id: string; org: string }[]> {
    if (orgIds.length === 0) return [];
    const { rows } = await sql<{ id: string; org: string }>`
      SELECT id, org FROM (
        SELECT id, provider_organization_id AS org,
               row_number() OVER (PARTITION BY provider_organization_id ORDER BY published_at DESC, id DESC) AS n
          FROM organization.portfolio_items
         WHERE provider_organization_id = ANY(${sql.val(orgIds)}::uuid[])
           AND status = 'published' AND visibility = 'public' AND deleted_at IS NULL) p
       WHERE n <= 3 ORDER BY org, n`.execute(scope.db);
    return rows;
  }

  async cards(scope: TxScope, orgIds: readonly string[], locale: Locale): Promise<Map<string, PublicOrgCard>> {
    const parts = await this.profiles.cards(scope, orgIds);
    const ids = [...parts.keys()];
    if (ids.length === 0) return new Map();
    const [ratings, badges, recent] = await Promise.all([
      this.trust ? this.trust.ratings(scope, ids) : new Map<string, RatingFacts>(),
      this.trust ? this.trust.badges(scope, ids, locale) : new Map<string, PublicBadgeRecord[]>(),
      this.#recentPortfolio(scope, ids),
    ]);
    const images = this.media
      ? await this.media.publicImageUrls(
          scope,
          'portfolio_item',
          recent.map((r) => r.id),
        )
      : new Map<string, string>();
    const out = new Map<string, PublicOrgCard>();
    for (const [id, p] of parts) {
      const rating = ratings.get(id);
      const thumb = recent.find((r) => r.org === id && images.has(r.id));
      out.set(id, {
        ...p,
        overall_rating: ratingString(rating?.overall ?? null),
        review_count: rating?.count ?? 0,
        top_badges: [...new Set((badges.get(id) ?? []).map((b) => b.badge_type))].slice(0, 3),
        portfolio_thumbnail_url: thumb ? images.get(thumb.id)! : null,
      });
    }
    return out;
  }
}
