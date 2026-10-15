// Provider and vendor posts (40 §19.2, Should-have, FLAG community.feed.enabled
// on the list and create routes): drafts, edits (a published post goes back
// through moderation), publication with the moderation, consent and media
// checks, removal and the public list. Text is pre-moderated automatically
// (GD-22); showcase and job-completion posts need their portfolio item's
// customer consent (52 Post rule).
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { ApiError, type FieldError } from '#libs/contract/index.js';
import { ACK, created, Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { MediaService } from '#modules/media/interface/media.js';
import { AiReferences } from '#modules/ai-mcp/interface/ai.js';
import { PublicProfiles } from '#modules/organization/interface/public-profiles.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { toPost, type PostRow } from '../api/projections.js';
import { autoModeration, postErrors, type PostFacts, type PostType } from '../domain/rules.js';
import { afterId, checkVersion, CommunityCards, contentChanged, failIf } from './common.js';

type PostWrite = {
  post_type: PostType;
  title?: string;
  body: string;
  content_locale: string;
  portfolio_item_id?: string;
  taxonomy_node_ids?: string[];
  offer_valid_until?: string;
  event_starts_at?: string;
  comments_enabled: boolean;
  ai_caption_insight_id?: string;
  visibility: 'public' | 'unlisted' | 'private';
};

/** The member and the authorized path organization. */
function orgMember(ctx: OperationContext): { userId: string; orgId: string } {
  const org = ctx.access.org;
  if (ctx.principal.kind !== 'user' || !org) throw new ApiError('NOT_FOUND');
  return { userId: ctx.principal.userId, orgId: org.id };
}

@Injectable()
export class PostViews {
  constructor(
    private readonly cards: CommunityCards,
    private readonly media: MediaService,
  ) {}

  /** Posts of members (all statuses, member media views) or of the public (publicly servable media only). */
  async many(scope: TxScope, rows: readonly PostRow[], locale: 'en' | 'fa', audience: 'member' | 'public') {
    const orgs = await this.cards.orgs(
      scope,
      rows.map((r) => r.author_organization_id),
      locale,
      audience === 'member',
    );
    const ids = rows.map((r) => r.id);
    const media =
      audience === 'member'
        ? await this.media.attachmentViews(scope, 'post', ids)
        : await this.media.publicAttachmentViews(scope, 'post', ids);
    return rows
      .filter((r) => orgs.has(r.author_organization_id))
      .map((r) => toPost(r, { org: orgs.get(r.author_organization_id)!, media: media.get(r.id) ?? [] }));
  }
}

@Injectable()
export class PostRules {
  constructor(
    private readonly profiles: PublicProfiles,
    private readonly taxonomy: TaxonomyResolver,
    private readonly ai: AiReferences,
  ) {}

  /** References and conditionals of the merged post. */
  async check(
    scope: TxScope,
    orgId: string,
    p: PostFacts & { taxonomy_node_ids?: string[]; ai_caption_insight_id?: string },
  ): Promise<void> {
    const errors: FieldError[] = postErrors(p) as FieldError[];
    // An AI showcase text of this organization (ai.showcase_compose, S9); saving the post is the human decision and the
    // post still goes through moderation (SEC-AI-3). A staff member's draft waits for its approval request (53 §14.2).
    if (p.ai_caption_insight_id) {
      const i = await this.ai.usable(scope, p.ai_caption_insight_id, { types: ['showcase_caption', 'showcase_draft'] });
      if (!i || i.organizationId !== orgId) errors.push({ pointer: '/ai_caption_insight_id', code: 'reference_not_found' });
      else if (await this.ai.awaitingApproval(scope, i.id)) throw new ApiError('INVALID_TRANSITION', { detail: 'approval_pending' });
      else await this.ai.approveUse(scope, i.id);
    }
    if (p.portfolio_item_id) {
      const item = await this.profiles.portfolioItemStatus(scope, p.portfolio_item_id);
      if (!item || item.organizationId !== orgId) errors.push({ pointer: '/portfolio_item_id', code: 'reference_not_found' });
    }
    for (const [i, id] of (p.taxonomy_node_ids ?? []).entries()) {
      const node = await this.taxonomy.get(id);
      if (!node || node.status !== 'active') errors.push({ pointer: `/taxonomy_node_ids/${i}`, code: 'reference_not_found' });
    }
    if (errors.some((e) => e.code === 'reference_not_found')) throw ApiError.validation(errors, 'REFERENCE_NOT_FOUND');
    failIf(errors);
  }
}

async function loadPost(scope: TxScope, orgId: string, id: string, lock = false): Promise<PostRow> {
  const q = scope.db
    .selectFrom('community.posts')
    .selectAll()
    .where('id', '=', id)
    .where('author_organization_id', '=', orgId)
    .where('status', '<>', 'removed')
    .where('deleted_at', 'is', null);
  const row = await (lock ? q.forUpdate() : q).executeTakeFirst();
  if (!row) throw new ApiError('NOT_FOUND');
  return row;
}

const columns = (b: Partial<PostWrite>) => {
  const out: Record<string, unknown> = {};
  for (const k of [
    'post_type',
    'title',
    'body',
    'content_locale',
    'portfolio_item_id',
    'offer_valid_until',
    'event_starts_at',
    'comments_enabled',
    'visibility',
  ] as const)
    if (b[k] !== undefined) out[k] = b[k];
  if (b.taxonomy_node_ids !== undefined) out.taxonomy_node_ids = b.taxonomy_node_ids;
  return out;
};

@Injectable()
@Operation('posts.org_list')
export class PostsOrgListHandler implements OperationHandler {
  constructor(private readonly views: PostViews) {}

  async handle(ctx: OperationContext<undefined, { status?: string; limit: number }>): Promise<OperationResult> {
    const m = orgMember(ctx);
    const limit = ctx.query.limit;
    const body = await ctx.tx(
      async (scope) => {
        let q = scope.db
          .selectFrom('community.posts')
          .selectAll()
          .where('author_organization_id', '=', m.orgId)
          .where('deleted_at', 'is', null);
        q = ctx.query.status ? q.where('status', '=', ctx.query.status) : q.where('status', '<>', 'removed');
        const after = afterId(ctx);
        if (after) q = q.where('id', '<', after);
        const rows = await q
          .orderBy('id', 'desc')
          .limit(limit + 1)
          .execute();
        const page = rows.slice(0, limit);
        return ctx.page(await this.views.many(scope, page, ctx.locale, 'member'), rows.length > limit ? { id: page.at(-1)!.id } : null);
      },
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('posts.create')
export class PostsCreateHandler implements OperationHandler {
  constructor(
    private readonly views: PostViews,
    private readonly rules: PostRules,
  ) {}

  async handle(ctx: OperationContext<PostWrite>): Promise<OperationResult> {
    const m = orgMember(ctx);
    const b = ctx.body;
    const body = await ctx.tx(async (scope) => {
      await this.rules.check(scope, m.orgId, b);
      const row = await scope.db
        .insertInto('community.posts')
        .values({
          ...columns(b),
          post_type: b.post_type,
          body: b.body,
          content_locale: b.content_locale,
          author_organization_id: m.orgId,
          author_user_id: m.userId,
          moderation_status: autoModeration(b.title, b.body),
          status: 'draft',
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return (await this.views.many(scope, [row], ctx.locale, 'member'))[0]!;
    });
    return created(body, `/v1/orgs/${m.orgId}/posts/${body.id}`);
  }
}

@Injectable()
@Operation('posts.update')
export class PostsUpdateHandler implements OperationHandler {
  constructor(
    private readonly views: PostViews,
    private readonly rules: PostRules,
  ) {}

  async handle(ctx: OperationContext<Partial<PostWrite>>): Promise<OperationResult> {
    const m = orgMember(ctx);
    const b = ctx.body;
    const body = await ctx.tx(async (scope) => {
      const post = await loadPost(scope, m.orgId, ctx.params.post_id!, true);
      checkVersion(post.version, ctx.ifMatch);
      const merged = {
        post_type: (b.post_type ?? post.post_type) as PostType,
        body: b.body ?? post.body,
        portfolio_item_id: b.portfolio_item_id ?? post.portfolio_item_id,
        offer_valid_until: b.offer_valid_until ?? post.offer_valid_until,
        event_starts_at: b.event_starts_at ?? (post.event_starts_at ? new Date(post.event_starts_at).toISOString() : null),
        ...(b.taxonomy_node_ids ? { taxonomy_node_ids: b.taxonomy_node_ids } : {}),
        ...(b.ai_caption_insight_id ? { ai_caption_insight_id: b.ai_caption_insight_id } : {}),
      };
      await this.rules.check(scope, m.orgId, merged);
      // Every edit is moderated again; a published post whose text now waits for review leaves publication.
      const moderation = autoModeration(b.title ?? post.title, merged.body);
      const unpublish = post.status === 'published' && moderation !== 'approved';
      const row = await scope.db
        .updateTable('community.posts')
        .set({ ...columns(b), moderation_status: moderation, ...(unpublish ? { status: 'draft' } : {}) })
        .where('id', '=', post.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (post.status === 'published') await contentChanged(scope, 'post', post.id);
      return (await this.views.many(scope, [row], ctx.locale, 'member'))[0];
    });
    return { body };
  }
}

@Injectable()
@Operation('posts.publish')
export class PostsPublishHandler implements OperationHandler {
  constructor(
    private readonly views: PostViews,
    private readonly profiles: PublicProfiles,
    private readonly media: MediaService,
  ) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const m = orgMember(ctx);
    const body = await ctx.tx(async (scope) => {
      const post = await loadPost(scope, m.orgId, ctx.params.post_id!, true);
      if (post.status === 'hidden') throw new ApiError('INVALID_TRANSITION', { detail: 'hidden' });
      let row = post;
      if (post.status !== 'published') {
        if (post.moderation_status !== 'approved') throw new ApiError('INVALID_TRANSITION', { detail: 'moderation_pending' });
        if (post.portfolio_item_id) {
          const item = await this.profiles.portfolioItemStatus(scope, post.portfolio_item_id);
          if (!item || !['not_required', 'granted'].includes(item.customerConsentStatus))
            throw new ApiError('CONSENT_REQUIRED', { detail: 'showcase_publishing', extensions: { consent_type: 'showcase_publishing' } });
        }
        const assets = await this.media.attachedAssets(scope, 'post', post.id);
        if (assets.some((a) => !a.ready)) throw new ApiError('MEDIA_NOT_READY');
        row = await scope.db
          .updateTable('community.posts')
          .set({ status: 'published', published_at: sql<Date>`now()` })
          .where('id', '=', post.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await contentChanged(scope, 'post', post.id);
        // Followers are told (notification W5); not in 40 Appendix A (DI-45).
        if (row.visibility === 'public')
          await publishEvent(scope, {
            type: 'community.post.published',
            aggregateType: 'post',
            aggregateId: post.id,
            payload: { organization_id: m.orgId, post_type: post.post_type },
          });
      }
      return (await this.views.many(scope, [row], ctx.locale, 'member'))[0];
    });
    return { body };
  }
}

@Injectable()
@Operation('posts.delete')
export class PostsDeleteHandler implements OperationHandler {
  async handle(ctx: OperationContext): Promise<OperationResult> {
    const m = orgMember(ctx);
    await ctx.tx(async (scope) => {
      const post = await loadPost(scope, m.orgId, ctx.params.post_id!, true);
      await scope.db.updateTable('community.posts').set({ status: 'removed' }).where('id', '=', post.id).execute();
      if (post.status === 'published') await contentChanged(scope, 'post', post.id);
    });
    return { body: ACK };
  }
}

@Injectable()
@Operation('posts.public_list')
export class PostsPublicListHandler implements OperationHandler {
  constructor(
    private readonly views: PostViews,
    private readonly cards: CommunityCards,
  ) {}

  async handle(ctx: OperationContext<undefined, { post_type?: string; limit: number }>): Promise<OperationResult> {
    const orgId = ctx.params.org_id!;
    const limit = ctx.query.limit;
    const pos = ctx.cursor as { p: string; id: string } | undefined;
    const body = await ctx.tx(
      async (scope) => {
        if (!(await this.cards.orgs(scope, [orgId], ctx.locale)).has(orgId)) throw new ApiError('NOT_FOUND');
        let q = scope.db
          .selectFrom('community.posts')
          .selectAll()
          .where('author_organization_id', '=', orgId)
          .where('status', '=', 'published')
          .where('visibility', '=', 'public')
          .where('deleted_at', 'is', null);
        if (ctx.query.post_type) q = q.where('post_type', '=', ctx.query.post_type);
        if (pos) q = q.where(sql<boolean>`(published_at, id) < (${new Date(pos.p)}, ${pos.id}::uuid)`);
        const rows = await q
          .orderBy('published_at', 'desc')
          .orderBy('id', 'desc')
          .limit(limit + 1)
          .execute();
        const page = rows.slice(0, limit);
        const last = page.at(-1);
        return ctx.page(
          await this.views.many(scope, page, ctx.locale, 'public'),
          rows.length > limit && last ? { p: new Date(last.published_at!).toISOString(), id: last.id } : null,
        );
      },
      { readOnly: true },
    );
    return { body, cache: { public: 60 } };
  }
}
