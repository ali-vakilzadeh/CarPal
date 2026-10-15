// Public interface of the taxonomy module (41 §4.2 interface/): every other
// module resolves NodeId references, labels, synonyms and mappings through
// TaxonomyResolver, never through taxonomy.* tables. The implementation keeps
// the whole public vocabulary (≈700 nodes) in memory and refreshes it when the
// catalog changes (taxonomy.node.merged, admin edits).
import type { TaxonomyType } from '#libs/contract/generated/enums.js';
import type { L10n, Locale } from '#libs/i18n/index.js';
import { sql } from 'kysely';
import type { TxScope } from '#libs/tenancy/index.js';

export interface TaxonomyNodeRecord {
  id: string;
  type: TaxonomyType;
  parentId: string | null;
  nameTranslations: Record<string, string>;
  descriptionTranslations: Record<string, string> | null;
  slug: string;
  regions: string[];
  attributes: Record<string, unknown> | null;
  sortOrder: number;
  status: 'active' | 'inactive' | 'deprecated' | 'merged';
  mergedIntoId: string | null;
}

export interface TaxonomySynonymRecord {
  nodeId: string;
  term: string;
  locale: string;
  synonymType: 'synonym' | 'alias' | 'misspelling' | 'local_term' | 'abbreviation' | 'transliteration';
  script: 'native' | 'latin' | null;
}

export type MappingType = 'symptom_to_system' | 'symptom_to_task' | 'part_category_to_system' | 'task_to_part_category';

export interface TaxonomyMappingRecord {
  sourceId: string;
  targetId: string;
  mappingType: MappingType;
  weight: number;
}

export interface TaxonomyVersionInfo {
  version: string;
  updatedAt: Date;
}

export abstract class TaxonomyResolver {
  /** Any node, including inactive and merged ones. */
  abstract get(id: string): Promise<TaxonomyNodeRecord | null>;
  /**
   * An active node of one of `types` for a request field (40 NodeId<type>,
   * SEC-AZ-4): unknown or inactive → 422 REFERENCE_NOT_FOUND, another type →
   * 422 TAXONOMY_MISMATCH, both with `pointer`.
   */
  abstract require(id: string, types: readonly TaxonomyType[], pointer: string): Promise<TaxonomyNodeRecord>;
  /** Parent chain rule (e.g. model under brand): `ancestorId` must be on the chain of `childId`, else 422 TAXONOMY_MISMATCH. */
  abstract requireDescendant(childId: string, ancestorId: string, pointer: string): Promise<void>;
  /** Ids from the node up to its root (the node first). */
  abstract ancestors(id: string): Promise<string[]>;
  /** The node and every active node below it (category filters include subcategories). */
  abstract descendants(id: string): Promise<string[]>;
  /** Every node and active synonym (search projections and query interpretation, S6). */
  abstract catalog(): Promise<{ nodes: TaxonomyNodeRecord[]; synonyms: TaxonomySynonymRecord[] }>;
  /** Display label in the caller's locale (requested → en → first). */
  abstract labels(ids: readonly string[], locale: Locale): Promise<Map<string, L10n>>;
  /** Follows merged_into_id to the surviving node (stale references after taxonomy.node.merged). */
  abstract canonicalId(id: string): Promise<string | null>;
  abstract synonyms(nodeId: string): Promise<TaxonomySynonymRecord[]>;
  /** Active mappings from a source node, strongest first. */
  abstract mappingsFrom(sourceId: string, type?: MappingType): Promise<TaxonomyMappingRecord[]>;
  abstract version(): Promise<TaxonomyVersionInfo>;
  /** Drops the cache (admin taxonomy changes, taxonomy.node.merged). */
  abstract invalidate(): void;
}

/**
 * Re-pointing of taxonomy references when a node is merged (40
 * admin.taxonomy_merge: "every reference is re-pointed in a background job
 * before the node becomes merged"). Each module owning taxonomy references
 * registers a handler; it runs in the worker's system context and returns the
 * number of rows re-pointed. References a module cannot move (unique
 * constraints) stay on the merged node and resolve through canonicalId().
 */
export type TaxonomyRepointer = (scope: TxScope, fromId: string, intoId: string) => Promise<number>;

export class TaxonomyReferences {
  readonly #handlers = new Map<string, TaxonomyRepointer>();

  register(module: string, handler: TaxonomyRepointer): void {
    if (this.#handlers.has(module)) throw new Error(`taxonomy references of ${module} registered twice`);
    this.#handlers.set(module, handler);
  }

  entries(): [string, TaxonomyRepointer][] {
    return [...this.#handlers.entries()];
  }
}

/** Re-points simple (non-unique) node columns: `UPDATE table SET column = into WHERE column = from`. */
export async function repointColumns(
  scope: TxScope,
  columns: readonly (readonly [table: string, column: string])[],
  fromId: string,
  intoId: string,
): Promise<number> {
  let n = 0;
  for (const [table, column] of columns) {
    const r =
      await sql`UPDATE ${sql.table(table)} SET ${sql.ref(column)} = ${intoId}::uuid WHERE ${sql.ref(column)} = ${fromId}::uuid`.execute(
        scope.db,
      );
    n += Number(r.numAffectedRows ?? 0);
  }
  return n;
}
