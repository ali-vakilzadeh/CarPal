// public.org_reviews (40 §14.3): published reviews of a published provider or
// vendor, both confirmation paths with their labels and no "unverified"
// section. Reads under the public RLS policies (published reviews, published
// responses, publicly servable media); the author is a display name only and
// the vehicle is shown as taxonomy, never the vehicle record (SEC-OUT-3).
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { ApiError } from '#libs/contract/index.js';
import { Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import { UserCards } from '#modules/identity/interface/identity.js';
import { MediaService } from '#modules/media/interface/media.js';
import { PublicProfiles } from '#modules/organization/interface/public-profiles.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { VehicleCards } from '#modules/vehicle/interface/vehicles.js';
import { toPublicReview, type ReviewRow } from '../api/projections.js';

type Query = {
  path?: 'visit_based' | 'approval_based';
  rating?: number;
  service_system_node_id?: string;
  sort: 'recent' | 'helpful';
  limit: number;
};
/** Keyset: (published_at, id) for recent, (helpful_count, id) for helpful; both descending. */
type Position = { k: string | number; id: string } | undefined;

@Injectable()
@Operation('public.org_reviews')
export class PublicOrgReviewsHandler implements OperationHandler {
  constructor(
    private readonly profiles: PublicProfiles,
    private readonly users: UserCards,
    private readonly vehicles: VehicleCards,
    private readonly taxonomy: TaxonomyResolver,
    private readonly media: MediaService,
  ) {}

  async handle(ctx: OperationContext<undefined, Query>): Promise<OperationResult> {
    const orgId = ctx.params.org_id!;
    const q = ctx.query;
    const pos = ctx.cursor as Position;
    const body = await ctx.tx(
      async (scope) => {
        if (!(await this.profiles.cards(scope, [orgId])).has(orgId)) throw new ApiError('NOT_FOUND');
        let s = scope.db
          .selectFrom('trust.reviews')
          .selectAll()
          .where('subject_organization_id', '=', orgId)
          .where('status', '=', 'published')
          .where('deleted_at', 'is', null);
        if (q.path) s = s.where('confirmation_path', '=', q.path);
        if (q.rating) s = s.where('overall_rating', '=', q.rating);
        if (q.service_system_node_id) s = s.where('service_system_node_id', '=', q.service_system_node_id);
        if (q.sort === 'helpful') {
          if (pos) s = s.where(sql<boolean>`(helpful_count, id) < (${Number(pos.k)}, ${pos.id}::uuid)`);
          s = s.orderBy('helpful_count', 'desc').orderBy('id', 'desc');
        } else {
          if (pos) s = s.where(sql<boolean>`(published_at, id) < (${new Date(String(pos.k))}, ${pos.id}::uuid)`);
          s = s.orderBy('published_at', 'desc').orderBy('id', 'desc');
        }
        const rows = (await s.limit(q.limit + 1).execute()) as ReviewRow[];
        const page = rows.slice(0, q.limit);
        const ids = page.map((r) => r.id);
        const [subs, tags, responses, media, users, vehicles] = await Promise.all([
          ids.length
            ? scope.db
                .selectFrom('trust.review_sub_ratings')
                .select(['review_id', 'dimension', 'rating'])
                .where('review_id', 'in', ids)
                .where('deleted_at', 'is', null)
                .orderBy('dimension')
                .execute()
            : [],
          ids.length
            ? scope.db
                .selectFrom('trust.review_tags')
                .select(['review_id', 'taxonomy_node_id'])
                .where('review_id', 'in', ids)
                .where('confirmed_by_author', '=', true)
                .where('deleted_at', 'is', null)
                .execute()
            : [],
          ids.length
            ? scope.db
                .selectFrom('trust.review_responses')
                .select(['review_id', 'response_text', 'content_locale', 'published_at'])
                .where('review_id', 'in', ids)
                .where('status', '=', 'published')
                .where('deleted_at', 'is', null)
                .execute()
            : [],
          this.media.publicAttachmentViews(scope, 'review', ids),
          this.users.cards(
            scope,
            page.map((r) => r.author_user_id),
          ),
          this.vehicles.cards(
            scope,
            page.map((r) => r.context_vehicle_id).filter((x): x is string => !!x),
          ),
        ]);
        const labels = await this.taxonomy.labels(
          [
            ...page.flatMap((r) => [r.service_system_node_id, r.service_task_node_id]),
            ...[...vehicles.values()].flatMap((v) => [v.brandNodeId, v.modelNodeId, v.seriesNodeId]),
            ...tags.map((t) => t.taxonomy_node_id),
          ].filter((x): x is string => !!x),
          ctx.locale,
        );
        const items = page.map((r) =>
          toPublicReview(r, {
            locale: ctx.locale,
            labels,
            author: users.get(r.author_user_id),
            vehicle: r.context_vehicle_id ? vehicles.get(r.context_vehicle_id) : undefined,
            subRatings: subs.filter((x) => x.review_id === r.id),
            tags: tags.filter((x) => x.review_id === r.id).map((x) => x.taxonomy_node_id),
            response: responses.find((x) => x.review_id === r.id),
            media: media.get(r.id) ?? [],
          }),
        );
        const last = page.at(-1);
        return ctx.page(
          items,
          rows.length > q.limit && last
            ? { k: q.sort === 'helpful' ? last.helpful_count : new Date(last.published_at!).toISOString(), id: last.id }
            : null,
        );
      },
      { readOnly: true },
    );
    return { body, cache: { public: 60 } };
  }
}
