// CommunityRead (interface/community.ts). Public content follows the public
// RLS policies and is filtered explicitly too, so the worker's system context
// sees the same: posts published and public, questions approved and not
// hidden, answers approved and active.
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { textArray } from '#libs/db/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import {
  CommunityRead,
  type CommunityEntity,
  type CommunitySearchSource,
  type FeedPost,
  type FeedQuestion,
} from '../interface/community.js';

const questionNodes = (q: {
  brand_node_id: string | null;
  model_node_id: string | null;
  series_node_id: string | null;
  symptom_node_id: string | null;
  category_node_id: string | null;
}): string[] => [q.brand_node_id, q.model_node_id, q.series_node_id, q.symptom_node_id, q.category_node_id].filter((x): x is string => !!x);

@Injectable()
export class DbCommunityRead extends CommunityRead {
  async searchSources(scope: TxScope, refs: readonly { type: CommunityEntity; id: string }[]): Promise<Map<string, CommunitySearchSource>> {
    const ids = (t: CommunityEntity) => [...new Set(refs.filter((r) => r.type === t).map((r) => r.id))].slice(0, 500);
    const out = new Map<string, CommunitySearchSource>();
    const postIds = ids('post');
    if (postIds.length)
      for (const p of await scope.db
        .selectFrom('community.posts')
        .selectAll()
        .where('id', 'in', postIds)
        .where('status', '=', 'published')
        .where('visibility', '=', 'public')
        .where('moderation_status', '=', 'approved')
        .where('deleted_at', 'is', null)
        .execute())
        out.set(`post:${p.id}`, {
          entity_type: 'post',
          entity_id: p.id,
          title: p.title,
          body: p.body,
          content_locale: p.content_locale,
          node_ids: textArray(p.taxonomy_node_ids),
          organization_id: p.author_organization_id,
          published_at: new Date(p.published_at!),
          status: null,
          question_id: null,
        });
    const questionIds = ids('question');
    if (questionIds.length)
      for (const q of await scope.db
        .selectFrom('community.questions')
        .selectAll()
        .where('id', 'in', questionIds)
        .where('moderation_status', '=', 'approved')
        .where('status', '<>', 'hidden')
        .where('deleted_at', 'is', null)
        .execute())
        out.set(`question:${q.id}`, {
          entity_type: 'question',
          entity_id: q.id,
          title: q.title,
          body: q.body,
          content_locale: q.content_locale,
          node_ids: questionNodes(q),
          organization_id: null,
          published_at: new Date(q.created_at),
          status: q.status,
          question_id: null,
        });
    const answerIds = ids('answer');
    if (answerIds.length)
      for (const a of await scope.db
        .selectFrom('community.answers as a')
        .innerJoin('community.questions as q', 'q.id', 'a.question_id')
        .select(['a.id', 'a.body', 'a.content_locale', 'a.author_organization_id', 'a.created_at', 'a.question_id'])
        .select(['q.brand_node_id', 'q.model_node_id', 'q.series_node_id', 'q.symptom_node_id', 'q.category_node_id', 'q.title'])
        .where('a.id', 'in', answerIds)
        .where('a.moderation_status', '=', 'approved')
        .where('a.status', '=', 'active')
        .where('a.deleted_at', 'is', null)
        .where('q.moderation_status', '=', 'approved')
        .where('q.status', '<>', 'hidden')
        .execute())
        out.set(`answer:${a.id}`, {
          entity_type: 'answer',
          entity_id: a.id,
          title: a.title,
          body: a.body,
          content_locale: a.content_locale,
          node_ids: questionNodes(a),
          organization_id: a.author_organization_id,
          published_at: new Date(a.created_at),
          status: null,
          question_id: a.question_id,
        });
    return out;
  }

