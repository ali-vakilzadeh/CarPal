// L18 safety check (41 §2.2; 52 §7; 40 SEC-BF-8, SEC-AI-7): the rule-based
// safety keyword check runs on the server for search text and request text;
// a client cannot suppress the flag and AI cannot lower the urgency. Terms
// come from the taxonomy (safety_critical symptom nodes and their synonyms,
// S3) through SafetyLexicon; matching uses the shared search normalization.
import { normalizeSearchText } from '#libs/i18n/index.js';

export type Urgency = 'low' | 'medium' | 'high' | 'critical';

export interface SafetyTerm {
  /** Normalized with normalizeSearchText (as taxonomy_synonyms.term_normalized). */
  termNormalized: string;
  /** Symptom node the term belongs to. */
  nodeId: string;
  urgency: Urgency;
}

export interface SafetyResult {
  safety_flag: boolean;
  urgency: Urgency | null;
  matched_node_ids: string[];
}

export abstract class SafetyLexicon {
  abstract terms(): Promise<SafetyTerm[]>;
}

/** Until the taxonomy module provides the lexicon (S3): no terms. */
export class EmptySafetyLexicon extends SafetyLexicon {
  async terms(): Promise<SafetyTerm[]> {
    return [];
  }
}

const RANK: Record<Urgency, number> = { low: 1, medium: 2, high: 3, critical: 4 };

export class SafetyCheck {
  constructor(
    private readonly lexicon: SafetyLexicon,
    private readonly dbLocale = 'C',
  ) {}

  async check(text: string): Promise<SafetyResult> {
    const haystack = ` ${normalizeSearchText(text, { dbLocale: this.dbLocale })} `;
    const matched = new Map<string, Urgency>();
    for (const t of await this.lexicon.terms()) {
      // Whole-word (or whole-phrase) match on the normalized, space-separated text.
      if (t.termNormalized && haystack.includes(` ${t.termNormalized} `)) {
        const prev = matched.get(t.nodeId);
        if (!prev || RANK[t.urgency] > RANK[prev]) matched.set(t.nodeId, t.urgency);
      }
    }
    let urgency: Urgency | null = null;
    for (const u of matched.values()) if (!urgency || RANK[u] > RANK[urgency]) urgency = u;
    return { safety_flag: matched.size > 0, urgency, matched_node_ids: [...matched.keys()] };
  }

  /** SEC-AI-7: AI may raise but never lower the rule-based urgency. */
  static merge(ruleBased: Urgency | null, ai: Urgency | null): Urgency | null {
    if (!ruleBased) return ai;
    if (!ai) return ruleBased;
    return RANK[ai] > RANK[ruleBased] ? ai : ruleBased;
  }
}
