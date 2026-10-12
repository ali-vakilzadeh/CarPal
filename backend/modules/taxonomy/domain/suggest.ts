// Typeahead ranking for taxonomy.suggest (40 §11.2): names and synonyms in
// every enabled language, matched after search normalization (52 §2.5:
// digits, Arabic yeh/kaf, ZWNJ, case), so Persian typed with Arabic letters or
// in Latin letters (transliteration synonyms) finds the same nodes. Pure
// functions over an in-memory term index; the catalog builds the index.

export type MatchKind = 'name' | 'synonym' | 'alias' | 'misspelling' | 'local_term' | 'abbreviation' | 'transliteration';

export interface IndexedTerm {
  nodeId: string;
  /** The term as stored (returned as matched_term). */
  term: string;
  /** Normalized and lower-cased form. */
  normalized: string;
  locale: string;
  kind: MatchKind;
}

export interface Suggestion {
  nodeId: string;
  matchedTerm: string;
  kind: MatchKind;
  score: number;
}

const words = (s: string): string[] => s.split(' ').filter(Boolean);

/**
 * Score of one term for a normalized query (0 = no match): exact 100, term
 * prefix 80, every query word a prefix of a term word (in order of the term)
 * 60, substring (queries of 3+ characters) 30. Names beat synonyms on ties and
 * terms in the caller's locale get a small bonus.
 */
export function scoreTerm(query: string, t: IndexedTerm, locale: string): number {
  let s = 0;
  if (t.normalized === query) s = 100;
  else if (t.normalized.startsWith(query)) s = 80;
  else {
    const q = words(query);
    const w = words(t.normalized);
    if (q.length > 0 && q.every((qw) => w.some((tw) => tw.startsWith(qw)))) s = 60;
    else if (query.length >= 3 && t.normalized.includes(query)) s = 30;
  }
  if (s === 0) return 0;
  if (t.kind === 'name') s += 5;
  if (t.locale === locale) s += 3;
  return s;
}

/**
 * Best match per node, highest score first; ties by the node's sort key
 * (sort_order, then term). `accept` filters nodes (type, status, parent).
 */
export function rankSuggestions(
  query: string,
  terms: Iterable<IndexedTerm>,
  locale: string,
  accept: (nodeId: string) => boolean,
  sortKey: (nodeId: string) => number,
  limit: number,
): Suggestion[] {
  if (!query) return [];
  const best = new Map<string, Suggestion>();
  for (const t of terms) {
    const score = scoreTerm(query, t, locale);
    if (score === 0 || !accept(t.nodeId)) continue;
    const prev = best.get(t.nodeId);
    if (!prev || score > prev.score || (score === prev.score && t.term.length < prev.matchedTerm.length))
      best.set(t.nodeId, { nodeId: t.nodeId, matchedTerm: t.term, kind: t.kind, score });
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score || sortKey(a.nodeId) - sortKey(b.nodeId) || a.matchedTerm.localeCompare(b.matchedTerm))
    .slice(0, limit);
}
