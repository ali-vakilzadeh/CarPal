// Comments and reactions (40 §19.2). Comments (FLAG community.comments.enabled)
// go on public posts that allow them, published showcases, and questions and
// answers that are open; authors need a verified contact and text is
// pre-moderated (GD-22). Reactions: one per user, target and type (unique),
// helpful on reviews, answers and posts, like on posts, comments and
// portfolio items; members of the subject organization do not count
// (SEC-BF-9, community.refresh_reaction_count).
import { Injectable, Optional } from '@nestjs/common';
import { sql } from 'kysely';
import { ApiError } from '#libs/contract/index.js';
import { ACK, created, Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { AccountFacts } from '#modules/identity/interface/identity.js';
import { PublicProfiles } from '#modules/organization/interface/public-profiles.js';
import { TrustRead } from '#modules/trust/interface/trust.js';
import { toComment } from '../api/projections.js';
import { autoModeration, reactionAllowed, type ReactionTarget } from '../domain/rules.js';
import { CommunityCards, userId } from './common.js';

export interface TargetFacts {
  /** Organization whose members' reactions do not count (post author, provider, review subject, answering business). */
  subjectOrg: string | null;
  commentsAllowed: boolean;
}

/** Public targets of comments and reactions, in the caller's context. */
@Injectable()
export class CommunityTargets {
  constructor(
    private readonly profiles: PublicProfiles,
    @Optional() private readonly trust?: TrustRead,
  ) {}

  async resolve(scope: TxScope, type: string, id: string, locale: 'en' | 'fa'): Promise<TargetFacts | null> {
    const db = scope.db;
    switch (type) {
      case 'post': {
        const p = await db
          .selectFrom('community.posts')
          .select(['author_organization_id', 'comments_enabled'])
          .where('id', '=', id)
          .where('status', '=', 'published')
          .where('visibility', '=', 'public')
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        return p ? { subjectOrg: p.author_organization_id, commentsAllowed: p.comments_enabled } : null;
      }
      case 'portfolio_item': {
        const item = (await this.profiles.portfolioItems(scope, [id], locale)).get(id);
        return item ? { subjectOrg: item.organization_id, commentsAllowed: true } : null;
      }
      case 'question': {
        const q = await db
          .selectFrom('community.questions')
          .select(['status'])
          .where('id', '=', id)
          .where('moderation_status', '=', 'approved')
          .where('status', '<>', 'hidden')
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        return q ? { subjectOrg: null, commentsAllowed: q.status !== 'closed' } : null;
      }
      case 'answer': {
        const a = await db
          .selectFrom('community.answers as a')
          .innerJoin('community.questions as q', 'q.id', 'a.question_id')
          .select(['a.author_organization_id', 'q.status'])
          .where('a.id', '=', id)
          .where('a.moderation_status', '=', 'approved')
          .where('a.status', '=', 'active')
          .where('a.deleted_at', 'is', null)
          .executeTakeFirst();
        return a ? { subjectOrg: a.author_organization_id, commentsAllowed: a.status !== 'closed' } : null;
      }
      case 'comment': {
        const c = await db
          .selectFrom('community.comments')
          .select('id')
          .where('id', '=', id)
          .where('status', '=', 'active')
          .where('moderation_status', '=', 'approved')
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        return c ? { subjectOrg: null, commentsAllowed: false } : null;
      }
      case 'review': {
        const org = this.trust ? await this.trust.publishedReviewSubject(scope, id) : null;
        return org ? { subjectOrg: org, commentsAllowed: false } : null;
      }
      default:
        return null;
    }
  }
}

type CommentQuery = { target_type: string; target_id: string; limit: number };

@Injectable()
@Operation('comments.list')
export class CommentsListHandler implements OperationHandler {
  constructor(
    private readonly targets: CommunityTargets,
    private readonly cards: CommunityCards,
  ) {}

  async handle(ctx: OperationContext<undefined, CommentQuery>): Promise<OperationResult> {
    const q = ctx.query;
    const me = ctx.principal.kind === 'user' ? ctx.principal.userId : null;
    const after = (ctx.cursor as { id?: string } | undefined)?.id;
    const body = await ctx.tx(
      async (scope) => {
        if (!(await this.targets.resolve(scope, q.target_type, q.target_id, ctx.locale))) throw new ApiError('NOT_FOUND');
        let s = scope.db
          .selectFrom('community.comments')
          .selectAll()
          .where('target_type', '=', q.target_type)
          .where('target_id', '=', q.target_id)
          .where('deleted_at', 'is', null)
          // Others see approved, active comments; authors also see their own while they wait for moderation.
          .where((eb) =>
            eb.or([
              eb.and([eb('status', '=', 'active'), eb('moderation_status', '=', 'approved')]),
              ...(me ? [eb.and([eb('author_user_id', '=', me), eb('status', '<>', 'removed')])] : []),
            ]),
          );
        if (after) s = s.where('id', '>', after);
        const rows = await s
          .orderBy('id')
          .limit(q.limit + 1)
          .execute();
        const page = rows.slice(0, q.limit);
        const authors = await this.cards.authors(
          scope,
          page.map((r) => r.author_user_id),
          ctx.locale,
        );
        return ctx.page(
          page.map((r) => toComment(r, authors.get(r.author_user_id)!)),
          rows.length > q.limit ? { id: page.at(-1)!.id } : null,
        );
      },
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('comments.create')
export class CommentsCreateHandler implements OperationHandler {
  constructor(
    private readonly targets: CommunityTargets,
    private readonly cards: CommunityCards,
    private readonly facts: AccountFacts,
  ) {}

  async handle(
    ctx: OperationContext<{ target: { type: string; id: string }; body: string; content_locale: string }>,
  ): Promise<OperationResult> {
    const me = userId(ctx);
    const b = ctx.body;
    const body = await ctx.tx(async (scope) => {
      if (!(await this.facts.hasVerifiedContact(scope, me))) throw new ApiError('VERIFIED_CONTACT_REQUIRED');
      const target = await this.targets.resolve(scope, b.target.type, b.target.id, ctx.locale);
      if (!target) throw ApiError.validation([{ pointer: '/target/id', code: 'reference_not_found' }], 'REFERENCE_NOT_FOUND');
      if (!target.commentsAllowed) throw new ApiError('INVALID_TRANSITION', { detail: 'comments_disabled' });
      const row = await scope.db
        .insertInto('community.comments')
        .values({
          target_type: b.target.type,
          target_id: b.target.id,
          author_user_id: me,
          body: b.body,
          content_locale: b.content_locale,
          moderation_status: autoModeration(b.body),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const authors = await this.cards.authors(scope, [me], ctx.locale);
      return toComment(row, authors.get(me)!);
    });
    return created(body, `/v1/comments/${body.id}`);
  }
}

@Injectable()
@Operation('comments.delete')
export class CommentsDeleteHandler implements OperationHandler {
  async handle(ctx: OperationContext): Promise<OperationResult> {
    const me = userId(ctx);
    await ctx.tx(async (scope) => {
      const r = await scope.db
        .updateTable('community.comments')
        .set({ status: 'removed' })
        .where('id', '=', ctx.params.comment_id!)
        .where('author_user_id', '=', me)
        .where('status', '<>', 'removed')
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) === 0) throw new ApiError('NOT_FOUND');
    });
    return { body: ACK };
  }
}

type ReactionBody = { target: { type: ReactionTarget; id: string }; reaction_type: 'helpful' | 'like' };

@Injectable()
export class Reactions {
  constructor(private readonly targets: CommunityTargets) {}

  async change(ctx: OperationContext<ReactionBody>, add: boolean): Promise<{ count: number }> {
    const me = userId(ctx);
    const { target, reaction_type: type } = ctx.body;
    if (!reactionAllowed(target.type, type)) throw ApiError.validation([{ pointer: '/reaction_type', code: 'enum' }]);
    return ctx.tx(async (scope) => {
      const facts = await this.targets.resolve(scope, target.type, target.id, ctx.locale);
      if (!facts) throw ApiError.validation([{ pointer: '/target/id', code: 'reference_not_found' }], 'REFERENCE_NOT_FOUND');
      if (add)
        await scope.db
          .insertInto('community.reactions')
          .values({ target_type: target.type, target_id: target.id, user_id: me, reaction_type: type })
          .onConflict((oc) => oc.doNothing())
          .execute();
      else
        await scope.db
          .deleteFrom('community.reactions')
          .where('user_id', '=', me)
          .where('target_type', '=', target.type)
          .where('target_id', '=', target.id)
          .where('reaction_type', '=', type)
          .execute();
      const { rows } = await sql<{ n: number }>`
        SELECT community.refresh_reaction_count(${target.type}, ${target.id}::uuid, ${type}, ${facts.subjectOrg}::uuid) AS n`.execute(
        scope.db,
      );
      const count = Number(rows[0]?.n ?? 0);
      // Counters owned by other modules (portfolio like_count; review helpful_count, S7) follow this event.
      if (target.type === 'portfolio_item' || target.type === 'review')
        await publishEvent(scope, {
          type: 'community.reaction.changed',
          aggregateType: target.type,
          aggregateId: target.id,
          payload: { target_type: target.type, target_id: target.id, reaction_type: type, count },
        });
      return { count };
    });
  }
}

@Injectable()
@Operation('reactions.put')
export class ReactionsPutHandler implements OperationHandler {
  constructor(private readonly reactions: Reactions) {}

  async handle(ctx: OperationContext<ReactionBody>): Promise<OperationResult> {
    return { body: await this.reactions.change(ctx, true) };
  }
}

@Injectable()
@Operation('reactions.delete')
export class ReactionsDeleteHandler implements OperationHandler {
  constructor(private readonly reactions: Reactions) {}

  async handle(ctx: OperationContext<ReactionBody>): Promise<OperationResult> {
    return { body: await this.reactions.change(ctx, false) };
  }
}
