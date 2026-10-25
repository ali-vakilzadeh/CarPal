import { describe, expect, it } from 'vitest';
import { checkDictionaries, flatten, loadDictionary, placeholders } from './i18n-check';

describe('i18n check', () => {
  it('passes for the shared dictionaries', () => {
    expect(checkDictionaries(loadDictionary('en'), loadDictionary('fa'))).toEqual([]);
  });

  it('flattens nested keys', () => {
    expect([...flatten({ a: { b: 'x', c: { d: 'y' } } }).keys()]).toEqual(['a.b', 'a.c.d']);
  });

  it('reads {{placeholders}}', () => {
    expect(placeholders('Hi {{ name }}, {{count}} new · {{name}}')).toEqual(['count', 'name']);
    expect(placeholders('{{count, number}} open · {{ when , datetime }}')).toEqual(['count', 'when']);
  });

  it('reports missing, empty, mismatched and misshapen keys', () => {
    const en = { common: { a: 'A', b: 'B {{n}}', c: 'C', d: 'D', e: 'E' } };
    const fa = { common: { a: 'الف', b: 'ب {{m}}', c: ' ', d: { x: 'د' }, extra: 'اضافه' } };
    const problems = checkDictionaries(en, fa).map((p) => `${p.problem}:${p.key}`);
    expect(problems).toEqual(
      expect.arrayContaining([
        'placeholder_mismatch:common.b',
        'empty:common.c',
        'shape_mismatch:common.d',
        'missing_in_fa:common.e',
        'missing_in_en:common.extra',
      ]),
    );
  });
});
