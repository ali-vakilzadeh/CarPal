import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { taxonomyCatalog } from '#tools/db/config.js';
import { SAFETY_KEYWORDS } from './safety-keywords.js';
import { rankSuggestions, scoreTerm, type IndexedTerm } from './suggest.js';

describe('safety keyword list', () => {
  it('mirrors Docs/44 safety_check.keywords exactly', () => {
    const catalog = JSON.parse(readFileSync(taxonomyCatalog, 'utf8')) as { safety_check: { keywords: unknown[] } };
    expect(SAFETY_KEYWORDS).toEqual(catalog.safety_check.keywords);
  });
});

describe('suggest ranking', () => {
  const t = (nodeId: string, term: string, kind: IndexedTerm['kind'] = 'name', locale = 'en'): IndexedTerm => ({
    nodeId,
    term,
    normalized: term.toLowerCase(),
    locale,
    kind,
  });

  it('scores exact > prefix > word prefix > substring, names over synonyms, caller locale bonus', () => {
    expect(scoreTerm('brake', t('a', 'Brake'), 'en')).toBe(108);
    expect(scoreTerm('bra', t('a', 'Brake pads'), 'en')).toBe(88);
    expect(scoreTerm('pad', t('a', 'Brake pads'), 'en')).toBe(68);
    expect(scoreTerm('ake', t('a', 'Brake pads'), 'en')).toBe(38);
    expect(scoreTerm('ak', t('a', 'Brake pads'), 'en')).toBe(0);
    expect(scoreTerm('bra', t('a', 'Brake', 'synonym'), 'en')).toBe(83);
    expect(scoreTerm('bra', t('a', 'Brake', 'name', 'fa'), 'en')).toBe(85);
  });

  it('keeps the best term per node, filters, sorts by score then sort key, and limits', () => {
    const terms = [t('a', 'Brake disc'), t('a', 'brakes', 'synonym'), t('b', 'Brake'), t('c', 'Brake fluid'), t('d', 'Brake pad')];
    const out = rankSuggestions(
      'brake',
      terms,
      'en',
      (id) => id !== 'c',
      (id) => ({ a: 2, b: 9, d: 1 })[id] ?? 0,
      2,
    );
    expect(out.map((s) => s.nodeId)).toEqual(['b', 'd']);
    expect(
      rankSuggestions(
        '',
        terms,
        'en',
        () => true,
        () => 0,
        10,
      ),
    ).toEqual([]);
  });
});
