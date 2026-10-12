// Helpers shared by the community use cases (40 §19): the signed-in user,
// public organization cards (with a member fallback for organizations whose
// profile is not published yet), author cards, keyset paging and the
// community.content.changed event of the search indexer.
import { Injectable } from '@nestjs/common';
import { ApiError, type FieldError } from '#libs/contract/index.js';
import type { OperationContext } from '#libs/http-pipeline/index.js';
import type { Locale } from '#libs/i18n/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { authorDisplayName, UserCards } from '#modules/identity/interface/identity.js';
import { OrgCards } from '#modules/organization/interface/org-cards.js';
import { PublicOrgCards, type PublicOrgCard } from '#modules/organization/interface/public-profiles.js';
import type { CommunityEntity } from '../interface/community.js';

/** The signed-in user (USR operations). */
export function userId(ctx: OperationContext): string {
  if (ctx.principal.kind !== 'user') throw new ApiError('UNAUTHENTICATED');
  return ctx.principal.userId;
}

export function checkVersion(version: number, ifMatch: number | undefined): void {
  if (ifMatch === undefined) throw new ApiError('PRECONDITION_REQUIRED');
  if (version !== ifMatch) throw new ApiError('VERSION_MISMATCH');
}

export function failIf(errors: FieldError[]): void {
  if (errors.length) throw ApiError.validation(errors);
}

type Position = { id?: string } | undefined;
export const afterId = (ctx: OperationContext): string | undefined => (ctx.cursor as Position)?.id;

/** Page<T> from `limit + 1` rows ordered by id. */
export function pageOf<R extends { id: string }, T>(ctx: OperationContext, rows: R[], limit: number, map: (r: R) => T) {
  const page = rows.slice(0, limit);
  return ctx.page(page.map(map), rows.length > limit ? { id: page.at(-1)!.id } : null);
}

export const json = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));

/**
 * Public content was published, changed or removed (search indexer W2).
 * Not in 40 Appendix A (DI-45); qna.question.created is published as well
 * for new questions.
 */
export async function contentChanged(scope: TxScope, type: CommunityEntity, id: string): Promise<void> {
  await publishEvent(scope, {
    type: 'community.content.changed',
    aggregateType: type,
    aggregateId: id,
    payload: { entity_type: type, entity_id: id },
  });
}

@Injectable()
export class CommunityCards {
  constructor(
    private readonly cards: PublicOrgCards,
    private readonly orgCards: OrgCards,
    private readonly users: UserCards,
  ) {}

  /** Public cards; with `memberFallback`, organizations without a published profile get a minimal card (their own members' views). */
  async orgs(scope: TxScope, ids: readonly string[], locale: Locale, memberFallback = false): Promise<Map<string, PublicOrgCard>> {
    const unique = [...new Set(ids)];
    const out = await this.cards.cards(scope, unique, locale);
    const missing = unique.filter((id) => !out.has(id));
    if (memberFallback && missing.length)
      for (const c of (await this.orgCards.cards(scope, missing)).values())
        out.set(c.id, {
          id: c.id,
          slug: c.slug,
          name: c.name,
          organization_type: c.organizationType,
          roles: [],
          verified: c.verificationStatus === 'verified',
          overall_rating: null,
          review_count: 0,
          top_badges: [],
          price_tier: null,
          measured_response_time_minutes: null,
          logo_url: c.logoUrl,
          portfolio_thumbnail_url: null,
        });
    return out;
  }

  /** Public author cards (40 author: display name only, SEC-OUT-3). */
  async authors(scope: TxScope, ids: readonly string[], locale: Locale): Promise<Map<string, { display_name: string; avatar_url: null }>> {
    const cards = await this.users.cards(scope, [...new Set(ids)]);
    return new Map([...new Set(ids)].map((id) => [id, { display_name: authorDisplayName(cards.get(id), locale), avatar_url: null }]));
  }
}
