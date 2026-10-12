// Questions and answers (40 §19.2, Should-have, FLAG qna.enabled). A question
// needs vehicle, symptom or category context (52 Question); the private
// vehicle link is stored but never shown, only its taxonomy. Answers can be
// given as a member of a provider or vendor. The question author accepts one
// answer of the same question (questions_accepted_answer_fk); text is
// pre-moderated (GD-22). questions.create emits qna.question.created.
import { Injectable } from '@nestjs/common';
import type { CarpalConfig } from '#libs/config/index.js';
import { sql } from 'kysely';
import { ApiError, type FieldError } from '#libs/contract/index.js';
import { ACK, created, Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import { normalizeSearchText, type Locale } from '#libs/i18n/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import { InjectConfig } from '#libs/runtime/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { MediaService } from '#modules/media/interface/media.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { VehicleCards } from '#modules/vehicle/interface/vehicles.js';
import { toPublicAnswer, toPublicQuestion, type AnswerRow, type QuestionRow } from '../api/projections.js';
import { autoModeration } from '../domain/rules.js';
import { checkVersion, CommunityCards, contentChanged, failIf, userId } from './common.js';

type QuestionWrite = {
  vehicle_id?: string;
  brand_node_id?: string;
  model_node_id?: string;
  series_node_id?: string;
  symptom_node_id?: string;
  category_node_id?: string;
  title: string;
  body: string;
  content_locale: string;
  media_ids?: string[];
};

const ANSWERS_SHOWN = 50;
const etagOf = (version: number): string => `"v${version}"`;

@Injectable()
export class QnaViews {
  constructor(
    private readonly cards: CommunityCards,
    private readonly taxonomy: TaxonomyResolver,
    private readonly media: MediaService,
  ) {}

  async answerCounts(scope: TxScope, ids: readonly string[]): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const rows = await scope.db
      .selectFrom('community.answers')
      .select(['question_id', sql<string>`count(*)`.as('n')])
      .where('question_id', 'in', [...ids])
      .where('status', '=', 'active')
      .where('moderation_status', '=', 'approved')
      .where('deleted_at', 'is', null)
      .groupBy('question_id')
      .execute();
    return new Map(rows.map((r) => [r.question_id, Number(r.n)]));
  }

  async questions(scope: TxScope, rows: readonly QuestionRow[], locale: Locale) {
    const ids = rows.map((r) => r.id);
    const [authors, labels, media, counts] = await Promise.all([
      this.cards.authors(
        scope,
        rows.map((r) => r.author_user_id),
        locale,
      ),
      this.taxonomy.labels(
        rows
          .flatMap((r) => [r.brand_node_id, r.model_node_id, r.series_node_id, r.symptom_node_id, r.category_node_id])
          .filter((x): x is string => !!x),
        locale,
      ),
      this.media.publicAttachmentViews(scope, 'question', ids),
      this.answerCounts(scope, ids),
    ]);
    return rows.map((r) =>
      toPublicQuestion(r, {
        author: authors.get(r.author_user_id)!,
        labels,
        media: media.get(r.id) ?? [],
        answerCount: counts.get(r.id) ?? 0,
      }),
    );
  }

  async answers(scope: TxScope, rows: readonly AnswerRow[], acceptedId: string | null, locale: Locale) {
    const [authors, orgs] = await Promise.all([
      this.cards.authors(
        scope,
        rows.map((r) => r.author_user_id),
        locale,
      ),
      this.cards.orgs(
        scope,
        rows.map((r) => r.author_organization_id).filter((x): x is string => !!x),
        locale,
      ),
    ]);
    return rows.map((r) =>
      toPublicAnswer(r, {
        author: authors.get(r.author_user_id)!,
        org: r.author_organization_id ? (orgs.get(r.author_organization_id) ?? null) : null,
        accepted: r.id === acceptedId,
      }),
    );
  }
}

/** A question visible to the caller: approved and not hidden, or the caller's own. */
async function visibleQuestion(scope: TxScope, id: string, me: string | null, lock = false): Promise<QuestionRow> {
  const q = scope.db
    .selectFrom('community.questions')
    .selectAll()
    .where('id', '=', id)
    .where('deleted_at', 'is', null)
    .where((eb) =>
      eb.or([
        eb.and([eb('moderation_status', '=', 'approved'), eb('status', '<>', 'hidden')]),
        ...(me ? [eb('author_user_id', '=', me)] : []),
      ]),
    );
  const row = await (lock ? q.forUpdate() : q).executeTakeFirst();
  if (!row) throw new ApiError('NOT_FOUND');
  return row;
}

