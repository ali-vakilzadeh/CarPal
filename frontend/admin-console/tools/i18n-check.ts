// pnpm i18n:check — copied from pwa/tools/i18n-check.ts (admin console GD-05). Checks the console's dictionary: its
// own 'admin' namespace (src/lib/i18n/locales) and the shared namespaces it loads (common, format from shared/i18n).
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

// {{name}} or {{name, format}} (i18next built-in formatters such as 'number').
const PLACEHOLDER = /\{\{\s*([\w.]+)\s*(?:,[^}]*)?\}\}/g;

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

const toolsDir = dirname(fileURLToPath(import.meta.url));
export const SHARED_LOCALES_DIR = join(toolsDir, '..', '..', '..', 'shared', 'i18n', 'locales');
export const ADMIN_LOCALES_DIR = join(toolsDir, '..', 'src', 'lib', 'i18n', 'locales');
/** Shared namespaces the console loads (keep in step with SHARED_NAMESPACES in src/lib/i18n/keys.ts). */
export const SHARED_NAMESPACES = ['common', 'format'] as const;

export function loadDictionary(locale: 'en' | 'fa', dir: string): Dictionary {
  return JSON.parse(readFileSync(join(dir, `${locale}.json`), 'utf8')) as Dictionary;
}

/** The console dictionary of one language: the shared namespaces it uses plus its own. */
export function consoleDictionary(locale: 'en' | 'fa', sharedDir = SHARED_LOCALES_DIR, adminDir = ADMIN_LOCALES_DIR): Dictionary {
  const shared = loadDictionary(locale, sharedDir);
  const picked: Dictionary = {};
  for (const ns of SHARED_NAMESPACES) {
    const value = shared[ns];
    if (value === undefined) throw new Error(`shared/i18n has no namespace ${ns}`);
    picked[ns] = value;
  }
  const own = loadDictionary(locale, adminDir);
  for (const ns of Object.keys(own)) if (ns in picked) throw new Error(`namespace ${ns} is defined in shared/i18n and in the console`);
  return { ...picked, ...own };
}

function main(): void {
  const en = consoleDictionary('en');
  const problems = checkDictionaries(en, consoleDictionary('fa'));
  if (problems.length > 0) {
    console.error(`The console dictionary has ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  ${p.problem}: ${p.key}${p.detail ? ` (${p.detail})` : ''}`);
    process.exit(1);
  }
  console.log(`The console dictionary is complete (${flatten(en).size} keys in en and fa; namespaces ${Object.keys(en).join(', ')}).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