  async publicRefs(scope: TxScope, after: string | null, limit: number): Promise<{ type: CommunityEntity; id: string }[]> {
    const { rows } = await sql<{ key: string }>`
      SELECT key FROM (
        SELECT 'post:' || id AS key FROM community.posts
         WHERE status = 'published' AND visibility = 'public' AND moderation_status = 'approved' AND deleted_at IS NULL
        UNION ALL SELECT 'question:' || id FROM community.questions
         WHERE moderation_status = 'approved' AND status <> 'hidden' AND deleted_at IS NULL
        UNION ALL SELECT 'answer:' || a.id FROM community.answers a JOIN community.questions q ON q.id = a.question_id
         WHERE a.moderation_status = 'approved' AND a.status = 'active' AND a.deleted_at IS NULL
           AND q.moderation_status = 'approved' AND q.status <> 'hidden') k
       WHERE ${after}::text IS NULL OR key > ${after}::text
       ORDER BY key LIMIT ${limit}`.execute(scope.db);
    return rows.map((r) => {
      const [type, id] = r.key.split(':') as [CommunityEntity, string];
      return { type, id };
    });
  }

  async favoriteOrgIds(scope: TxScope, userId: string): Promise<Set<string>> {
    const rows = await scope.db
      .selectFrom('community.favorites')
      .select('organization_id')
      .where('user_id', '=', userId)
      .where('status', '=', 'active')
      .where('deleted_at', 'is', null)
      .limit(1000)
      .execute();
    return new Set(rows.map((r) => r.organization_id));
  }

  async followedOrgIds(scope: TxScope, userId: string, limit: number): Promise<string[]> {
    const rows = await scope.db
      .selectFrom('community.follows')
      .select('organization_id')
      .where('user_id', '=', userId)
      .where('status', '=', 'active')
      .where('deleted_at', 'is', null)
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();
    return rows.map((r) => r.organization_id);
  }

  async followers(scope: TxScope, orgId: string, preferences: readonly ('all' | 'important_only')[]): Promise<string[]> {
    if (preferences.length === 0) return [];
    const rows = await scope.db
      .selectFrom('community.follows')
      .select('user_id')
      .where('organization_id', '=', orgId)
      .where('status', '=', 'active')
      .where('notification_preference', 'in', [...preferences])
      .where('deleted_at', 'is', null)
      .limit(10_000)
      .execute();
    return rows.map((r) => r.user_id);
  }

  async recentQuestions(scope: TxScope, o: { nodeIds?: readonly string[]; limit: number }): Promise<FeedQuestion[]> {
    let q = scope.db
      .selectFrom('community.questions as q')
      .select([
        'q.id',
        'q.title',
        'q.status',
        'q.created_at',
        'q.brand_node_id',
        'q.model_node_id',
        'q.series_node_id',
        'q.symptom_node_id',
        'q.category_node_id',
        (eb) =>
          eb
            .selectFrom('community.answers as a')
            .select(sql<string>`count(*)`.as('n'))
            .whereRef('a.question_id', '=', 'q.id')
            .where('a.status', '=', 'active')
            .where('a.moderation_status', '=', 'approved')
            .as('answer_count'),
      ])
      .where('q.moderation_status', '=', 'approved')
      .where('q.status', 'in', ['open', 'answered'])
      .where('q.deleted_at', 'is', null);
    if (o.nodeIds?.length) {
      const ids = [...o.nodeIds];
      q = q.where((eb) =>
        eb.or([
          eb('q.brand_node_id', 'in', ids),
          eb('q.model_node_id', 'in', ids),
          eb('q.symptom_node_id', 'in', ids),
          eb('q.category_node_id', 'in', ids),
        ]),
      );
    }
    const rows = await q.orderBy('q.id', 'desc').limit(o.limit).execute();
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      answer_count: Number(r.answer_count ?? 0),
      node_ids: questionNodes(r),
      created_at: new Date(r.created_at),
    }));
  }

  async recentPosts(scope: TxScope, orgIds: readonly string[], limit: number): Promise<FeedPost[]> {
    if (orgIds.length === 0) return [];
    const rows = await scope.db
      .selectFrom('community.posts')
      .select(['id', 'author_organization_id', 'post_type', 'title', 'body', 'published_at'])
      .where('author_organization_id', 'in', [...orgIds])
      .where('status', '=', 'published')
      .where('visibility', '=', 'public')
      .where('deleted_at', 'is', null)
      .orderBy('published_at', 'desc')
      .limit(limit)
      .execute();
    return rows.map((r) => ({
      id: r.id,
      organization_id: r.author_organization_id,
      post_type: r.post_type,
      title: r.title,
      body: r.body,
      published_at: new Date(r.published_at!),
    }));
  }
}
