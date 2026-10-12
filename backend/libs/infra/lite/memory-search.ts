// Lite SearchIndex (GD-04, S6.T1): the 52 §10 projections in memory, per
// process. Text fields are analyzed with the platform analyzer (libs/i18n
// searchTokens: search normalization, so Persian typed with Arabic letters,
// Persian/Arabic digits and ZWNJ variants give the same tokens); matching is
// exact, prefix (tokens of 3+ characters) or one edit (tokens of 5+
// characters), the typo tolerance and partial matching of Plan WP8. Geo
// queries take a point or a list of points per document (radius, per-point
// service radius, bbox). Filters follow Elasticsearch term semantics: a
// field holding an array matches when any element does.
import { searchTokens } from '#libs/i18n/index.js';
import type {
  SearchDocument,
  SearchFilter,
  SearchGeo,
  SearchHit,
  SearchIndex,
  SearchPoint,
  SearchQuery,
  SearchScalar,
  SearchText,
} from '../ports.js';

interface Stored {
  id: string;
  source: SearchDocument;
  /** Analyzed tokens per text field, built lazily per field. */
  tokens: Map<string, string[]>;
}

const EXACT = 1;
const PREFIX = 0.7;
const TYPO = 0.5;
const EARTH_RADIUS_KM = 6_371.0088;

/** Values at a dotted path; arrays are flattened at every level. */
export function valuesAt(doc: unknown, path: string): unknown[] {
  let current: unknown[] = [doc];
  for (const key of path.split('.')) {
    const next: unknown[] = [];
    for (const v of current) {
      if (Array.isArray(v)) {
        for (const e of v) if (e && typeof e === 'object') next.push((e as Record<string, unknown>)[key]);
      } else if (v && typeof v === 'object') next.push((v as Record<string, unknown>)[key]);
    }
    current = next.flatMap((v) => (Array.isArray(v) ? v : [v])).filter((v) => v !== undefined && v !== null);
  }
  return current;
}

/** Strings under a value (translations objects and arrays included). */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (typeof v === 'number') out.push(String(v));
  else if (Array.isArray(v)) for (const e of v) strings(e, out);
  else if (v && typeof v === 'object') for (const e of Object.values(v)) strings(e, out);
  return out;
}

/** At most one insertion, deletion or substitution between a and b. */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (la > lb) i++;
    else if (lb > la) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (la - i) + (lb - j) <= 1;
}

/** Best match of one query token against a field's tokens (0 = none). */
export function tokenMatch(q: string, tokens: readonly string[], fuzzy: boolean): number {
  let best = 0;
  for (const t of tokens) {
    if (t === q) return EXACT;
    if (!fuzzy) continue;
    if (q.length >= 3 && t.startsWith(q)) best = Math.max(best, PREFIX);
    else if (q.length >= 5 && t.length >= 5 && withinOneEdit(q, t)) best = Math.max(best, TYPO);
  }
  return best;
}

