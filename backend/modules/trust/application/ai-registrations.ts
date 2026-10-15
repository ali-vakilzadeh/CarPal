// The trust module's parts of the AI facade (S9; 40 ai.review_response_draft,
// ai.review_insights; W11): a published review about the caller's own
// organization (rating and tag keys; the reviewer is never named), the
// organization's reviews of a period, and the recent review facts W11 checks
// for patterns (system context; a hash of the normalized text, never the text).
import { Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import type { TxScope } from '#libs/tenancy/index.js';
import { AiContextSources } from '#modules/ai-mcp/interface/ai.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';

@Injectable()
export class TrustAiRegistrations implements OnModuleInit {
  constructor(
    private readonly taxonomy: TaxonomyResolver,
    @Optional() private readonly sources?: AiContextSources,
  ) {}

  /** Tag keys (taxonomy slugs) of reviews, by review id. */
  async #tags(scope: TxScope, reviewIds: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (reviewIds.length === 0) return out;
    const rows = await scope.db
      .selectFrom('trust.review_tags')
      .select(['review_id', 'taxonomy_node_id'])
      .where('review_id', 'in', reviewIds)
      .where('confirmed_by_author', '=', true)
      .where('deleted_at', 'is', null)
      .execute();
    for (const r of rows) {
      const slug = (await this.taxonomy.get(r.taxonomy_node_id))?.slug;
      if (slug) out.set(r.review_id, [...(out.get(r.review_id) ?? []), slug]);
    }
    return out;
  }

  onModuleInit(): void {
    this.sources?.register('review.for_response', async (scope, who, args) => {
      if (!who.orgId || typeof args.review_id !== 'string') return null;
      const r = await scope.db
        .selectFrom('trust.reviews')
        .select(['id', 'overall_rating', 'subject_type', 'title'])
        .where('id', '=', args.review_id)
        .where('subject_organization_id', '=', who.orgId)
        .where('status', '=', 'published')
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!r) return null;
      return {
        id: r.id,
        rating: Number(r.overall_rating),
        subject_type: r.subject_type,
        tag_keys: (await this.#tags(scope, [r.id])).get(r.id) ?? [],
      };
    });

    this.sources?.register('review.period', async (scope, who, args) => {
      if (!who.orgId) return null;
      const rows = await scope.db
        .selectFrom('trust.reviews')
        .select(['id', 'overall_rating'])
        .where('subject_organization_id', '=', who.orgId)
        .where('status', '=', 'published')
        .where('published_at', '>=', new Date(`${String(args.from)}T00:00:00Z`))
        .where('published_at', '<', new Date(Date.parse(`${String(args.to)}T00:00:00Z`) + 86_400_000))
        .where('deleted_at', 'is', null)
        .orderBy('published_at', 'desc')
        .limit(500)
        .execute();
      const tags = await this.#tags(
        scope,
        rows.map((r) => r.id),
      );
      return { reviews: rows.map((r) => ({ rating: Number(r.overall_rating), tag_keys: tags.get(r.id) ?? [] })) };
    });

    this.sources?.register('review.pattern_facts', async (scope, who) => {
      if (!who.orgId) return null;
      const { rows } = await sql<{ id: string; created_at: Date; overall_rating: number; text_hash: string | null }>`
        SELECT id, created_at, overall_rating::int AS overall_rating,
               CASE WHEN char_length(btrim(body)) >= 20
                    THEN encode(sha256(convert_to(lower(regexp_replace(btrim(body), '\s+', ' ', 'g')), 'UTF8')), 'hex') END AS text_hash
          FROM trust.reviews
         WHERE subject_organization_id = ${who.orgId}::uuid AND created_at > now() - interval '7 days'
           AND status <> 'removed' AND deleted_at IS NULL
         ORDER BY created_at DESC LIMIT 200`.execute(scope.db);
      return { reviews: rows.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString() })) };
    });
  }
}
