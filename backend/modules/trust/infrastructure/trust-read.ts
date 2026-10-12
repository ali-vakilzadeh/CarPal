// TrustRead (interface/trust.ts) under the public RLS policies: published
// reviews (public_read) and active public badges. Every query also filters
// explicitly, so a worker's system context gets the same public figures.
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { textArray } from '#libs/db/index.js';
import type { L10n, Locale } from '#libs/i18n/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { ratingString, TrustRead, type PublicBadgeRecord, type RatingFacts, type RatingSummary } from '../interface/trust.js';

@Injectable()
export class DbTrustRead extends TrustRead {
  constructor(private readonly taxonomy: TaxonomyResolver) {
    super();
  }

  async ratings(scope: TxScope, orgIds: readonly string[]): Promise<Map<string, RatingFacts>> {
    const ids = [...new Set(orgIds)].slice(0, 1000);
    if (ids.length === 0) return new Map();
    const rows = await scope.db
      .selectFrom('trust.reviews')
      .select(['subject_organization_id', sql<string>`avg(overall_rating)`.as('avg'), sql<string>`count(*)`.as('n')])
      .where('subject_organization_id', 'in', ids)
      .where('status', '=', 'published')
      .where('deleted_at', 'is', null)
      .groupBy('subject_organization_id')
      .execute();
    return new Map(rows.map((r) => [r.subject_organization_id, { overall: Number(r.avg), count: Number(r.n) }]));
  }

  async ratingSummary(scope: TxScope, orgId: string): Promise<RatingSummary> {
    const rows = await scope.db
      .selectFrom('trust.reviews')
      .select(['overall_rating', 'confirmation_path', sql<string>`count(*)`.as('n')])
      .where('subject_organization_id', '=', orgId)
      .where('status', '=', 'published')
      .where('deleted_at', 'is', null)
      .groupBy(['overall_rating', 'confirmation_path'])
      .execute();
    const distribution = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
    let sum = 0;
    let count = 0;
    let visit = 0;
    let approved = 0;
    for (const r of rows) {
      const n = Number(r.n);
      distribution[String(r.overall_rating) as keyof typeof distribution] += n;
      sum += Number(r.overall_rating) * n;
      count += n;
      if (r.confirmation_path === 'visit_based') visit += n;
      else if (r.confirmation_path === 'approval_based') approved += n;
    }
    const subs = await scope.db
      .selectFrom('trust.review_sub_ratings as s')
      .innerJoin('trust.reviews as r', 'r.id', 's.review_id')
      .select(['s.dimension', sql<string>`avg(s.rating)`.as('avg')])
      .where('r.subject_organization_id', '=', orgId)
      .where('r.status', '=', 'published')
      .where('r.deleted_at', 'is', null)
      .where('s.deleted_at', 'is', null)
      .groupBy('s.dimension')
      .orderBy('s.dimension')
      .execute();
    return {
      overall: count ? ratingString(sum / count) : null,
      count_visit_verified: visit,
      count_approved_without_visit: approved,
      distribution,
      sub_ratings: subs.map((s) => ({ dimension: s.dimension, average: ratingString(Number(s.avg))! })),
    };
  }

  async badges(scope: TxScope, orgIds: readonly string[], locale: Locale): Promise<Map<string, PublicBadgeRecord[]>> {
    const ids = [...new Set(orgIds)].slice(0, 1000);
    const out = new Map<string, PublicBadgeRecord[]>();
    if (ids.length === 0) return out;
    const rows = await scope.db
      .selectFrom('trust.provider_badges')
      .select(['provider_organization_id', 'badge_type', 'scope_taxonomy_node_ids', 'awarded_at'])
      .where('provider_organization_id', 'in', ids)
      .where('status', '=', 'active')
      .where('visibility', '=', 'public')
      .where('deleted_at', 'is', null)
      .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', sql<Date>`now()`)]))
      .orderBy('awarded_at', 'desc')
      .orderBy('id')
      .execute();
    const labels = await this.taxonomy.labels(
      rows.flatMap((r) => textArray(r.scope_taxonomy_node_ids)),
      locale,
    );
    for (const r of rows) {
      const scopeIds = textArray(r.scope_taxonomy_node_ids);
      const badge: PublicBadgeRecord = {
        badge_type: r.badge_type,
        scope: scopeIds.map((id) => labels.get(id)).filter((l): l is L10n => !!l),
        scope_node_ids: scopeIds,
        awarded_at: new Date(r.awarded_at).toISOString(),
      };
      out.set(r.provider_organization_id, [...(out.get(r.provider_organization_id) ?? []), badge]);
    }
    return out;
  }

  async publishedReviewSubject(scope: TxScope, reviewId: string): Promise<string | null> {
    const row = await scope.db
      .selectFrom('trust.reviews')
      .select('subject_organization_id')
      .where('id', '=', reviewId)
      .where('status', '=', 'published')
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return row?.subject_organization_id ?? null;
  }
}
