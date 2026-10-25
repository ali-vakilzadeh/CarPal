// Taxonomy for server rendering (P3.T7, BA-32): taxonomy.snapshot pages are cached in memory per (version,
// language, type, parent) and dropped when taxonomy.version changes. The version is an opaque fingerprint
// ("t<base36 ms>-<base36 rows>"), compared for equality only, re-read at most every VERSION_TTL_MS.
import 'server-only';
import type { TaxonomyNode, TaxonomyType } from '@carpal/api-contracts';
import { sortNodes } from '@/lib/config/taxonomy-order';
import type { Locale } from '@/lib/i18n/locales';
import { ssrApi } from './ssr/api';

export const VERSION_TTL_MS = 30_000;
const PAGE_LIMIT = 100;
const MAX_PAGES = 50;
const MAX_ENTRIES = 500;

export interface TaxonomySource {
  version: (locale: Locale) => Promise<string>;
  page: (
    locale: Locale,
    q: { type: TaxonomyType; parent_id?: string; cursor?: string; limit: number },
  ) => Promise<{
    items: TaxonomyNode[];
    next_cursor: string | null;
  }>;
}

export class TaxonomyCache {
  #version: { value: string; at: number } | null = null;
  readonly #nodes = new Map<string, Promise<TaxonomyNode[]>>();

  constructor(
    private readonly source: TaxonomySource,
    private readonly now: () => number = Date.now,
  ) {}

  async version(locale: Locale): Promise<string> {
    const now = this.now();
    if (this.#version && now - this.#version.at < VERSION_TTL_MS) return this.#version.value;
    const value = await this.source.version(locale);
    if (this.#version && this.#version.value !== value) this.#nodes.clear();
    this.#version = { value, at: now };
    return value;
  }

  /** Every active node of a type (under a parent), in the language's order (sort_order, then name). */
  async nodes(locale: Locale, type: TaxonomyType, parentId?: string): Promise<TaxonomyNode[]> {
    const version = await this.version(locale);
    const key = `${version}|${locale}|${type}|${parentId ?? ''}`;
    let entry = this.#nodes.get(key);
    if (!entry) {
      if (this.#nodes.size >= MAX_ENTRIES) this.#nodes.delete(this.#nodes.keys().next().value!);
      entry = this.#load(locale, type, parentId);
      entry.catch(() => this.#nodes.delete(key));
      this.#nodes.set(key, entry);
    }
    return entry;
  }

  async #load(locale: Locale, type: TaxonomyType, parentId?: string): Promise<TaxonomyNode[]> {
    const out: TaxonomyNode[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const page = await this.source.page(locale, {
        type,
        limit: PAGE_LIMIT,
        ...(parentId ? { parent_id: parentId } : {}),
        ...(cursor ? { cursor } : {}),
      });
      out.push(...page.items);
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
    return sortNodes(out.filter((n) => n.status === 'active'));
  }
}

const holder = globalThis as typeof globalThis & { __carpalTaxonomy?: TaxonomyCache };

export function taxonomy(): TaxonomyCache {
  holder.__carpalTaxonomy ??= new TaxonomyCache({
    version: async (locale) => (await ssrApi(locale).api('taxonomy.version')).version,
    page: (locale, query) => ssrApi(locale).api('taxonomy.snapshot', { query }),
  });
  return holder.__carpalTaxonomy;
}
