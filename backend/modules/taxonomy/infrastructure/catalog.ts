// In-memory taxonomy catalog (41 §2.1 M4 "served and cached for every other
// module"). The public vocabulary is small (≈700 nodes, 300 synonyms, 740
// mappings), so each process keeps all of it: reads never hit the database.
// Freshness: a fingerprint (row counts and newest updated_at per table) is
// re-checked at most every CARPAL_TAXONOMY_REFRESH_MS, and the cache is
// dropped at once on taxonomy.node.merged (each process subscribes with its
// own consumer name, so every process hears the event).
import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { sql } from 'kysely';
import type { CarpalConfig } from '#libs/config/index.js';
import { ApiError, type FieldError } from '#libs/contract/index.js';
import type { TaxonomyType } from '#libs/contract/generated/enums.js';
import { uuidv7 } from '#libs/crypto/index.js';
import { textArray } from '#libs/db/index.js';
import { l10n, normalizeSearchText, type L10n, type Locale } from '#libs/i18n/index.js';
import type { Infra } from '#libs/infra/index.js';
import type { Logger } from '#libs/observability/index.js';
import { HOST, InjectConfig, InjectInfra, InjectLogger } from '#libs/runtime/index.js';
import { TxRunner } from '#libs/tenancy/index.js';
import type { IndexedTerm } from '../domain/suggest.js';
import {
  TaxonomyResolver,
  type MappingType,
  type TaxonomyMappingRecord,
  type TaxonomyNodeRecord,
  type TaxonomySynonymRecord,
  type TaxonomyVersionInfo,
} from '../interface/taxonomy-resolver.js';

export interface CatalogData {
  nodes: Map<string, TaxonomyNodeRecord>;
  /** Catalog key "type:slug" → id (root-unique in the launch catalog; first wins otherwise). */
  byKey: Map<string, string>;
  synonyms: Map<string, TaxonomySynonymRecord[]>;
  mappings: Map<string, TaxonomyMappingRecord[]>;
  /** Names (every locale) and active synonyms, normalized for typeahead. */
  terms: IndexedTerm[];
  version: TaxonomyVersionInfo;
  fingerprint: string;
}

interface Fingerprint {
  key: string;
  newest: Date;
  rows: number;
}

@Injectable()
export class TaxonomyCatalog extends TaxonomyResolver implements OnApplicationBootstrap, OnApplicationShutdown {
  #data: CatalogData | null = null;
  #checkedAt = 0;
  #loading: Promise<CatalogData> | null = null;
  #unsubscribe: (() => void) | null = null;

  constructor(
    private readonly tx: TxRunner,
    @InjectConfig() private readonly config: CarpalConfig,
    @InjectInfra() private readonly infra: Infra,
    @InjectLogger() private readonly logger: Logger,
    @Inject(HOST) private readonly host: string,
  ) {
    super();
  }

