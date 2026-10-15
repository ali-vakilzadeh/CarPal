// Taxonomy administration (40 §23.3; 52 TaxonomyNode, TaxonomySynonym,
// TaxonomyMapping; GD-16). Staff create and edit nodes (labels in every
// enabled locale; parent rules and cycles are checked by the database
// trigger, TAXONOMY_MISMATCH), manage synonyms and transliterations
// (including AI suggestions waiting for review) and weighted mappings. A merge
// needs a second admin; after approval a background job re-points every
// module's references (TaxonomyReferences), marks the node merged and
// publishes taxonomy.node.merged (every process drops its catalog cache, W2
// rebuilds). Each change drops this process's catalog at once.
import { Injectable } from '@nestjs/common';
import { sql, type Selectable } from 'kysely';
import { writeAudit } from '#libs/audit/index.js';
import { ApiError, type FieldError } from '#libs/contract/index.js';
import { registerConstraintErrors, textArray, type DB } from '#libs/db/index.js';
import { created, iso, Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import type { Locale } from '#libs/i18n/index.js';
import { acceptedJob, JobService, type JobContext, type JobOutcome } from '#libs/jobs/index.js';
import type { Logger } from '#libs/observability/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import { InjectLogger } from '#libs/runtime/index.js';
import { TxRunner, type TxScope } from '#libs/tenancy/index.js';
import { FourEyes, headerReasonOf, staffOf } from '#modules/admin/interface/admin.js';
import { toTaxonomyNode } from '../api/projections.js';
import { TaxonomyReferences, TaxonomyResolver, type TaxonomyNodeRecord } from '../interface/taxonomy-resolver.js';

export const TAXONOMY_MERGE_QUEUE = 'taxonomy.merge';

registerConstraintErrors({
  taxonomy_nodes_type_parent_id_slug_key: { code: 'DUPLICATE', pointer: '/slug' },
  taxonomy_synonyms_taxonomy_node_id_term_locale_script_key: 'DUPLICATE',
  taxonomy_mappings_source_node_id_target_node_id_mapping_type_key: 'DUPLICATE',
});

type NodeRow = Selectable<DB['taxonomy.taxonomy_nodes']>;

async function loadNode(scope: TxScope, id: string, lock = false) {
  const q = scope.db.selectFrom('taxonomy.taxonomy_nodes').selectAll().where('id', '=', id).where('deleted_at', 'is', null);
  const n = await (lock ? q.forUpdate() : q).executeTakeFirst();
  if (!n) throw new ApiError('NOT_FOUND');
  return n;
}

/** 40 TaxonomyNode for staff (with version for If-Match). */
function nodeView(n: NodeRow, locale: Locale) {
  const record: TaxonomyNodeRecord = {
    id: n.id,
    type: n.type as TaxonomyNodeRecord['type'],
    parentId: n.parent_id,
    nameTranslations: n.name_translations as Record<string, string>,
    descriptionTranslations: (n.description_translations as Record<string, string> | null) ?? null,
    slug: n.slug,
    regions: textArray(n.regions),
    attributes: (n.attributes as Record<string, unknown> | null) ?? null,
    sortOrder: n.sort_order,
    status: n.status as TaxonomyNodeRecord['status'],
    mergedIntoId: n.merged_into_id,
  };
  return { ...toTaxonomyNode(record, locale), version: n.version };
}

const json = (v: unknown) => (v === undefined ? undefined : v === null ? null : JSON.stringify(v));

type NodeWrite = {
  type: string;
  parent_id?: string;
  name_translations: Record<string, string>;
  description_translations?: Record<string, string>;
  slug: string;
  regions?: string[];
  attributes?: Record<string, unknown>;
  sort_order?: number;
  status?: string;
  reason: string;
};

/** Labels in every enabled locale (52 §2.4, the DB requires en and fa). */
function localeErrors(t: Record<string, string> | undefined, pointer: string): FieldError[] {
  if (t === undefined) return [];
  return ['en', 'fa'].filter((l) => !t[l]?.trim()).map((l) => ({ pointer: `${pointer}/${l}`, code: 'required' as const }));
}

@Injectable()
@Operation('admin.taxonomy_node_create')
export class TaxonomyNodeCreateHandler implements OperationHandler {
  constructor(private readonly taxonomy: TaxonomyResolver) {}

  async handle(ctx: OperationContext<NodeWrite>): Promise<OperationResult> {
    staffOf(ctx);
    const b = ctx.body;
    const errors = localeErrors(b.name_translations, '/name_translations');
    if (errors.length) throw ApiError.validation(errors);
    const body = await ctx.tx(async (scope) => {
      if (b.parent_id)
        await loadNode(scope, b.parent_id).catch(() =>
          Promise.reject(ApiError.validation([{ pointer: '/parent_id', code: 'reference_not_found' }], 'REFERENCE_NOT_FOUND')),
        );
      const row = await scope.db
        .insertInto('taxonomy.taxonomy_nodes')
        .values({
          type: b.type,
          parent_id: b.parent_id ?? null,
          name_translations: JSON.stringify(b.name_translations),
          description_translations: json(b.description_translations) ?? null,
          slug: b.slug,
          regions: b.regions ?? [],
          attributes: json(b.attributes) ?? null,
          sort_order: b.sort_order ?? 0,
          status: b.status ?? 'active',
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeAudit(scope, {
        action: 'taxonomy.node_created',
        entityType: 'taxonomy_node',
        entityId: row.id,
        reason: b.reason,
        next: `${row.type} ${row.slug}`,
      });
      scope.afterCommit(() => this.taxonomy.invalidate());
      return nodeView(row, ctx.locale);
    });
    return created(body, `/v1/taxonomy/nodes/${body.id}`);
  }
}

@Injectable()
@Operation('admin.taxonomy_node_update')
export class TaxonomyNodeUpdateHandler implements OperationHandler {
  constructor(private readonly taxonomy: TaxonomyResolver) {}

  async handle(ctx: OperationContext<Partial<Omit<NodeWrite, 'type'>> & { reason: string }>): Promise<OperationResult> {
    staffOf(ctx);
    const b = ctx.body;
    const errors = localeErrors(b.name_translations, '/name_translations');
    if (errors.length) throw ApiError.validation(errors);
    const body = await ctx.tx(async (scope) => {
      const n = await loadNode(scope, ctx.params.node_id!, true);
      if (ctx.ifMatch !== n.version) throw new ApiError('VERSION_MISMATCH');
      if (n.status === 'merged') throw new ApiError('INVALID_TRANSITION', { detail: 'merged' });
      const set = {
        ...(b.parent_id !== undefined ? { parent_id: b.parent_id } : {}),
        ...(b.name_translations !== undefined ? { name_translations: JSON.stringify(b.name_translations) } : {}),
        ...(b.description_translations !== undefined ? { description_translations: json(b.description_translations) ?? null } : {}),
        ...(b.slug !== undefined ? { slug: b.slug } : {}),
        ...(b.regions !== undefined ? { regions: b.regions } : {}),
        ...(b.attributes !== undefined ? { attributes: json(b.attributes) ?? null } : {}),
        ...(b.sort_order !== undefined ? { sort_order: b.sort_order } : {}),
        ...(b.status !== undefined ? { status: b.status } : {}),
      };
      if (Object.keys(set).length === 0) return nodeView(n, ctx.locale);
      const row = await scope.db
        .updateTable('taxonomy.taxonomy_nodes')
        .set(set)
        .where('id', '=', n.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeAudit(scope, {
        action: 'taxonomy.node_updated',
        entityType: 'taxonomy_node',
        entityId: n.id,
        reason: b.reason,
        previous: JSON.stringify({ slug: n.slug, status: n.status, parent_id: n.parent_id }),
        next: `${Object.keys(set).sort().join(', ')}`,
      });
      scope.afterCommit(() => this.taxonomy.invalidate());
      return nodeView(row, ctx.locale);
    });
    return { body };
  }
}

/** A merge pair: distinct live nodes of the same type, the target not below the source. */
async function mergePair(scope: TxScope, taxonomy: TaxonomyResolver, fromId: string, intoId: string): Promise<[NodeRow, NodeRow]> {
  const from = await loadNode(scope, fromId, true);
  if (fromId === intoId) throw ApiError.validation([{ pointer: '/into_node_id', code: 'conditional_forbidden' }]);
  const into = await scope.db
    .selectFrom('taxonomy.taxonomy_nodes')
    .selectAll()
    .where('id', '=', intoId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!into) throw ApiError.validation([{ pointer: '/into_node_id', code: 'reference_not_found' }], 'REFERENCE_NOT_FOUND');
  if (from.type !== into.type) throw ApiError.validation([{ pointer: '/into_node_id', code: 'enum' }], 'TAXONOMY_MISMATCH');
  if (from.status === 'merged' || into.status === 'merged') throw new ApiError('INVALID_TRANSITION', { detail: 'merged' });
  if ((await taxonomy.ancestors(intoId)).includes(fromId))
    throw ApiError.validation([{ pointer: '/into_node_id', code: 'enum' }], 'TAXONOMY_MISMATCH');
  return [from, into];
}

@Injectable()
@Operation('admin.taxonomy_merge')
export class TaxonomyMergeHandler implements OperationHandler {
  constructor(
    private readonly fourEyes: FourEyes,
    private readonly taxonomy: TaxonomyResolver,
  ) {}

  async handle(ctx: OperationContext<{ into_node_id: string; reason: string }>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const body = await ctx.tx(async (scope) => {
      const [from, into] = await mergePair(scope, this.taxonomy, ctx.params.node_id!, ctx.body.into_node_id);
      return this.fourEyes.request(
        scope,
        s.userId,
        {
          opId: 'admin.taxonomy_merge',
          targetType: 'taxonomy_node',
          targetId: from.id,
          payload: { node_id: from.id, into_node_id: into.id },
          summary: `Merge ${from.type} "${from.slug}" into "${into.slug}"`,
          reason: ctx.body.reason,
          requiredRole: 'platform_admin',
        },
        ctx.locale,
      );
    });
    return { status: 202, body };
  }
}

/** Four-eyes executor of admin.taxonomy_merge: the re-pointing runs as a background job (W7/W15 worker queue). */
export async function startTaxonomyMerge(
  scope: TxScope,
  jobs: JobService,
  change: { targetId: string; payload: Record<string, unknown>; approvedBy: string },
) {
  const row = await jobs.create(scope, {
    kind: 'taxonomy_merge',
    ownerUserId: change.approvedBy,
    owningModule: 'taxonomy',
    inputSummary: { node_id: change.targetId, into_node_id: change.payload.into_node_id },
    queue: TAXONOMY_MERGE_QUEUE,
  });
  return acceptedJob(row);
}

/** The merge job: every module re-points, then the node becomes merged and taxonomy.node.merged is published. */
@Injectable()
export class TaxonomyMerger {
  constructor(
    private readonly tx: TxRunner,
    private readonly references: TaxonomyReferences,
    private readonly taxonomy: TaxonomyResolver,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  async run(ctx: JobContext): Promise<JobOutcome> {
    const input = ctx.job.input_summary as { node_id?: string; into_node_id?: string } | null;
    if (!input?.node_id || !input.into_node_id) return { errorCode: 'INTERNAL' };
    const { node_id: fromId, into_node_id: intoId } = input;
    return this.tx.run({ actorType: 'system' }, async (scope) => {
      const [from] = await mergePair(scope, this.taxonomy, fromId, intoId);
      const counts: Record<string, number> = {};
      for (const [module, repoint] of this.references.entries()) counts[module] = await repoint(scope, fromId, intoId);
      await scope.db
        .updateTable('taxonomy.taxonomy_nodes')
        .set({ status: 'merged', merged_into_id: intoId })
        .where('id', '=', from.id)
        .execute();
      await writeAudit(scope, {
        action: 'taxonomy.node_merged',
        entityType: 'taxonomy_node',
        entityId: from.id,
        previous: `${from.type} ${from.slug} ${from.status}`,
        next: `merged into ${intoId}: ${JSON.stringify(counts)}`.slice(0, 2000),
      });
      await publishEvent(scope, {
        type: 'taxonomy.node.merged',
        aggregateType: 'taxonomy_node',
        aggregateId: from.id,
        payload: { node_id: from.id, into_node_id: intoId },
      });
      scope.afterCommit(() => this.taxonomy.invalidate());
      this.logger.info({ node: from.id, into: intoId, counts }, 'taxonomy node merged');
      return { result: { type: 'taxonomy_node', id: intoId } };
    });
  }
}

/** The taxonomy module's own references: children, synonyms and mappings move to the surviving node (duplicates stay behind). */
export async function repointTaxonomy(scope: TxScope, fromId: string, intoId: string): Promise<number> {
  let n = 0;
  const run = async (q: ReturnType<typeof sql>) => {
    n += Number((await q.execute(scope.db)).numAffectedRows ?? 0);
  };
  await run(sql`UPDATE taxonomy.taxonomy_nodes SET parent_id = ${intoId}::uuid WHERE parent_id = ${fromId}::uuid AND id <> ${intoId}::uuid
                AND NOT EXISTS (SELECT 1 FROM taxonomy.taxonomy_nodes o WHERE o.parent_id = ${intoId}::uuid AND o.type = taxonomy_nodes.type AND o.slug = taxonomy_nodes.slug)`);
  await run(sql`UPDATE taxonomy.taxonomy_synonyms s SET taxonomy_node_id = ${intoId}::uuid WHERE s.taxonomy_node_id = ${fromId}::uuid
                AND NOT EXISTS (SELECT 1 FROM taxonomy.taxonomy_synonyms o WHERE o.taxonomy_node_id = ${intoId}::uuid AND o.term = s.term
                                AND o.locale = s.locale AND o.script IS NOT DISTINCT FROM s.script)`);
  for (const col of ['source_node_id', 'target_node_id'] as const) {
    const other = col === 'source_node_id' ? 'target_node_id' : 'source_node_id';
    await run(sql`UPDATE taxonomy.taxonomy_mappings m SET ${sql.ref(col)} = ${intoId}::uuid WHERE m.${sql.ref(col)} = ${fromId}::uuid
                  AND m.${sql.ref(other)} <> ${intoId}::uuid
                  AND NOT EXISTS (SELECT 1 FROM taxonomy.taxonomy_mappings o WHERE o.${sql.ref(col)} = ${intoId}::uuid
                                  AND o.${sql.ref(other)} = m.${sql.ref(other)} AND o.mapping_type = m.mapping_type)`);
  }
  return n;
}

type SynonymRow = Selectable<DB['taxonomy.taxonomy_synonyms']>;
async function loadSynonym(scope: TxScope, id: string, lock = false) {
  const q = scope.db.selectFrom('taxonomy.taxonomy_synonyms').selectAll().where('id', '=', id).where('deleted_at', 'is', null);
  const r = await (lock ? q.forUpdate() : q).executeTakeFirst();
  if (!r) throw new ApiError('NOT_FOUND');
  return r;
}

function toSynonym(r: SynonymRow) {
  return {
    id: r.id,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
    version: r.version,
    term: r.term,
    locale: r.locale,
    synonym_type: r.synonym_type,
    ...(r.script ? { script: r.script } : {}),
    taxonomy_node_id: r.taxonomy_node_id,
    source: r.source,
    status: r.status,
  };
}

type Position = { id?: string } | undefined;

@Injectable()
@Operation('admin.synonyms_list')
export class SynonymsListHandler implements OperationHandler {
  async handle(ctx: OperationContext<undefined, { status?: string; locale?: string; limit: number }>): Promise<OperationResult> {
    staffOf(ctx);
    const q = ctx.query;
    const after = (ctx.cursor as Position)?.id;
    const body = await ctx.tx(
      async (scope) => {
        await loadNode(scope, ctx.params.node_id!);
        let s = scope.db
          .selectFrom('taxonomy.taxonomy_synonyms')
          .selectAll()
          .where('taxonomy_node_id', '=', ctx.params.node_id!)
          .where('deleted_at', 'is', null);
        if (q.status) s = s.where('status', '=', q.status);
        if (q.locale) s = s.where('locale', '=', q.locale);
        if (after) s = s.where('id', '>', after);
        const rows = await s
          .orderBy('id')
          .limit(q.limit + 1)
          .execute();
        const page = rows.slice(0, q.limit);
        return ctx.page(page.map(toSynonym), rows.length > q.limit ? { id: page.at(-1)!.id } : null);
      },
      { readOnly: true },
    );
    return { body };
  }
}

type SynonymWrite = { term: string; locale: string; synonym_type: string; script?: string; reason: string };

@Injectable()
@Operation('admin.synonym_create')
export class SynonymCreateHandler implements OperationHandler {
  constructor(private readonly taxonomy: TaxonomyResolver) {}

  async handle(ctx: OperationContext<SynonymWrite>): Promise<OperationResult> {
    staffOf(ctx);
    const b = ctx.body;
    if (b.synonym_type === 'transliteration' && !b.script)
      throw ApiError.validation([{ pointer: '/script', code: 'conditional_required' }]);
    const body = await ctx.tx(async (scope) => {
      const n = await loadNode(scope, ctx.params.node_id!);
      if (n.status === 'merged') throw new ApiError('INVALID_TRANSITION', { detail: 'merged' });
      const row = await scope.db
        .insertInto('taxonomy.taxonomy_synonyms')
        .values({
          taxonomy_node_id: n.id,
          term: b.term,
          locale: b.locale,
          synonym_type: b.synonym_type,
          script: b.script ?? null,
          source: 'manual',
          status: 'active',
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeAudit(scope, {
        action: 'taxonomy.synonym_created',
        entityType: 'taxonomy_synonym',
        entityId: row.id,
        reason: b.reason,
        next: `${b.locale}:${b.term}`,
      });
      scope.afterCommit(() => this.taxonomy.invalidate());
      return toSynonym(row);
    });
    return created(body, `/v1/admin/taxonomy/synonyms/${body.id}`);
  }
}

@Injectable()
@Operation('admin.synonym_decide')
export class SynonymDecideHandler implements OperationHandler {
  constructor(private readonly taxonomy: TaxonomyResolver) {}

  async handle(ctx: OperationContext<{ decision: 'approve' | 'reject'; reason: string }>): Promise<OperationResult> {
    staffOf(ctx);
    const body = await ctx.tx(async (scope) => {
      const r = await loadSynonym(scope, ctx.params.synonym_id!, true);
      if (r.status !== 'pending_review') throw new ApiError('INVALID_TRANSITION', { detail: r.status });
      const row = await scope.db
        .updateTable('taxonomy.taxonomy_synonyms')
        .set({ status: ctx.body.decision === 'approve' ? 'active' : 'inactive' })
        .where('id', '=', r.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeAudit(scope, {
        action: 'taxonomy.synonym_decided',
        entityType: 'taxonomy_synonym',
        entityId: r.id,
        reason: ctx.body.reason,
        previous: r.status,
        next: row.status,
      });
      scope.afterCommit(() => this.taxonomy.invalidate());
      return toSynonym(row);
    });
    return { body };
  }
}

@Injectable()
@Operation('admin.synonym_delete')
export class SynonymDeleteHandler implements OperationHandler {
  constructor(private readonly taxonomy: TaxonomyResolver) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    staffOf(ctx);
    const reason = headerReasonOf(ctx);
    await ctx.tx(async (scope) => {
      const r = await loadSynonym(scope, ctx.params.synonym_id!, true);
      if (r.status === 'inactive') throw new ApiError('NOT_FOUND');
      await scope.db.updateTable('taxonomy.taxonomy_synonyms').set({ status: 'inactive' }).where('id', '=', r.id).execute();
      await writeAudit(scope, {
        action: 'taxonomy.synonym_deactivated',
        entityType: 'taxonomy_synonym',
        entityId: r.id,
        reason,
        previous: r.status,
        next: 'inactive',
      });
      scope.afterCommit(() => this.taxonomy.invalidate());
    });
    return { body: { ok: true } };
  }
}

type MappingRow = Selectable<DB['taxonomy.taxonomy_mappings']>;

function toMapping(m: MappingRow) {
  return {
    id: m.id,
    created_at: iso(m.created_at),
    updated_at: iso(m.updated_at),
    version: m.version,
    source_node_id: m.source_node_id,
    target_node_id: m.target_node_id,
    mapping_type: m.mapping_type,
    weight: m.weight,
    status: m.status,
    source: m.source,
  };
}

@Injectable()
@Operation('admin.mappings_list')
export class MappingsListHandler implements OperationHandler {
  async handle(
    ctx: OperationContext<
      undefined,
      { source_node_id?: string; target_node_id?: string; mapping_type?: string; status?: string; limit: number }
    >,
  ): Promise<OperationResult> {
    staffOf(ctx);
    const q = ctx.query;
    const after = (ctx.cursor as Position)?.id;
    const body = await ctx.tx(
      async (scope) => {
        let s = scope.db.selectFrom('taxonomy.taxonomy_mappings').selectAll().where('deleted_at', 'is', null);
        if (q.source_node_id) s = s.where('source_node_id', '=', q.source_node_id);
        if (q.target_node_id) s = s.where('target_node_id', '=', q.target_node_id);
        if (q.mapping_type) s = s.where('mapping_type', '=', q.mapping_type);
        if (q.status) s = s.where('status', '=', q.status);
        if (after) s = s.where('id', '>', after);
        const rows = await s
          .orderBy('id')
          .limit(q.limit + 1)
          .execute();
        const page = rows.slice(0, q.limit);
        return ctx.page(page.map(toMapping), rows.length > q.limit ? { id: page.at(-1)!.id } : null);
      },
      { readOnly: true },
    );
    return { body };
  }
}

type MappingWrite = {
  source_node_id: string;
  target_node_id: string;
  mapping_type: string;
  weight: number;
  status?: string;
  reason: string;
};

@Injectable()
@Operation('admin.mapping_upsert')
export class MappingUpsertHandler implements OperationHandler {
  constructor(private readonly taxonomy: TaxonomyResolver) {}

  async handle(ctx: OperationContext<MappingWrite>): Promise<OperationResult> {
    staffOf(ctx);
    const b = ctx.body;
    if (b.source_node_id === b.target_node_id) throw ApiError.validation([{ pointer: '/target_node_id', code: 'conditional_forbidden' }]);
    const body = await ctx.tx(async (scope) => {
      for (const [k, id] of [
        ['/source_node_id', b.source_node_id],
        ['/target_node_id', b.target_node_id],
      ] as const)
        await loadNode(scope, id).catch(() =>
          Promise.reject(ApiError.validation([{ pointer: k, code: 'reference_not_found' }], 'REFERENCE_NOT_FOUND')),
        );
      // Node types must fit the mapping type (taxonomy.tg_mapping_types → 422 TAXONOMY_MISMATCH).
      const row = await scope.db
        .insertInto('taxonomy.taxonomy_mappings')
        .values({
          source_node_id: b.source_node_id,
          target_node_id: b.target_node_id,
          mapping_type: b.mapping_type,
          weight: b.weight,
          status: b.status ?? 'active',
          source: 'manual',
        })
        .onConflict((oc) =>
          oc
            .columns(['source_node_id', 'target_node_id', 'mapping_type'])
            .doUpdateSet({ weight: b.weight, ...(b.status ? { status: b.status } : {}), deleted_at: null }),
        )
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeAudit(scope, {
        action: 'taxonomy.mapping_upserted',
        entityType: 'taxonomy_mapping',
        entityId: row.id,
        reason: b.reason,
        next: `${b.mapping_type} ${b.source_node_id} → ${b.target_node_id} weight ${b.weight} ${row.status}`,
      });
      scope.afterCommit(() => this.taxonomy.invalidate());
      return toMapping(row);
    });
    return { body };
  }
}
