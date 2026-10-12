// Taxonomy operations (40 §11.2): version, snapshot, node_get, suggest. All
// public (PUB); version, snapshot and node reads are cacheable (40 §1.4).
import { Injectable } from '@nestjs/common';
import { ApiError } from '#libs/contract/index.js';
import type { TaxonomyType } from '#libs/contract/generated/enums.js';
import { iso, Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import { toTaxonomyNode } from '../api/projections.js';
import { rankSuggestions } from '../domain/suggest.js';
import { TaxonomyCatalog } from '../infrastructure/catalog.js';

const SNAPSHOT_MAX_AGE_S = 3600;

@Injectable()
@Operation('taxonomy.version')
export class TaxonomyVersionHandler implements OperationHandler {
  constructor(private readonly catalog: TaxonomyCatalog) {}

  async handle(): Promise<OperationResult> {
    const v = await this.catalog.version();
    return { body: { version: v.version, updated_at: iso(v.updatedAt) }, cache: { public: 300 } };
  }
}

type SnapshotQuery = {
  type: TaxonomyType;
  parent_id?: string;
  region?: string;
  limit: number;
};

@Injectable()
@Operation('taxonomy.snapshot')
export class TaxonomySnapshotHandler implements OperationHandler {
  constructor(private readonly catalog: TaxonomyCatalog) {}

  async handle(ctx: OperationContext<undefined, SnapshotQuery>): Promise<OperationResult> {
    const q = ctx.query;
    const data = await this.catalog.data();
    const nodes = [...data.nodes.values()]
      .filter(
        (n) =>
          n.status === 'active' &&
          n.type === q.type &&
          (q.parent_id === undefined || n.parentId === q.parent_id) &&
          (q.region === undefined || n.regions.length === 0 || n.regions.includes(q.region)),
      )
      .sort((a, b) => a.sortOrder - b.sortOrder || a.slug.localeCompare(b.slug) || a.id.localeCompare(b.id));
    const offset = typeof (ctx.cursor as { o?: unknown } | undefined)?.o === 'number' ? (ctx.cursor as { o: number }).o : 0;
    const items = nodes.slice(offset, offset + q.limit).map((n) => toTaxonomyNode(n, ctx.locale));
    const next = offset + q.limit < nodes.length ? { o: offset + q.limit } : null;
    return {
      body: ctx.page(items, next),
      // Versioned by the catalog version (40 §11.2): clients revalidate when taxonomy.version changes.
      headers: { etag: `"${data.version.version}"` },
      cache: { public: SNAPSHOT_MAX_AGE_S },
      contentLanguage: ctx.locale,
    };
  }
}

@Injectable()
@Operation('taxonomy.node_get')
export class TaxonomyNodeGetHandler implements OperationHandler {
  constructor(private readonly catalog: TaxonomyCatalog) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    // Merged and inactive nodes are returned too, so stale references can be followed (merged_into_id).
    const node = await this.catalog.get(ctx.params.node_id!);
    if (!node) throw new ApiError('NOT_FOUND');
    return { body: toTaxonomyNode(node, ctx.locale), cache: { public: SNAPSHOT_MAX_AGE_S }, contentLanguage: ctx.locale };
  }
}

interface SuggestBody {
  text: string;
  types: TaxonomyType[];
  parent_id?: string;
}

@Injectable()
@Operation('taxonomy.suggest')
export class TaxonomySuggestHandler implements OperationHandler {
  constructor(private readonly catalog: TaxonomyCatalog) {}

  async handle(ctx: OperationContext<SuggestBody>): Promise<OperationResult> {
    const { text, types, parent_id: parentId } = ctx.body;
    const data = await this.catalog.data();
    const typeSet = new Set(types);
    const underParent = (id: string): boolean => {
      // The parent filter accepts any node below the parent (series under a brand).
      let cur = data.nodes.get(id);
      for (let i = 0; cur?.parentId && i < 32; i++) {
        if (cur.parentId === parentId) return true;
        cur = data.nodes.get(cur.parentId);
      }
      return false;
    };
    const ranked = rankSuggestions(
      this.catalog.normalize(text),
      data.terms,
      ctx.locale,
      (id) => {
        const n = data.nodes.get(id);
        return !!n && n.status === 'active' && typeSet.has(n.type) && (parentId === undefined || underParent(id));
      },
      (id) => data.nodes.get(id)?.sortOrder ?? 0,
      10,
    );
    return {
      body: {
        items: ranked.map((s) => ({
          node: toTaxonomyNode(data.nodes.get(s.nodeId)!, ctx.locale),
          matched_term: s.matchedTerm.slice(0, 120),
          match_kind: s.kind,
        })),
      },
      contentLanguage: ctx.locale,
    };
  }
}