@Injectable()
@Operation('questions.create')
export class QuestionsCreateHandler implements OperationHandler {
  constructor(
    private readonly views: QnaViews,
    private readonly taxonomy: TaxonomyResolver,
    private readonly vehicles: VehicleCards,
    private readonly media: MediaService,
  ) {}

  async handle(ctx: OperationContext<QuestionWrite>): Promise<OperationResult> {
    const me = userId(ctx);
    const b = { ...ctx.body };
    const errors: FieldError[] = [];
    if ([...b.body].length < 10) errors.push({ pointer: '/body', code: 'too_short', limit: '10' });
    // 52 Question: at least one of vehicle, symptom or category context.
    if (!b.vehicle_id && !b.symptom_node_id && !b.category_node_id)
      errors.push({ pointer: '/symptom_node_id', code: 'conditional_required' });
    failIf(errors);
    const body = await ctx.tx(async (scope) => {
      if (b.vehicle_id) {
        const v = await this.vehicles.visible(scope, b.vehicle_id);
        if (!v) throw ApiError.validation([{ pointer: '/vehicle_id', code: 'reference_not_found' }], 'REFERENCE_NOT_FOUND');
        // The public context is the vehicle's taxonomy, never the vehicle itself.
        b.brand_node_id ??= v.brandNodeId;
        if (b.brand_node_id === v.brandNodeId) {
          b.model_node_id ??= v.modelNodeId;
          b.series_node_id ??= v.seriesNodeId ?? undefined;
        }
      }
      if (b.brand_node_id) await this.taxonomy.require(b.brand_node_id, ['vehicle_brand'], '/brand_node_id');
      if (b.model_node_id) await this.taxonomy.require(b.model_node_id, ['vehicle_model'], '/model_node_id');
      if (b.series_node_id) await this.taxonomy.require(b.series_node_id, ['vehicle_series'], '/series_node_id');
      if (b.symptom_node_id) await this.taxonomy.require(b.symptom_node_id, ['symptom'], '/symptom_node_id');
      if (b.category_node_id) await this.taxonomy.require(b.category_node_id, ['service_system', 'part_category'], '/category_node_id');
      if (b.series_node_id && !b.model_node_id) throw ApiError.validation([{ pointer: '/model_node_id', code: 'conditional_required' }]);
      if (b.model_node_id && b.brand_node_id) await this.taxonomy.requireDescendant(b.model_node_id, b.brand_node_id, '/model_node_id');
      if (b.series_node_id && b.model_node_id) await this.taxonomy.requireDescendant(b.series_node_id, b.model_node_id, '/series_node_id');
      const row = await scope.db
        .insertInto('community.questions')
        .values({
          author_user_id: me,
          vehicle_id: b.vehicle_id ?? null,
          brand_node_id: b.brand_node_id ?? null,
          model_node_id: b.model_node_id ?? null,
          series_node_id: b.series_node_id ?? null,
          symptom_node_id: b.symptom_node_id ?? null,
          category_node_id: b.category_node_id ?? null,
          title: b.title,
          body: b.body,
          content_locale: b.content_locale,
          moderation_status: autoModeration(b.title, b.body),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      if (b.media_ids?.length)
        await this.media.syncAttachments(scope, b.media_ids, {
          owner: { type: 'user', id: me },
          purposes: ['qna'],
          pointer: '/media_ids',
          type: 'question',
          id: row.id,
          role: 'gallery',
        });
      // Payload without the private vehicle link or the author (52 §20).
      await publishEvent(scope, {
        type: 'qna.question.created',
        aggregateType: 'question',
        aggregateId: row.id,
        payload: {
          question_id: row.id,
          brand_node_id: row.brand_node_id,
          model_node_id: row.model_node_id,
          symptom_node_id: row.symptom_node_id,
          category_node_id: row.category_node_id,
          content_locale: row.content_locale,
          moderation_status: row.moderation_status,
        },
      });
      return (await this.views.questions(scope, [row], ctx.locale))[0]!;
    });
    return { ...created(body, `/v1/questions/${body.id}`), headers: { location: `/v1/questions/${body.id}`, etag: etagOf(1) } };
  }
}

type SearchBody = {
  text?: string;
  brand_node_id?: string;
  model_node_id?: string;
  symptom_node_id?: string;
  category_node_id?: string;
  status?: 'open' | 'answered';
  limit?: number;
};

/** LIKE pattern for a literal substring. */
const contains = (text: string): string => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

@Injectable()
@Operation('questions.search')
export class QuestionsSearchHandler implements OperationHandler {
  constructor(
    private readonly views: QnaViews,
    private readonly taxonomy: TaxonomyResolver,
    @InjectConfig() private readonly config: CarpalConfig,
  ) {}

  async handle(ctx: OperationContext<SearchBody>): Promise<OperationResult> {
    const b = ctx.body;
    const limit = b.limit ?? 20;
    const after = (ctx.cursor as { id?: string } | undefined)?.id;
    const body = await ctx.tx(
      async (scope) => {
        let q = scope.db
          .selectFrom('community.questions')
          .selectAll()
          .where('moderation_status', '=', 'approved')
          .where('status', 'in', b.status ? [b.status] : ['open', 'answered', 'closed'])
          .where('deleted_at', 'is', null);
        if (b.brand_node_id) q = q.where('brand_node_id', '=', b.brand_node_id);
        if (b.model_node_id) q = q.where('model_node_id', '=', b.model_node_id);
        if (b.symptom_node_id) q = q.where('symptom_node_id', '=', b.symptom_node_id);
        if (b.category_node_id) q = q.where('category_node_id', 'in', await this.taxonomy.descendants(b.category_node_id));
        // Every word must appear in the title or body, compared in the search normalization (52 §2.5): Persian
        // typed with Arabic letters and Persian/Arabic digits match.
        for (const word of normalizeSearchText(b.text ?? '', { dbLocale: this.config.db.locale })
          .split(' ')
          .filter(Boolean)
          .slice(0, 10))
          q = q.where(sql<boolean>`core.normalize_search_text(title || ' ' || body) LIKE ${contains(word)}`);
        if (after) q = q.where('id', '<', after);
        const rows = await q
          .orderBy('id', 'desc')
          .limit(limit + 1)
          .execute();
        const page = rows.slice(0, limit);
        return ctx.page(await this.views.questions(scope, page, ctx.locale), rows.length > limit ? { id: page.at(-1)!.id } : null);
      },
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('questions.get')
export class QuestionsGetHandler implements OperationHandler {
  constructor(private readonly views: QnaViews) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const me = ctx.principal.kind === 'user' ? ctx.principal.userId : null;
    const body = await ctx.tx(
      async (scope) => {
        const q = await visibleQuestion(scope, ctx.params.question_id!, me);
        const answers = await scope.db
          .selectFrom('community.answers')
          .selectAll()
          .where('question_id', '=', q.id)
          .where('status', '=', 'active')
          .where('deleted_at', 'is', null)
          .where((eb) => eb.or([eb('moderation_status', '=', 'approved'), ...(me ? [eb('author_user_id', '=', me)] : [])]))
          // Accepted first, then most helpful, then oldest.
          .orderBy(sql<boolean>`(id = ${q.accepted_answer_id}::uuid) IS TRUE`, 'desc')
          .orderBy('helpful_count', 'desc')
          .orderBy('id')
          .limit(ANSWERS_SHOWN)
          .execute();
        const [question] = await this.views.questions(scope, [q], ctx.locale);
        return {
          version: q.version,
          view: {
            question,
            answers: { items: await this.views.answers(scope, answers, q.accepted_answer_id, ctx.locale), next_cursor: null },
          },
        };
      },
      { readOnly: true },
    );
    // PublicQuestion has no version member (DI-47): the ETag that questions.update needs travels in the header.
    return { body: body.view, headers: { etag: etagOf(body.version) } };
  }
}

@Injectable()
@Operation('questions.update')
export class QuestionsUpdateHandler implements OperationHandler {
  constructor(private readonly views: QnaViews) {}

  async handle(ctx: OperationContext<{ title?: string; body?: string; status?: 'closed' }>): Promise<OperationResult> {
    const me = userId(ctx);
    const b = ctx.body;
    if (b.body !== undefined && [...b.body].length < 10) failIf([{ pointer: '/body', code: 'too_short', limit: '10' }]);
    const body = await ctx.tx(async (scope) => {
      const q = await scope.db
        .selectFrom('community.questions')
        .selectAll()
        .where('id', '=', ctx.params.question_id!)
        .where('author_user_id', '=', me)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!q) throw new ApiError('NOT_FOUND');
      checkVersion(q.version, ctx.ifMatch);
      if (q.status === 'hidden') throw new ApiError('INVALID_TRANSITION', { detail: 'hidden' });
      const edited = b.title !== undefined || b.body !== undefined;
      const row = await scope.db
        .updateTable('community.questions')
        .set({
          ...(b.title !== undefined ? { title: b.title } : {}),
          ...(b.body !== undefined ? { body: b.body } : {}),
          ...(b.status ? { status: 'closed' } : {}),
          // Edited text is moderated again (GD-22).
          ...(edited ? { moderation_status: autoModeration(b.title ?? q.title, b.body ?? q.body) } : {}),
        })
        .where('id', '=', q.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await contentChanged(scope, 'question', q.id);
      return { version: row.version, view: (await this.views.questions(scope, [row], ctx.locale))[0] };
    });
    return { body: body.view, headers: { etag: etagOf(body.version) } };
  }
}

@Injectable()
@Operation('answers.create')
export class AnswersCreateHandler implements OperationHandler {
  constructor(private readonly views: QnaViews) {}

  async handle(ctx: OperationContext<{ body: string; content_locale: string; as_organization_id?: string }>): Promise<OperationResult> {
    const me = userId(ctx);
    const b = ctx.body;
    if ([...b.body].length < 10) failIf([{ pointer: '/body', code: 'too_short', limit: '10' }]);
    const body = await ctx.tx(async (scope) => {
      const q = await visibleQuestion(scope, ctx.params.question_id!, me);
      if (q.status === 'closed' || q.status === 'hidden') throw new ApiError('INVALID_TRANSITION', { detail: 'question_closed' });
      // Answering as a business: the caller must be a member of that provider or vendor.
      if (b.as_organization_id) await ctx.authorizeOrg(b.as_organization_id, ['P*', 'V*']);
      const row = await scope.db
        .insertInto('community.answers')
        .values({
          question_id: q.id,
          author_user_id: me,
          author_organization_id: b.as_organization_id ?? null,
          body: b.body,
          content_locale: b.content_locale,
          moderation_status: autoModeration(b.body),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      if (row.moderation_status === 'approved') await contentChanged(scope, 'answer', row.id);
      return (await this.views.answers(scope, [row], q.accepted_answer_id, ctx.locale))[0]!;
    });
    return created(body, `/v1/questions/${ctx.params.question_id}/answers/${body.id}`);
  }
}

@Injectable()
@Operation('answers.accept')
export class AnswersAcceptHandler implements OperationHandler {
  constructor(private readonly views: QnaViews) {}

  async handle(ctx: OperationContext<{ answer_id: string }>): Promise<OperationResult> {
    const me = userId(ctx);
    const body = await ctx.tx(async (scope) => {
      const q = await scope.db
        .selectFrom('community.questions')
        .selectAll()
        .where('id', '=', ctx.params.question_id!)
        .where('author_user_id', '=', me)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!q) throw new ApiError('NOT_FOUND');
      if (q.status === 'hidden' || q.status === 'closed') throw new ApiError('INVALID_TRANSITION', { detail: q.status });
      const answer = await scope.db
        .selectFrom('community.answers')
        .select('id')
        .where('id', '=', ctx.body.answer_id)
        .where('question_id', '=', q.id)
        .where('status', '=', 'active')
        .where('moderation_status', '=', 'approved')
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!answer) throw ApiError.validation([{ pointer: '/answer_id', code: 'reference_not_found' }], 'REFERENCE_NOT_FOUND');
      const row = await scope.db
        .updateTable('community.questions')
        .set({ accepted_answer_id: answer.id, status: 'answered' })
        .where('id', '=', q.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await contentChanged(scope, 'question', q.id);
      return (await this.views.questions(scope, [row], ctx.locale))[0];
    });
    return { body };
  }
}

@Injectable()
@Operation('answers.delete')
export class AnswersDeleteHandler implements OperationHandler {
  async handle(ctx: OperationContext): Promise<OperationResult> {
    const me = userId(ctx);
    await ctx.tx(async (scope) => {
      const a = await scope.db
        .selectFrom('community.answers')
        .select(['id', 'question_id'])
        .where('id', '=', ctx.params.answer_id!)
        .where('author_user_id', '=', me)
        .where('status', '<>', 'removed')
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!a) throw new ApiError('NOT_FOUND');
      // An accepted answer that is withdrawn reopens its question (definer-free: the answer's author may not
      // update another user's question, so only the reference check below applies).
      const accepted = await scope.db
        .selectFrom('community.questions')
        .select('id')
        .where('id', '=', a.question_id)
        .where('accepted_answer_id', '=', a.id)
        .executeTakeFirst();
      if (accepted) throw new ApiError('INVALID_TRANSITION', { detail: 'accepted_answer' });
      await scope.db.updateTable('community.answers').set({ status: 'removed' }).where('id', '=', a.id).execute();
      await contentChanged(scope, 'answer', a.id);
    });
    return { body: ACK };
  }
}