  onApplicationBootstrap(): void {
    try {
      this.#unsubscribe = this.infra.bus.subscribe({
        // One consumer per process context: every process drops its own cache.
        consumer: `taxonomy.cache.${this.host}.${uuidv7()}`,
        subjects: ['taxonomy.node.merged'],
        handler: async () => this.invalidate(),
      });
    } catch (err) {
      this.logger.warn({ err }, 'taxonomy cache: no event subscription (cache refreshes by fingerprint only)');
    }
  }

  onApplicationShutdown(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  invalidate(): void {
    this.#data = null;
    this.#checkedAt = 0;
  }

  /** Normalization of typeahead terms and queries (52 §2.5 + Unicode lower case). */
  normalize(text: string): string {
    return normalizeSearchText(text, { dbLocale: this.config.db.locale }).toLowerCase();
  }

  async data(): Promise<CatalogData> {
    const now = Date.now();
    if (this.#data && now - this.#checkedAt < this.config.taxonomyRefreshMs) return this.#data;
    if (this.#loading) return this.#loading;
    this.#loading = (async () => {
      try {
        const fp = await this.#fingerprint();
        this.#checkedAt = Date.now();
        if (!this.#data || this.#data.fingerprint !== fp.key) this.#data = await this.#load(fp);
        return this.#data;
      } finally {
        this.#loading = null;
      }
    })();
    return this.#loading;
  }

  async #fingerprint(): Promise<Fingerprint> {
    const row = await this.tx.run(
      { actorType: 'anonymous' },
      async ({ db }) => {
        const { rows } = await sql<{ n: string; nu: Date | null; s: string; su: Date | null; m: string; mu: Date | null }>`
          SELECT (SELECT count(*) FROM taxonomy.taxonomy_nodes) AS n, (SELECT max(updated_at) FROM taxonomy.taxonomy_nodes) AS nu,
                 (SELECT count(*) FROM taxonomy.taxonomy_synonyms) AS s, (SELECT max(updated_at) FROM taxonomy.taxonomy_synonyms) AS su,
                 (SELECT count(*) FROM taxonomy.taxonomy_mappings) AS m, (SELECT max(updated_at) FROM taxonomy.taxonomy_mappings) AS mu`.execute(
          db,
        );
        return rows[0]!;
      },
      { readOnly: true },
    );
    const times = [row.nu, row.su, row.mu].filter((d): d is Date => d != null).map((d) => new Date(d).getTime());
    const newest = new Date(times.length ? Math.max(...times) : 0);
    const rows = Number(row.n) + Number(row.s) + Number(row.m);
    return { key: `${row.n}/${row.s}/${row.m}/${newest.getTime()}`, newest, rows };
  }

  async #load(fp: Fingerprint): Promise<CatalogData> {
    const { nodes, synonyms, mappings } = await this.tx.run(
      { actorType: 'anonymous' },
      async ({ db }) => ({
        nodes: await db
          .selectFrom('taxonomy.taxonomy_nodes')
          .select([
            'id',
            'type',
            'parent_id',
            'name_translations',
            'description_translations',
            'slug',
            'regions',
            'attributes',
            'sort_order',
            'status',
            'merged_into_id',
          ])
          .where('deleted_at', 'is', null)
          .execute(),
        synonyms: await db
          .selectFrom('taxonomy.taxonomy_synonyms')
          .select(['taxonomy_node_id', 'term', 'locale', 'synonym_type', 'script'])
          .where('status', '=', 'active')
          .where('deleted_at', 'is', null)
          .execute(),
        mappings: await db
          .selectFrom('taxonomy.taxonomy_mappings')
          .select(['source_node_id', 'target_node_id', 'mapping_type', 'weight'])
          .where('status', '=', 'active')
          .where('deleted_at', 'is', null)
          .execute(),
      }),
      { readOnly: true },
    );
    const data: CatalogData = {
      nodes: new Map(),
      byKey: new Map(),
      synonyms: new Map(),
      mappings: new Map(),
      terms: [],
      version: { version: `t${fp.newest.getTime().toString(36)}-${fp.rows.toString(36)}`, updatedAt: fp.newest },
      fingerprint: fp.key,
    };
    for (const n of nodes) {
      const attrs = (n.attributes as Record<string, unknown> | null) ?? null;
      const record: TaxonomyNodeRecord = {
        id: n.id,
        type: n.type as TaxonomyType,
        parentId: n.parent_id,
        nameTranslations: n.name_translations as Record<string, string>,
        descriptionTranslations: (n.description_translations as Record<string, string> | null) ?? null,
        slug: n.slug,
        regions: textArray(n.regions),
        attributes: attrs && Object.keys(attrs).length > 0 ? attrs : null,
        sortOrder: n.sort_order,
        status: n.status as TaxonomyNodeRecord['status'],
        mergedIntoId: n.merged_into_id,
      };
      data.nodes.set(n.id, record);
      const key = `${record.type}:${record.slug}`;
      if (!data.byKey.has(key)) data.byKey.set(key, n.id);
      for (const [locale, text] of Object.entries(record.nameTranslations))
        if (text) data.terms.push({ nodeId: n.id, term: text, normalized: this.normalize(text), locale, kind: 'name' });
    }
    for (const s of synonyms) {
      const rec: TaxonomySynonymRecord = {
        nodeId: s.taxonomy_node_id,
        term: s.term,
        locale: s.locale,
        synonymType: s.synonym_type as TaxonomySynonymRecord['synonymType'],
        script: (s.script as TaxonomySynonymRecord['script']) ?? null,
      };
      data.synonyms.set(rec.nodeId, [...(data.synonyms.get(rec.nodeId) ?? []), rec]);
      data.terms.push({
        nodeId: rec.nodeId,
        term: rec.term,
        normalized: this.normalize(rec.term),
        locale: rec.locale,
        kind: rec.synonymType,
      });
    }
    for (const m of mappings) {
      const rec: TaxonomyMappingRecord = {
        sourceId: m.source_node_id,
        targetId: m.target_node_id,
        mappingType: m.mapping_type as MappingType,
        weight: m.weight,
      };
      data.mappings.set(rec.sourceId, [...(data.mappings.get(rec.sourceId) ?? []), rec]);
    }
    for (const list of data.mappings.values()) list.sort((a, b) => b.weight - a.weight);
    this.logger.debug({ nodes: data.nodes.size, synonyms: synonyms.length, version: data.version.version }, 'taxonomy catalog loaded');
    return data;
  }

  // ------------------------------------------------------------ TaxonomyResolver

  async get(id: string): Promise<TaxonomyNodeRecord | null> {
    return (await this.data()).nodes.get(id) ?? null;
  }

  async require(id: string, types: readonly TaxonomyType[], pointer: string): Promise<TaxonomyNodeRecord> {
    const node = await this.get(id);
    if (!node || node.status !== 'active') throw ApiError.validation([{ pointer, code: 'reference_not_found' }], 'REFERENCE_NOT_FOUND');
    if (!types.includes(node.type)) throw ApiError.validation([{ pointer, code: 'enum' }], 'TAXONOMY_MISMATCH');
    return node;
  }

  async requireDescendant(childId: string, ancestorId: string, pointer: string): Promise<void> {
    const chain = await this.ancestors(childId);
    if (!chain.slice(1).includes(ancestorId)) throw ApiError.validation([{ pointer, code: 'reference_not_found' }], 'TAXONOMY_MISMATCH');
  }

  async ancestors(id: string): Promise<string[]> {
    const { nodes } = await this.data();
    const out: string[] = [];
    let cur = nodes.get(id);
    while (cur && out.length < 32 && !out.includes(cur.id)) {
      out.push(cur.id);
      cur = cur.parentId ? nodes.get(cur.parentId) : undefined;
    }
    return out;
  }

  async labels(ids: readonly string[], locale: Locale): Promise<Map<string, L10n>> {
    const { nodes } = await this.data();
    const out = new Map<string, L10n>();
    for (const id of ids) {
      const n = nodes.get(id);
      const label = n ? l10n(n.nameTranslations, locale) : null;
      if (label) out.set(id, label);
    }
    return out;
  }

  async canonicalId(id: string): Promise<string | null> {
    const { nodes } = await this.data();
    let cur = nodes.get(id);
    for (let i = 0; cur && cur.status === 'merged' && cur.mergedIntoId && i < 16; i++) cur = nodes.get(cur.mergedIntoId);
    return cur?.id ?? null;
  }

  async synonyms(nodeId: string): Promise<TaxonomySynonymRecord[]> {
    return (await this.data()).synonyms.get(nodeId) ?? [];
  }

  async mappingsFrom(sourceId: string, type?: MappingType): Promise<TaxonomyMappingRecord[]> {
    const list = (await this.data()).mappings.get(sourceId) ?? [];
    return type ? list.filter((m) => m.mappingType === type) : list;
  }

  async version(): Promise<TaxonomyVersionInfo> {
    return (await this.data()).version;
  }

  /** NodeId<type> checks of a request body (NodeTypeChecker): all problems in one 422. */
  async checkRefs(refs: { pointer: string; id: string; types: string[] }[]): Promise<void> {
    const { nodes } = await this.data();
    const missing: FieldError[] = [];
    const mismatched: FieldError[] = [];
    for (const r of refs) {
      const n = nodes.get(r.id);
      if (!n || n.status !== 'active') missing.push({ pointer: r.pointer, code: 'reference_not_found' });
      else if (!r.types.includes(n.type)) mismatched.push({ pointer: r.pointer, code: 'enum' });
    }
    if (mismatched.length) throw ApiError.validation([...mismatched, ...missing], 'TAXONOMY_MISMATCH');
    if (missing.length) throw ApiError.validation(missing, 'REFERENCE_NOT_FOUND');
  }
}
