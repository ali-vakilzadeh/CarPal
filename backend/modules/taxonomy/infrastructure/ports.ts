// Platform ports served by the taxonomy catalog: NodeId<type> checks of the
// request pipeline (L2), the safety lexicon of the shared safety check (L18,
// 52 §7) and the taxonomy version shown by config.client (§22).
import { Injectable } from '@nestjs/common';
import type { CarpalConfig } from '#libs/config/index.js';
import { NodeTypeChecker, type NodeRef } from '#libs/http-pipeline/index.js';
import { normalizeSearchText } from '#libs/i18n/index.js';
import { TaxonomyVersion } from '#libs/platform/index.js';
import { InjectConfig } from '#libs/runtime/index.js';
import { SafetyLexicon, type SafetyTerm } from '#libs/safety-check/index.js';
import { SAFETY_KEYWORDS } from '../domain/safety-keywords.js';
import { TaxonomyCatalog } from './catalog.js';

@Injectable()
export class CatalogNodeTypeChecker extends NodeTypeChecker {
  constructor(private readonly catalog: TaxonomyCatalog) {
    super();
  }

  check(refs: NodeRef[]): Promise<void> {
    return this.catalog.checkRefs(refs);
  }
}

@Injectable()
export class CatalogTaxonomyVersion extends TaxonomyVersion {
  constructor(private readonly catalog: TaxonomyCatalog) {
    super();
  }

  async current(): Promise<string> {
    return (await this.catalog.version()).version;
  }
}

/**
 * Safety lexicon (52 §7, Docs/44 safety_check): the names (every locale) and
 * active synonyms of symptom nodes with attributes.safety_critical = true,
 * plus the safety keyword list. Every term flags urgency safety_critical.
 * Terms are normalized exactly as SafetyCheck normalizes the text.
 */
@Injectable()
export class CatalogSafetyLexicon extends SafetyLexicon {
  #cache: { fingerprint: string; terms: SafetyTerm[] } | null = null;

  constructor(
    private readonly catalog: TaxonomyCatalog,
    @InjectConfig() private readonly config: CarpalConfig,
  ) {
    super();
  }

  async terms(): Promise<SafetyTerm[]> {
    const data = await this.catalog.data();
    if (this.#cache?.fingerprint === data.fingerprint) return this.#cache.terms;
    const norm = (t: string) => normalizeSearchText(t, { dbLocale: this.config.db.locale });
    const terms = new Map<string, SafetyTerm>();
    const add = (term: string, nodeId: string) => {
      const termNormalized = norm(term);
      if (termNormalized) terms.set(`${termNormalized}|${nodeId}`, { termNormalized, nodeId, urgency: 'safety_critical' });
    };
    for (const n of data.nodes.values()) {
      if (n.type !== 'symptom' || n.status !== 'active' || n.attributes?.safety_critical !== true) continue;
      for (const name of Object.values(n.nameTranslations)) add(name, n.id);
      for (const s of data.synonyms.get(n.id) ?? []) add(s.term, n.id);
    }
    for (const k of SAFETY_KEYWORDS) {
      const id = data.byKey.get(k.symptom);
      if (id) add(k.term, id);
    }
    this.#cache = { fingerprint: data.fingerprint, terms: [...terms.values()] };
    return this.#cache.terms;
  }
}