const rad = (d: number): number => (d * Math.PI) / 180;
export function haversineKm(a: SearchPoint, b: SearchPoint): number {
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

const isPoint = (v: unknown): v is SearchPoint =>
  !!v && typeof v === 'object' && typeof (v as SearchPoint).lat === 'number' && typeof (v as SearchPoint).lng === 'number';

const compare = (a: unknown, b: number | string): number =>
  typeof b === 'number' ? Number(a) - b : String(a) < b ? -1 : String(a) > b ? 1 : 0;

export function matchesFilter(doc: SearchDocument, f: SearchFilter): boolean {
  if ('not' in f) return !matchesFilter(doc, f.not);
  if ('any' in f) return f.any.some((g) => matchesFilter(doc, g));
  const values = valuesAt(doc, f.field);
  if ('eq' in f) return values.some((v) => v === f.eq);
  if ('in' in f) return values.some((v) => f.in.includes(v as SearchScalar));
  if ('all' in f) return f.all.every((x) => values.includes(x));
  if ('exists' in f) return f.exists === values.length > 0;
  return values.some((v) => (f.gte === undefined || compare(v, f.gte) >= 0) && (f.lte === undefined || compare(v, f.lte) <= 0) && v !== '');
}

export class MemorySearchIndex implements SearchIndex {
  readonly #indices = new Map<string, Map<string, Stored>>();

  #index(name: string): Map<string, Stored> {
    let m = this.#indices.get(name);
    if (!m) this.#indices.set(name, (m = new Map()));
    return m;
  }

  async upsert(index: string, id: string, document: SearchDocument): Promise<void> {
    // A structured copy: later changes to the caller's object never leak into the index.
    this.#index(index).set(id, { id, source: structuredClone(document), tokens: new Map() });
  }

  async remove(index: string, id: string): Promise<void> {
    this.#index(index).delete(id);
  }

  async removeWhere(index: string, filters: readonly SearchFilter[]): Promise<number> {
    const m = this.#index(index);
    let n = 0;
    for (const [id, d] of m)
      if (filters.every((f) => matchesFilter(d.source, f))) {
        m.delete(id);
        n++;
      }
    return n;
  }

  async get(index: string, id: string): Promise<SearchDocument | null> {
    const d = this.#index(index).get(id);
    return d ? structuredClone(d.source) : null;
  }

  async count(index: string): Promise<number> {
    return this.#index(index).size;
  }

  async ids(index: string): Promise<string[]> {
    return [...this.#index(index).keys()];
  }

  #tokens(d: Stored, field: string): string[] {
    let t = d.tokens.get(field);
    if (!t) d.tokens.set(field, (t = [...new Set(strings(valuesAt(d.source, field)).flatMap(searchTokens))]));
    return t;
  }

  #text(d: Stored, text: SearchText, queryTokens: string[]): number {
    const fuzzy = text.fuzzy ?? true;
    let total = 0;
    let matched = 0;
    for (const q of queryTokens) {
      let best = 0;
      for (const [field, boost] of Object.entries(text.fields)) best = Math.max(best, tokenMatch(q, this.#tokens(d, field), fuzzy) * boost);
      if (best > 0) matched++;
      total += best;
    }
    if (matched === 0) return 0;
    if ((text.operator ?? 'all') === 'all' && matched < queryTokens.length) return 0;
    return total;
  }

  /** Distance to the nearest matching point, or null when the document is outside the geo restriction. */
  #geo(d: Stored, geo: SearchGeo): { ok: boolean; distanceKm: number | null } {
    const holders = valuesAt(d.source, geo.field.includes('.') ? geo.field.slice(0, geo.field.lastIndexOf('.')) : geo.field);
    const pointKey = geo.field.includes('.') ? geo.field.slice(geo.field.lastIndexOf('.') + 1) : null;
    const entries = holders
      .map((h) => ({ point: pointKey ? (h as Record<string, unknown>)[pointKey] : h, holder: h as Record<string, unknown> }))
      .filter((e): e is { point: SearchPoint; holder: Record<string, unknown> } => isPoint(e.point));
    let nearest: number | null = null;
    let ok = false;
    for (const { point, holder } of entries) {
      const b = geo.bbox;
      if (b && !(point.lat >= b.south && point.lat <= b.north && point.lng >= b.west && point.lng <= b.east)) continue;
      const dist = geo.origin ? haversineKm(geo.origin, point) : null;
      if (geo.radiusKm !== undefined && dist !== null) {
        const own = geo.pointRadiusField ? Number(holder[geo.pointRadiusField] ?? 0) : 0;
        if (dist > Math.max(geo.radiusKm, own)) continue;
      }
      ok = true;
      if (dist !== null && (nearest === null || dist < nearest)) nearest = dist;
    }
    return { ok, distanceKm: nearest };
  }

  async search(index: string, query: SearchQuery): Promise<{ hits: SearchHit[]; total: number }> {
    const size = Math.min(Math.max(query.size ?? 100, 0), 1000);
    const queryTokens = query.text ? [...new Set(searchTokens(query.text.query))] : [];
    const hits: SearchHit[] = [];
    for (const d of this.#index(index).values()) {
      if (query.filters && !query.filters.every((f) => matchesFilter(d.source, f))) continue;
      let score = 0;
      if (query.text && queryTokens.length) {
        score = this.#text(d, query.text, queryTokens);
        if (score === 0) continue;
      }
      let distanceKm: number | null = null;
      if (query.geo) {
        const g = this.#geo(d, query.geo);
        if (!g.ok) continue;
        distanceKm = g.distanceKm;
      }
      hits.push({ id: d.id, score, source: d.source, distanceKm });
    }
    hits.sort(
      (a, b) => b.score - a.score || (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    return { hits: hits.slice(0, size).map((h) => ({ ...h, source: structuredClone(h.source) })), total: hits.length };
  }
}
