// Follows, favourites and showcases (40 §19.2, Must-have): one active follow
// and one active favourite per user and organization (partial unique
// indexes); only organizations with a published provider or vendor profile
// can be followed or saved, and lists show only those that still are.
// Favourites are a user-preference input to matching (54 §5.1).
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { ApiError } from '#libs/contract/index.js';
import { registerConstraintErrors } from '#libs/db/index.js';
import { ACK, iso, Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import { PublicOrgCards, PublicProfiles } from '#modules/organization/interface/public-profiles.js';
import { afterId, userId } from './common.js';

registerConstraintErrors({ follows_active_uq: 'DUPLICATE', favorites_active_uq: 'DUPLICATE' });

type ListQuery = { limit: number };

@Injectable()
@Operation('follows.list')
export class FollowsListHandler implements OperationHandler {
  constructor(private readonly cards: PublicOrgCards) {}

  async handle(ctx: OperationContext<undefined, ListQuery>): Promise<OperationResult> {
    const me = userId(ctx);
    const limit = ctx.query.limit;
    const body = await ctx.tx(
      async (scope) => {
        let q = scope.db
          .selectFrom('community.follows')
          .selectAll()
          .where('user_id', '=', me)
          .where('status', '=', 'active')
          .where('deleted_at', 'is', null);
        const after = afterId(ctx);
        if (after) q = q.where('id', '<', after);
        const rows = await q
          .orderBy('id', 'desc')
          .limit(limit + 1)
          .execute();
        const page = rows.slice(0, limit);
        const cards = await this.cards.cards(
          scope,
          page.map((r) => r.organization_id),
          ctx.locale,
        );
        return ctx.page(
          page
            .filter((r) => cards.has(r.organization_id))
            .map((r) => ({
              organization: cards.get(r.organization_id)!,
              notification_preference: r.notification_preference,
              followed_at: iso(r.created_at),
            })),
          rows.length > limit ? { id: page.at(-1)!.id } : null,
        );
      },
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('follows.put')
export class FollowsPutHandler implements OperationHandler {
  constructor(private readonly cards: PublicOrgCards) {}

  async handle(ctx: OperationContext<{ notification_preference: 'all' | 'important_only' | 'none' }>): Promise<OperationResult> {
    const me = userId(ctx);
    const orgId = ctx.params.org_id!;
    const body = await ctx.tx(async (scope) => {
      const card = (await this.cards.cards(scope, [orgId], ctx.locale)).get(orgId);
      if (!card) throw new ApiError('NOT_FOUND');
      const existing = await scope.db
        .selectFrom('community.follows')
        .selectAll()
        .where('user_id', '=', me)
        .where('organization_id', '=', orgId)
        .where('status', '=', 'active')
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      const row = existing
        ? await scope.db
            .updateTable('community.follows')
            .set({ notification_preference: ctx.body.notification_preference })
            .where('id', '=', existing.id)
            .returningAll()
            .executeTakeFirstOrThrow()
        : await scope.db
            .insertInto('community.follows')
            .values({ user_id: me, organization_id: orgId, notification_preference: ctx.body.notification_preference })
            .returningAll()
            .executeTakeFirstOrThrow();
      return { organization: card, notification_preference: row.notification_preference, followed_at: iso(row.created_at) };
    });
    return { body };
  }
}

@Injectable()
@Operation('follows.delete')
export class FollowsDeleteHandler implements OperationHandler {
  async handle(ctx: OperationContext): Promise<OperationResult> {
    const me = userId(ctx);
    // Idempotent: unfollowing an organization that is not followed is already done.
    await ctx.tx((scope) =>
      scope.db
        .updateTable('community.follows')
        .set({ status: 'unfollowed' })
        .where('user_id', '=', me)
        .where('organization_id', '=', ctx.params.org_id!)
        .where('status', '=', 'active')
        .execute(),
    );
    return { body: ACK };
  }
}

@Injectable()
@Operation('favorites.list')
export class FavoritesListHandler implements OperationHandler {
  constructor(private readonly cards: PublicOrgCards) {}

  async handle(ctx: OperationContext<undefined, ListQuery>): Promise<OperationResult> {
    const me = userId(ctx);
    const limit = ctx.query.limit;
    const body = await ctx.tx(
      async (scope) => {
        let q = scope.db
          .selectFrom('community.favorites')
          .selectAll()
          .where('user_id', '=', me)
          .where('status', '=', 'active')
          .where('deleted_at', 'is', null);
        const after = afterId(ctx);
        if (after) q = q.where('id', '<', after);
        const rows = await q
          .orderBy('id', 'desc')
          .limit(limit + 1)
          .execute();
        const page = rows.slice(0, limit);
        const cards = await this.cards.cards(
          scope,
          page.map((r) => r.organization_id),
          ctx.locale,
        );
        return ctx.page(
          page
            .filter((r) => cards.has(r.organization_id))
            .map((r) => ({ organization: cards.get(r.organization_id)!, saved_at: iso(r.created_at) })),
          rows.length > limit ? { id: page.at(-1)!.id } : null,
        );
      },
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('favorites.put')
export class FavoritesPutHandler implements OperationHandler {
  constructor(private readonly cards: PublicOrgCards) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const me = userId(ctx);
    const orgId = ctx.params.org_id!;
    const body = await ctx.tx(async (scope) => {
      const card = (await this.cards.cards(scope, [orgId], ctx.locale)).get(orgId);
      if (!card) throw new ApiError('NOT_FOUND');
      // Insert unless an active favourite exists (the partial unique index closes the race).
      const { rows } = await sql<{ created_at: Date }>`
        WITH existing AS (
          SELECT created_at FROM community.favorites
           WHERE user_id = ${me}::uuid AND organization_id = ${orgId}::uuid AND status = 'active' AND deleted_at IS NULL),
        inserted AS (
          INSERT INTO community.favorites (user_id, organization_id)
          SELECT ${me}::uuid, ${orgId}::uuid WHERE NOT EXISTS (SELECT 1 FROM existing)
          ON CONFLICT DO NOTHING
          RETURNING created_at)
        SELECT created_at FROM existing UNION ALL SELECT created_at FROM inserted`.execute(scope.db);
      const savedAt = rows[0]?.created_at ?? new Date();
      return { organization: card, saved_at: iso(savedAt) };
    });
    return { body };
  }
}

@Injectable()
@Operation('favorites.delete')
export class FavoritesDeleteHandler implements OperationHandler {
  async handle(ctx: OperationContext): Promise<OperationResult> {
    const me = userId(ctx);
    await ctx.tx((scope) =>
      scope.db
        .updateTable('community.favorites')
        .set({ status: 'removed' })
        .where('user_id', '=', me)
        .where('organization_id', '=', ctx.params.org_id!)
        .where('status', '=', 'active')
        .execute(),
    );
    return { body: ACK };
  }
}

@Injectable()
@Operation('showcases.get')
export class ShowcasesGetHandler implements OperationHandler {
  constructor(
    private readonly profiles: PublicProfiles,
    private readonly cards: PublicOrgCards,
  ) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const body = await ctx.tx(
      async (scope) => {
        const item = (await this.profiles.portfolioItems(scope, [ctx.params.item_id!], ctx.locale)).get(ctx.params.item_id!);
        const card = item ? (await this.cards.cards(scope, [item.organization_id], ctx.locale)).get(item.organization_id) : undefined;
        if (!item || !card) throw new ApiError('NOT_FOUND');
        const { organization_id: _o, ...rest } = item;
        return { ...rest, organization: card };
      },
      { readOnly: true },
    );
    return { body, cache: { public: 60 } };
  }
}
