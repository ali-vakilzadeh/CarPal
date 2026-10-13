// Helpers shared by the trust use cases (40 §15): callers, keyset paging,
// and the review views (public, organization inbox, author) built from the
// same allowlist projections. Reviews show their author by display name and
// the vehicle as taxonomy only (SEC-OUT-3).
import { Injectable } from '@nestjs/common';
import { ApiError, type FieldError } from '#libs/contract/index.js';
import type { OperationContext } from '#libs/http-pipeline/index.js';
import type { Locale } from '#libs/i18n/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { authorDisplayName, UserCards } from '#modules/identity/interface/identity.js';
import { MediaService, type MediaAttachmentView } from '#modules/media/interface/media.js';
import { OrgCards, toOrgSummary } from '#modules/organization/interface/org-cards.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { VehicleCards } from '#modules/vehicle/interface/vehicles.js';
import { toPublicReview, toResponse, toReview, type ResponseRow, type ReviewRow } from '../api/projections.js';

export interface Caller {
  userId: string;
}

export function signedIn(ctx: OperationContext): Caller {
  if (ctx.principal.kind !== 'user') throw new ApiError('NOT_FOUND');
  return { userId: ctx.principal.userId };
}

export interface Member {
  userId: string;
  orgId: string;
  role: string;
}

export function member(ctx: OperationContext): Member {
  const org = ctx.access.org;
  if (ctx.principal.kind !== 'user' || !org) throw new ApiError('NOT_FOUND');
  return { userId: ctx.principal.userId, orgId: org.id, role: org.role };
}

export function failIf(errors: FieldError[]): void {
  if (errors.length) throw ApiError.validation(errors);
}

export const notFoundAt = (pointer: string): ApiError =>
  ApiError.validation([{ pointer, code: 'reference_not_found' }], 'REFERENCE_NOT_FOUND');

type Position = { id?: string } | undefined;
export const afterId = (ctx: OperationContext): string | undefined => (ctx.cursor as Position)?.id;

export function pageOf<R extends { id: string }, T>(ctx: OperationContext<unknown, { limit: number }>, rows: R[], items: T[]) {
  const limit = ctx.query.limit;
  return ctx.page(items.slice(0, limit), rows.length > limit ? { id: rows[limit - 1]!.id } : null);
}

/** Organization summary (40 OrgSummary) of review subjects and invitation senders. */
@Injectable()
export class Subjects {
  constructor(private readonly orgs: OrgCards) {}

  async summaries(scope: TxScope, ids: readonly string[]) {
    const cards = await this.orgs.cards(scope, ids);
    return new Map([...cards].map(([id, c]) => [id, toOrgSummary(c)]));
  }
}

@Injectable()
export class ReviewViews {
  constructor(
    private readonly users: UserCards,
    private readonly vehicles: VehicleCards,
    private readonly taxonomy: TaxonomyResolver,
    private readonly media: MediaService,
  ) {}

  async #parts(scope: TxScope, rows: readonly ReviewRow[]) {
    const ids = rows.map((r) => r.id);
    if (ids.length === 0) return { subs: [], tags: [], responses: [] };
    const [subs, tags, responses] = await Promise.all([
      scope.db
        .selectFrom('trust.review_sub_ratings')
        .select(['review_id', 'dimension', 'rating'])
        .where('review_id', 'in', ids)
        .where('deleted_at', 'is', null)
        .orderBy('dimension')
        .execute(),
      scope.db
        .selectFrom('trust.review_tags')
        .select(['review_id', 'taxonomy_node_id', 'confirmed_by_author'])
        .where('review_id', 'in', ids)
        .where('deleted_at', 'is', null)
        .execute(),
      scope.db
        .selectFrom('trust.review_responses')
        .selectAll()
        .where('review_id', 'in', ids)
        .where('status', 'in', ['draft', 'published'])
        .where('deleted_at', 'is', null)
        .execute(),
    ]);
    return { subs, tags, responses };
  }

  /** Responses with the responding member's display name. */
  async responses(scope: TxScope, rows: readonly ResponseRow[], locale: Locale) {
    const users = await this.users.cards(
      scope,
      rows.map((r) => r.responded_by_user_id),
    );
    return new Map(rows.map((r) => [r.id, toResponse(r, authorDisplayName(users.get(r.responded_by_user_id), locale))]));
  }

  /** 40 PublicReview views (published responses only); `media` decides which attachments are shown. */
  async publicViews(scope: TxScope, rows: readonly ReviewRow[], locale: Locale, media: 'public' | 'owner' = 'public') {
    const { subs, tags, responses } = await this.#parts(scope, rows);
    const ids = rows.map((r) => r.id);
    const [mediaViews, users, vehicles] = await Promise.all([
      media === 'public' ? this.media.publicAttachmentViews(scope, 'review', ids) : this.media.attachmentViews(scope, 'review', ids),
      this.users.cards(
        scope,
        rows.map((r) => r.author_user_id),
      ),
      this.vehicles.cards(
        scope,
        rows.map((r) => r.context_vehicle_id).filter((x): x is string => !!x),
      ),
    ]);
    const labels = await this.taxonomy.labels(
      [
        ...rows.flatMap((r) => [r.service_system_node_id, r.service_task_node_id]),
        ...[...vehicles.values()].flatMap((v) => [v.brandNodeId, v.modelNodeId, v.seriesNodeId]),
        ...tags.map((t) => t.taxonomy_node_id),
      ].filter((x): x is string => !!x),
      locale,
    );
    return new Map(
      rows.map((r) => [
        r.id,
        toPublicReview(r, {
          locale,
          labels,
          author: users.get(r.author_user_id),
          vehicle: r.context_vehicle_id ? vehicles.get(r.context_vehicle_id) : undefined,
          subRatings: subs.filter((x) => x.review_id === r.id),
          tags: tags.filter((x) => x.review_id === r.id && x.confirmed_by_author).map((x) => x.taxonomy_node_id),
          response: responses.find((x) => x.review_id === r.id && x.status === 'published'),
          media: ((mediaViews.get(r.id) ?? []) as MediaAttachmentView[]).filter((m) => m.role !== 'evidence'),
        }),
      ]),
    );
  }

  /** Response drafts of reviews (the organization's inbox). */
  async drafts(scope: TxScope, rows: readonly ReviewRow[], locale: Locale) {
    const { responses } = await this.#parts(scope, rows);
    const drafts = responses.filter((r) => r.status === 'draft');
    const views = await this.responses(scope, drafts, locale);
    return new Map(drafts.map((d) => [d.review_id, views.get(d.id)!]));
  }

  /** 40 Review: the author's view with all their tags and photos (evidence stays with CarPal staff). */
  async authorViews(scope: TxScope, rows: readonly ReviewRow[], locale: Locale, evidenceOpen: Set<string>) {
    const { subs, tags, responses } = await this.#parts(scope, rows);
    const media = await this.media.attachmentViews(
      scope,
      'review',
      rows.map((r) => r.id),
    );
    const published = responses.filter((r) => r.status === 'published');
    const views = await this.responses(scope, published, locale);
    return rows.map((r) =>
      toReview(r, {
        subRatings: subs.filter((x) => x.review_id === r.id),
        tagIds: tags.filter((x) => x.review_id === r.id).map((x) => x.taxonomy_node_id),
        media: (media.get(r.id) ?? []).filter((m) => m.role !== 'evidence'),
        canAddEvidence: evidenceOpen.has(r.id),
        response: (() => {
          const p = published.find((x) => x.review_id === r.id);
          return p ? views.get(p.id)! : null;
        })(),
      }),
    );
  }
}
