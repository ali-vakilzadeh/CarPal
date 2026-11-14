// Community's plug-ins for the admin plane (S8): moderation targets for posts,
// comments, questions and answers (GD-22 holds content with links or contact
// data for the queue; moderators approve, hide, remove or restore it, and the
// search index follows through community.content.changed), and its part of
// data subject requests (authored content is exported; follows and favourites
// are deleted with the account, authored public content stays under "former
// member").
import { Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import type { TxScope } from '#libs/tenancy/index.js';
import {
  excerpt,
  ModerationTargets,
  type ContentAction,
  type ContextRecord,
  type ModerationTargetHandler,
  type TargetSummary,
} from '#modules/admin/interface/admin.js';
import { PersonalDataRegistry } from '#modules/identity/interface/identity.js';
import type { CommunityEntity } from '../interface/community.js';
import { contentChanged } from './common.js';

type Table = 'community.posts' | 'community.comments' | 'community.questions' | 'community.answers';

interface Spec {
  table: Table;
  entity: CommunityEntity | 'comment';
  /** Status of hidden content and of removed content (questions have no removed state). */
  hidden: string;
  removed: string;
  /** Status a restored record returns to. */
  restored: (r: { published_at?: Date | null }) => string;
  org?: 'author_organization_id';
  text: (r: Record<string, unknown>) => Record<string, unknown>;
  /** Snapshot-only fields (40 CommentSnapshot.target, AnswerSnapshot.question_id; backend S18). */
  refs?: (r: Record<string, unknown>) => Record<string, unknown>;
  /** Statuses of live records (author history: published). */
  live: string[];
}

const SPECS: Record<'post' | 'comment' | 'question' | 'answer', Spec> = {
  post: {
    table: 'community.posts',
    entity: 'post',
    hidden: 'hidden',
    removed: 'removed',
    restored: (r) => (r.published_at ? 'published' : 'draft'),
    org: 'author_organization_id',
    text: (r) => ({ title: r.title, body: r.body, post_type: r.post_type }),
    live: ['published'],
  },
  comment: {
    table: 'community.comments',
    entity: 'comment',
    hidden: 'hidden',
    removed: 'removed',
    restored: () => 'active',
    text: (r) => ({ body: r.body }),
    refs: (r) => ({ target: { type: r.target_type, id: r.target_id } }),
    live: ['active'],
  },
  question: {
    table: 'community.questions',
    entity: 'question',
    hidden: 'hidden',
    removed: 'hidden',
    restored: () => 'open',
    text: (r) => ({ title: r.title, body: r.body }),
    live: ['open', 'answered', 'closed'],
  },
  answer: {
    table: 'community.answers',
    entity: 'answer',
    hidden: 'hidden',
    removed: 'removed',
    restored: () => 'active',
    org: 'author_organization_id',
    text: (r) => ({ body: r.body }),
    refs: (r) => ({ question_id: r.question_id }),
    live: ['active'],
  },
};

/** One author's community records, live and hidden or removed, over the four tables (S18, BR-33). */
async function authorHistory(scope: TxScope, userId: string): Promise<{ published: number; removed: number }> {
  const parts = Object.values(SPECS).map(
    (spec) => sql`
      SELECT count(*) FILTER (WHERE status IN (${sql.join(spec.live)})) AS published,
             count(*) FILTER (WHERE status IN ('hidden','removed')) AS removed
        FROM ${sql.table(spec.table)} WHERE author_user_id = ${userId}::uuid AND deleted_at IS NULL`,
  );
  const { rows } = await sql<{
    published: string;
    removed: string;
  }>`SELECT sum(published) AS published, sum(removed) AS removed FROM (${sql.join(parts, sql` UNION ALL `)}) h`.execute(scope.db);
  return { published: Number(rows[0]?.published ?? 0), removed: Number(rows[0]?.removed ?? 0) };
}

type Row = Record<string, unknown> & { id: string; body: string; status: string; moderation_status: string; created_at: Date };

const contextRecord =
  (type: 'comment' | 'answer', targetId: string | null) =>
  (r: Row): ContextRecord => ({
    type,
    id: r.id,
    body: r.body,
    status: r.status,
    moderationStatus: r.moderation_status,
    createdAt: new Date(r.created_at),
    authorUserId: r.author_user_id as string,
    organizationId: (r.author_organization_id as string | null | undefined) ?? null,
    isTarget: r.id === targetId,
  });

/**
 * Up to `limit` comments on a record (or answers to a question), oldest first: around `targetId` when given (half
 * before it, the rest from it on), else the first ones; with the total count (S18 admin.case_context).
 */
async function around(
  scope: TxScope,
  table: 'community.comments' | 'community.answers',
  where: ReturnType<typeof sql>,
  limit: number,
  target: Row | null,
): Promise<{ rows: Row[]; total: number }> {
  const base = sql`FROM ${sql.table(table)} WHERE ${where} AND deleted_at IS NULL`;
  const total = Number((await sql<{ n: string }>`SELECT count(*) AS n ${base}`.execute(scope.db)).rows[0]?.n ?? 0);
  if (!target) {
    const { rows } = await sql<Row>`SELECT * ${base} ORDER BY created_at, id LIMIT ${limit}`.execute(scope.db);
    return { rows, total };
  }
  const key = sql`(${new Date(target.created_at)}::timestamptz, ${target.id}::uuid)`;
  const before = (
    await sql<Row>`SELECT * ${base} AND (created_at, id) < ${key} ORDER BY created_at DESC, id DESC LIMIT ${Math.floor((limit - 1) / 2)}`.execute(
      scope.db,
    )
  ).rows.reverse();
  const after = (
    await sql<Row>`SELECT * ${base} AND (created_at, id) >= ${key} ORDER BY created_at, id LIMIT ${limit - before.length}`.execute(scope.db)
  ).rows;
  return { rows: [...before, ...after], total };
}

async function load(scope: TxScope, spec: Spec, id: string, lock = false): Promise<Record<string, unknown> | undefined> {
  const q = sql<
    Record<string, unknown>
  >`SELECT * FROM ${sql.table(spec.table)} WHERE id = ${id}::uuid AND deleted_at IS NULL ${lock ? sql`FOR UPDATE` : sql``}`;
  return (await q.execute(scope.db)).rows[0];
}

async function setStatus(scope: TxScope, spec: Spec, id: string, set: { status?: string; moderation_status?: string }): Promise<void> {
  const parts = Object.entries(set).map(([k, v]) => sql`${sql.ref(k)} = ${v}`);
  await sql`UPDATE ${sql.table(spec.table)} SET ${sql.join(parts)} WHERE id = ${id}::uuid`.execute(scope.db);
  // Comments are not indexed; posts, questions and answers leave or re-enter the search index.
  if (spec.entity !== 'comment') await contentChanged(scope, spec.entity, id);
}

function handler(spec: Spec): ModerationTargetHandler {
  return {
    exists: async (scope, id) => !!(await load(scope, spec, id)),
    snapshot: async (scope, id) => {
      const r = await load(scope, spec, id);
      return r
        ? {
            type: spec.entity,
            id,
            available: true,
            ...spec.text(r),
            ...(spec.entity === 'post' ? { title: r.title ?? null } : {}),
            ...spec.refs?.(r),
            status: r.status,
            moderation_status: r.moderation_status,
            created_at: new Date(r.created_at as Date).toISOString(),
          }
        : null;
    },
    // S18 (BR-27): the title, or the start of the text.
    summaries: async (scope, ids) => {
      if (ids.length === 0) return new Map<string, TargetSummary>();
      const { rows } = await sql<{ id: string; title: string | null; body: string }>`
        SELECT id, ${spec.entity === 'post' || spec.entity === 'question' ? sql`title` : sql`NULL::text`} AS title, body
          FROM ${sql.table(spec.table)} WHERE id = ANY(${sql.val(ids)}::uuid[]) AND deleted_at IS NULL`.execute(scope.db);
      return new Map(rows.map((r) => [r.id, { excerpt: excerpt(r.title ?? r.body), rating: null }]));
    },
    // S18 (BR-33): the author, the organization written for, and the author's community history.
    authorOf: async (scope, id) => {
      const r = await load(scope, spec, id);
      if (!r) return null;
      const userId = r.author_user_id as string;
      return {
        userId,
        organizationId: spec.org ? ((r[spec.org] as string | null) ?? null) : null,
        ...(await authorHistory(scope, userId)),
      };
    },
    context: async (scope, id, limit) => {
      const r = (await load(scope, spec, id)) as Row | undefined;
      if (!r) return null;
      if (spec.entity === 'comment') {
        const on = sql`target_type = ${r.target_type as string} AND target_id = ${r.target_id as string}::uuid`;
        const { rows, total } = await around(scope, 'community.comments', on, limit, r);
        return {
          parent: { type: r.target_type as string, id: r.target_id as string },
          items: rows.map(contextRecord('comment', id)),
          total,
        };
      }
      if (spec.entity === 'answer') {
        const on = sql`question_id = ${r.question_id as string}::uuid`;
        const { rows, total } = await around(scope, 'community.answers', on, limit, r);
        return { parent: { type: 'question', id: r.question_id as string }, items: rows.map(contextRecord('answer', id)), total };
      }
      if (spec.entity === 'post') {
        const { rows, total } = await around(
          scope,
          'community.comments',
          sql`target_type = 'post' AND target_id = ${id}::uuid`,
          limit,
          null,
        );
        return { parent: null, items: rows.map(contextRecord('comment', null)), total };
      }
      const { rows, total } = await around(scope, 'community.answers', sql`question_id = ${id}::uuid`, limit, null);
      return { parent: null, items: rows.map(contextRecord('answer', null)), total };
    },
    subjectOrganization: async (scope, id) => (spec.org ? (((await load(scope, spec, id))?.[spec.org] as string | null) ?? null) : null),
    author: async (scope, id) => ((await load(scope, spec, id))?.author_user_id as string | undefined) ?? null,
    apply: async (scope, id, action: ContentAction) => {
      const r = await load(scope, spec, id, true);
      if (!r) return false;
      if (action === 'approve') {
        if (r.moderation_status === 'approved') return false;
        // A published post held after an edit returns to publication (GD-22); a new one waits for its author to publish.
        const republish = spec.entity === 'post' && r.status === 'draft' && r.published_at;
        await setStatus(scope, spec, id, { moderation_status: 'approved', ...(republish ? { status: 'published' } : {}) });
        return true;
      }
      if (action === 'hide' || action === 'remove') {
        const status = action === 'hide' ? spec.hidden : spec.removed;
        if (r.status === status) return false;
        await setStatus(scope, spec, id, { status, moderation_status: 'rejected' });
        return true;
      }
      if (action === 'restore') {
        if (r.status !== spec.hidden && r.status !== spec.removed) return false;
        await setStatus(scope, spec, id, { status: spec.restored(r as { published_at?: Date | null }), moderation_status: 'approved' });
        return true;
      }
      return false;
    },
    pending: async (scope, limit) => {
      const { rows } = await sql<{ id: string }>`
        SELECT id FROM ${sql.table(spec.table)}
         WHERE moderation_status = 'pending' AND status NOT IN ('hidden','removed') AND deleted_at IS NULL
           AND created_at < now() - interval '1 minute'
         ORDER BY id LIMIT ${limit}`.execute(scope.db);
      return rows.map((r) => r.id);
    },
  };
}

@Injectable()
export class CommunityAdminRegistrations implements OnModuleInit {
  constructor(
    @Optional() private readonly targets?: ModerationTargets,
    @Optional() private readonly personal?: PersonalDataRegistry,
  ) {}

  onModuleInit(): void {
    for (const [type, spec] of Object.entries(SPECS)) this.targets?.register(type as keyof typeof SPECS, handler(spec));
    this.personal?.register('community', {
      async export(scope, userId) {
        const sections = [];
        for (const [type, spec] of Object.entries(SPECS)) {
          const { rows } = await sql<Record<string, unknown>>`
            SELECT * FROM ${sql.table(spec.table)} WHERE author_user_id = ${userId}::uuid AND deleted_at IS NULL`.execute(scope.db);
          sections.push({
            section: `community_${type}s`,
            records: rows.map((r) => ({
              id: String(r.id),
              fields: Object.fromEntries(
                Object.entries({ ...spec.text(r), status: r.status, created_at: new Date(r.created_at as Date).toISOString() }).map(
                  ([k, v]) => [k, v === undefined ? null : (v as string | number | boolean | null)],
                ),
              ),
            })),
          });
        }
        const follows = await scope.db
          .selectFrom('community.follows')
          .select(['id', 'organization_id', 'created_at'])
          .where('user_id', '=', userId)
          .execute();
        sections.push({
          section: 'follows',
          records: follows.map((f) => ({
            id: f.id,
            fields: { organization_id: f.organization_id, created_at: f.created_at.toISOString() },
          })),
        });
        return sections;
      },
      async erase(scope, userId) {
        let n = 0;
        for (const t of ['community.follows', 'community.favorites'] as const)
          n += Number((await sql`DELETE FROM ${sql.table(t)} WHERE user_id = ${userId}::uuid`.execute(scope.db)).numAffectedRows ?? 0);
        return n;
      },
    });
  }
}
