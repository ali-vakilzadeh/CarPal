// pnpm i18n:check — checks the shared UI dictionary (GD-10, Docs/02 §3.1).
// Fails when an English key is missing in Persian (or the other way round), when a value is empty or not a
// string, or when the {{placeholders}} of a key differ between the languages.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Dictionary = { [key: string]: string | Dictionary };

export interface I18nProblem {
  key: string;
  problem: 'missing_in_fa' | 'missing_in_en' | 'empty' | 'not_a_string' | 'placeholder_mismatch' | 'shape_mismatch';
  detail?: string;
}

/** Flattens a nested dictionary into dotted keys. Non-string leaves are kept so they can be reported. */
export function flatten(dict: Dictionary, prefix = ''): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [k, v] of Object.entries(dict)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      for (const [ck, cv] of flatten(v, key)) out.set(ck, cv);
    } else out.set(key, v);
  }
  return out;
}

const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;

export function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1] ?? ''))].sort();
}

export function checkDictionaries(en: Dictionary, fa: Dictionary): I18nProblem[] {
  const problems: I18nProblem[] = [];
  const enFlat = flatten(en);
  const faFlat = flatten(fa);
  for (const [lang, flat] of [
    ['en', enFlat],
    ['fa', faFlat],
  ] as const) {
    for (const [key, value] of flat) {
      if (typeof value !== 'string') problems.push({ key, problem: 'not_a_string', detail: lang });
      else if (value.trim() === '') problems.push({ key, problem: 'empty', detail: lang });
    }
  }
  for (const [key, value] of enFlat) {
    if (!faFlat.has(key)) {
      // A key that is a leaf in one language and a group in the other.
      const isGroupInFa = [...faFlat.keys()].some((k) => k.startsWith(`${key}.`));
      problems.push({ key, problem: isGroupInFa ? 'shape_mismatch' : 'missing_in_fa' });
      continue;
    }
    const faValue = faFlat.get(key);
    if (typeof value === 'string' && typeof faValue === 'string') {
      const a = placeholders(value).join(',');
      const b = placeholders(faValue).join(',');
      if (a !== b) problems.push({ key, problem: 'placeholder_mismatch', detail: `en {${a}} vs fa {${b}}` });
    }
  }
  for (const key of faFlat.keys()) {
    if (!enFlat.has(key) && ![...enFlat.keys()].some((k) => k.startsWith(`${key}.`))) problems.push({ key, problem: 'missing_in_en' });
  }
  return problems;
}

export const LOCALES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'shared', 'i18n', 'locales');

export function loadDictionary(locale: 'en' | 'fa', dir = LOCALES_DIR): Dictionary {
  return JSON.parse(readFileSync(join(dir, `${locale}.json`), 'utf8')) as Dictionary;
}

function main(): void {
  const problems = checkDictionaries(loadDictionary('en'), loadDictionary('fa'));
  if (problems.length > 0) {
    console.error(`shared/i18n has ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  ${p.problem}: ${p.key}${p.detail ? ` (${p.detail})` : ''}`);
    process.exit(1);
  }
  console.log(`shared/i18n is complete (${flatten(loadDictionary('en')).size} keys in en and fa).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
