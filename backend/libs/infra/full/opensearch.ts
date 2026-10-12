// Full-mode SearchIndex (GD-04, S6.T1): Elasticsearch / OpenSearch over its
// REST API with fetch. Written to the same port as the lite index but NOT
// verified yet (no cluster on this machine, OQ-01): before use, run the
// discovery integration tests against docker compose. Documents are stored
// as sent plus a "_text" object per analyzed field (platform analyzer
// tokens joined by spaces, indexed with a whitespace analyzer), so text
// matching uses the same normalization as lite mode; geo fields are mapped
// as geo_point by the index template (infrastructure/docker/opensearch).
import { searchTokens } from '#libs/i18n/index.js';
import type { SearchDocument, SearchFilter, SearchHit, SearchIndex, SearchQuery } from '../ports.js';

type Json = Record<string, unknown>;

/** String values under a value (translations objects and arrays included), never the keys. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const e of v) strings(e, out);
  else if (v && typeof v === 'object') for (const e of Object.values(v)) strings(e, out);
  return out;
}

function filterDsl(f: SearchFilter): Json {
  if ('not' in f) return { bool: { must_not: [filterDsl(f.not)] } };
  if ('any' in f) return { bool: { should: f.any.map(filterDsl), minimum_should_match: 1 } };
  if ('eq' in f) return { term: { [f.field]: f.eq } };
  if ('in' in f) return { terms: { [f.field]: f.in } };
  if ('all' in f) return { bool: { filter: f.all.map((v) => ({ term: { [f.field]: v } })) } };
  if ('exists' in f) return f.exists ? { exists: { field: f.field } } : { bool: { must_not: [{ exists: { field: f.field } }] } };
  return { range: { [f.field]: { ...(f.gte !== undefined ? { gte: f.gte } : {}), ...(f.lte !== undefined ? { lte: f.lte } : {}) } } };
}

export class OpenSearchIndex implements SearchIndex {
  constructor(
    private readonly baseUrl: string,
    private readonly prefix = 'carpal_',
  ) {}

  async #call(method: string, path: string, body?: unknown): Promise<Json> {
    const res = await fetch(`${this.baseUrl}/${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok && res.status !== 404) throw new Error(`search ${method} ${path}: ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
    return res.status === 404 ? {} : json;
  }

  #name(index: string): string {
    return `${this.prefix}${index}`;
  }

  async upsert(index: string, id: string, document: SearchDocument): Promise<void> {
    const text: Record<string, string> = {};
    for (const [k, v] of Object.entries(document)) {
      const values = strings(v);
      if (values.length) text[k] = values.flatMap(searchTokens).join(' ');
    }
    await this.#call('PUT', `${this.#name(index)}/_doc/${encodeURIComponent(id)}?refresh=wait_for`, { ...document, _text: text });
  }

  async remove(index: string, id: string): Promise<void> {
    await this.#call('DELETE', `${this.#name(index)}/_doc/${encodeURIComponent(id)}?refresh=wait_for`);
  }

  async removeWhere(index: string, filters: readonly SearchFilter[]): Promise<number> {
    const r = await this.#call('POST', `${this.#name(index)}/_delete_by_query?refresh=true`, {
      query: { bool: { filter: filters.map(filterDsl) } },
    });
    return Number(r.deleted ?? 0);
  }

  async get(index: string, id: string): Promise<SearchDocument | null> {
    const r = await this.#call('GET', `${this.#name(index)}/_doc/${encodeURIComponent(id)}`);
    if (!r.found) return null;
    const { _text: _, ...source } = r._source as Json;
    return source;
  }

  async search(index: string, q: SearchQuery): Promise<{ hits: SearchHit[]; total: number }> {
    const must: Json[] = [];
    if (q.text) {
      const tokens = searchTokens(q.text.query);
      if (tokens.length)
        must.push({
          multi_match: {
            query: tokens.join(' '),
            fields: Object.entries(q.text.fields).map(([f, boost]) => `_text.${f}^${boost}`),
            operator: (q.text.operator ?? 'all') === 'all' ? 'and' : 'or',
            ...((q.text.fuzzy ?? true) ? { fuzziness: 'AUTO:5,8', prefix_length: 1 } : {}),
          },
        });
    }
    const filter: Json[] = (q.filters ?? []).map(filterDsl);
    const g = q.geo;
    if (g?.bbox)
      filter.push({
        geo_bounding_box: {
          [g.field]: { top_left: { lat: g.bbox.north, lon: g.bbox.west }, bottom_right: { lat: g.bbox.south, lon: g.bbox.east } },
        },
      });
    if (g?.origin && g.radiusKm !== undefined && !g.pointRadiusField)
      filter.push({ geo_distance: { distance: `${g.radiusKm}km`, [g.field]: { lat: g.origin.lat, lon: g.origin.lng } } });
    const body: Json = {
      size: Math.min(q.size ?? 100, 1000),
      track_total_hits: true,
      query: { bool: { must, filter } },
      sort: [
        '_score',
        ...(g?.origin ? [{ _geo_distance: { [g.field]: { lat: g.origin.lat, lon: g.origin.lng }, order: 'asc', unit: 'km' } }] : []),
        { _id: 'asc' },
      ],
    };
    const r = await this.#call('POST', `${this.#name(index)}/_search`, body);
    const hits = ((r.hits as Json | undefined)?.hits as Json[] | undefined) ?? [];
    return {
      total: Number(((r.hits as Json | undefined)?.total as Json | undefined)?.value ?? hits.length),
      hits: hits.map((h) => {
        const { _text: _, ...source } = h._source as Json;
        const sort = h.sort as unknown[] | undefined;
        return {
          id: String(h._id),
          score: Number(h._score ?? 0),
          source,
          distanceKm: g?.origin && sort ? Number(sort[1]) : null,
        };
      }),
    };
  }

  async count(index: string): Promise<number> {
    return Number((await this.#call('GET', `${this.#name(index)}/_count`)).count ?? 0);
  }

  async ids(index: string): Promise<string[]> {
    const r = await this.#call('POST', `${this.#name(index)}/_search`, { size: 10_000, _source: false, query: { match_all: {} } });
    return (((r.hits as Json | undefined)?.hits as Json[] | undefined) ?? []).map((h) => String(h._id));
  }
}
