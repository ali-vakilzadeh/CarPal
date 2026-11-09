import { describe, expect, it } from 'vitest';
import { BUNDLED } from '@/lib/i18n/dictionary';
import { SHARED_NAMESPACES as RUNTIME_SHARED } from '@/lib/i18n/keys';
import { SHARED_NAMESPACES, checkDictionaries, consoleDictionary, flatten, placeholders } from './i18n-check';

describe('i18n check (AC1.T4)', () => {
  it('passes for the console dictionaries (admin + shared common/format)', () => {
    expect(checkDictionaries(consoleDictionary('en'), consoleDictionary('fa'))).toEqual([]);
  });

  it('checks exactly what the runtime loads', () => {
    expect([...SHARED_NAMESPACES]).toEqual([...RUNTIME_SHARED]);
    expect(Object.keys(consoleDictionary('en'))).toEqual(Object.keys(BUNDLED.en));
  });

  it('flattens nested keys', () => {
    expect([...flatten({ a: { b: 'x', c: { d: 'y' } } }).keys()]).toEqual(['a.b', 'a.c.d']);
  });

  it('reads {{placeholders}}', () => {
    expect(placeholders('Hi {{ name }}, {{count}} new · {{name}}')).toEqual(['count', 'name']);
  });

  it('reports missing, empty, mismatched and misshapen keys', () => {
    const en = { admin: { a: 'A', b: 'B {{n}}', c: 'C', d: 'D', e: 'E' } };
    const fa = { admin: { a: 'الف', b: 'ب {{m}}', c: ' ', d: { x: 'د' }, extra: 'اضافه' } };
    const problems = checkDictionaries(en, fa).map((p) => `${p.problem}:${p.key}`);
    expect(problems).toEqual(
      expect.arrayContaining([
        'placeholder_mismatch:admin.b',
        'empty:admin.c',
        'shape_mismatch:admin.d',
        'missing_in_fa:admin.e',
        'missing_in_en:admin.extra',
      ]),
    );
  });
});
