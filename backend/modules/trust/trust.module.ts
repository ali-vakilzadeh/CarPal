// trust module (41 §2.1 M8; 40 §15, public.org_reviews; W3, W4). Three Nest
// modules share this folder:
//   TrustModule        (global, every deployable) TrustRead (ratings, badges
//                      and review state for profiles, search and
//                      appointments), the W3 scorer and W4 workflow with their
//                      event consumers (run by the worker's consumer host),
//                      invitations, and the registrations: media attachment
//                      target 'review' and the provider insight figures.
//   TrustApiModule     §15 operations and public.org_reviews on the api host.
//   TrustWorkerModule  W15 rules: Path 2 deadline, invitation reminders and
//                      expiry, the nightly trust sweep (hosted by the worker).
import { Global, Injectable, Module, Optional, type OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import { AttachmentTargets } from '#modules/media/interface/media.js';
import { OrganizationExtensions } from '#modules/organization/interface/extensions.js';
import { Invitations } from './application/invitation-ops.js';
import { HelpfulCountConsumer, ReviewWorkflow, ReviewWorkflowConsumer, TrustScoringConsumer } from './application/review-workflow.js';
import { TrustScorer } from './application/trust-scorer.js';
import { DbTrustRead } from './infrastructure/trust-read.js';
import { ratingString, TrustRead } from './interface/trust.js';

const inPeriod = (period: { from: string; to: string }) => ({
  from: new Date(`${period.from}T00:00:00Z`),
  to: new Date(Date.parse(`${period.to}T00:00:00Z`) + 86_400_000),
});

@Injectable()
export class TrustRegistrations implements OnModuleInit {
  constructor(
    @Optional() private readonly targets?: AttachmentTargets,
    @Optional() private readonly ext?: OrganizationExtensions,
  ) {}

  onModuleInit(): void {
    // Review photos and evidence belong to the author (40 reviews.create media_ids, reviews.evidence_add).
    this.targets?.register('review', async (scope, id) => {
      const r = await scope.db
        .selectFrom('trust.reviews')
        .select('author_user_id')
        .where('id', '=', id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      return r ? { owner: { type: 'user', id: r.author_user_id }, groups: [] } : null;
    });
    // 40 ProviderInsights figures from published reviews of the period (subject context: RLS subject_read).
    this.ext?.registerInsight('provider.overall_rating', async (scope, orgId, period) => {
      const p = inPeriod(period);
      const { rows } = await sql<{ avg: string | null }>`
        SELECT avg(overall_rating) AS avg FROM trust.reviews
         WHERE subject_organization_id = ${orgId}::uuid AND subject_type = 'provider' AND status = 'published'
           AND published_at >= ${p.from} AND published_at < ${p.to} AND deleted_at IS NULL`.execute(scope.db);
      return rows[0]?.avg === null || rows[0]?.avg === undefined ? null : ratingString(Number(rows[0].avg));
    });
    this.ext?.registerInsight('provider.review_count', async (scope, orgId, period) => {
      const p = inPeriod(period);
      const { rows } = await sql<{ n: string }>`
        SELECT count(*) AS n FROM trust.reviews
         WHERE subject_organization_id = ${orgId}::uuid AND subject_type = 'provider' AND status = 'published'
           AND published_at >= ${p.from} AND published_at < ${p.to} AND deleted_at IS NULL`.execute(scope.db);
      return Number(rows[0]?.n ?? 0);
    });
    this.ext?.registerInsight('provider.category_ratings', async (scope, orgId, period) => {
      const p = inPeriod(period);
      const { rows } = await sql<{ node_id: string; avg: string; n: string }>`
        SELECT service_system_node_id AS node_id, avg(overall_rating) AS avg, count(*) AS n FROM trust.reviews
         WHERE subject_organization_id = ${orgId}::uuid AND subject_type = 'provider' AND status = 'published'
           AND service_system_node_id IS NOT NULL
           AND published_at >= ${p.from} AND published_at < ${p.to} AND deleted_at IS NULL
         GROUP BY service_system_node_id ORDER BY count(*) DESC, service_system_node_id LIMIT 50`.execute(scope.db);
      return rows.map((r) => ({ node_id: r.node_id, rating: ratingString(Number(r.avg))!, count: Number(r.n) }));
    });
  }
}

@Global()
@Module({
  providers: [
    { provide: TrustRead, useClass: DbTrustRead },
    TrustScorer,
    Invitations,
    ReviewWorkflow,
    ReviewWorkflowConsumer,
    TrustScoringConsumer,
    HelpfulCountConsumer,
    TrustRegistrations,
  ],
  exports: [TrustRead, TrustScorer, Invitations, ReviewWorkflow],
})
export class TrustModule {}
