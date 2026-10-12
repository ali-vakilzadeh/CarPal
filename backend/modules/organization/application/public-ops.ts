// Public profile reads of the organization module (40 §14.3): public.org_get
// by slug (SEO pages) and public.org_portfolio. Only organizations with a
// published profile; only approved, evidence-backed capabilities, verified
// certifications, active badges and publicly servable media (PublicProfiles,
// TrustRead). Cacheable for 60 s for anonymous callers (the pipeline answers
// no-store to signed-in callers).
import { Injectable, Optional } from '@nestjs/common';
import { ApiError } from '#libs/contract/index.js';
import { Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import { TrustRead, type RatingSummary } from '#modules/trust/interface/trust.js';
import { PublicOrgCards, PublicProfiles } from '../interface/public-profiles.js';

const EMPTY_SUMMARY: RatingSummary = {
  overall: null,
  count_visit_verified: 0,
  count_approved_without_visit: 0,
  distribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
  sub_ratings: [],
};

@Injectable()
@Operation('public.org_get')
export class PublicOrgGetHandler implements OperationHandler {
  constructor(
    private readonly profiles: PublicProfiles,
    private readonly cards: PublicOrgCards,
    @Optional() private readonly trust?: TrustRead,
  ) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const body = await ctx.tx(
      async (scope) => {
        const id = await this.profiles.idBySlug(scope, ctx.params.slug!);
        const profile = id ? await this.profiles.profile(scope, id, ctx.locale) : null;
        const card = id ? (await this.cards.cards(scope, [id], ctx.locale)).get(id) : undefined;
        if (!id || !profile || !card) throw new ApiError('NOT_FOUND');
        const [summary, badges] = await Promise.all([
          this.trust ? this.trust.ratingSummary(scope, id) : EMPTY_SUMMARY,
          this.trust ? this.trust.badges(scope, [id], ctx.locale) : new Map(),
        ]);
        return {
          ...card,
          description: profile.description,
          website: profile.website,
          contact_channels: profile.contact_channels.slice(0, 10),
          locations: profile.locations,
          rating_summary: summary,
          provider: profile.provider
            ? {
                ...profile.provider,
                badges: ((badges.get(id) ?? []) as { badge_type: string; scope: unknown[]; awarded_at: string }[])
                  .slice(0, 30)
                  .map((b) => ({ badge_type: b.badge_type, scope: b.scope.slice(0, 3), awarded_at: b.awarded_at })),
              }
            : null,
          vendor: profile.vendor,
        };
      },
      { readOnly: true },
    );
    return { body, cache: { public: 60 }, contentLanguage: ctx.locale };
  }
}

type PortfolioQuery = { service_system_node_id?: string; brand_node_id?: string; limit: number };
type Position = { p: string; id: string } | undefined;

@Injectable()
@Operation('public.org_portfolio')
export class PublicOrgPortfolioHandler implements OperationHandler {
  constructor(
    private readonly profiles: PublicProfiles,
    private readonly cards: PublicOrgCards,
  ) {}

  async handle(ctx: OperationContext<undefined, PortfolioQuery>): Promise<OperationResult> {
    const orgId = ctx.params.org_id!;
    const q = ctx.query;
    const pos = ctx.cursor as Position;
    const body = await ctx.tx(
      async (scope) => {
        const card = (await this.cards.cards(scope, [orgId], ctx.locale)).get(orgId);
        if (!card || !card.roles.includes('provider')) throw new ApiError('NOT_FOUND');
        const items = await this.profiles.portfolio(
          scope,
          orgId,
          {
            ...(q.service_system_node_id ? { service_system_node_id: q.service_system_node_id } : {}),
            ...(q.brand_node_id ? { brand_node_id: q.brand_node_id } : {}),
            ...(pos ? { after: { published_at: pos.p, id: pos.id } } : {}),
            limit: q.limit + 1,
          },
          ctx.locale,
        );
        const page = items.slice(0, q.limit);
        const last = page.at(-1);
        return ctx.page(
          page.map(({ organization_id: _o, ...p }) => ({ ...p, organization: card })),
          items.length > q.limit && last ? { p: last.published_at, id: last.id } : null,
        );
      },
      { readOnly: true },
    );
    return { body, cache: { public: 60 } };
  }
}
