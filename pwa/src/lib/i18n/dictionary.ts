// The bundled dictionaries (shared/i18n, the fallback copy of Docs/02 §3.1) for server code and tests. Server
// components normally use serverI18n() (src/server/i18n.ts), which applies a newer CDN version when config.client
// announces one; getTranslator() stays for synchronous callers and always reads the bundled copy. Client code never
// imports this module (it would bundle every language): it gets its namespaces from <I18nProvider>.
import en from '@carpal/i18n/locales/en.json';
import fa from '@carpal/i18n/locales/fa.json';
import { createI18n, translator } from './core';
import type { Dictionary, Namespace, Resources, Translate } from './keys';
import type { Locale } from './locales';

export type { Dictionary, MessageKey, MessageVars, Namespace, Resources, Translate } from './keys';

export const BUNDLED: Record<Locale, Dictionary> = { en, fa };
export const NAMESPACES = Object.keys(en) as Namespace[];

const cache = new Map<Locale, Translate>();

/** Translate function over the bundled dictionary of a locale. */
export function getTranslator(locale: Locale): Translate {
  let t = cache.get(locale);
  if (!t) {
    t = translator(createI18n(locale, BUNDLED[locale]));
    cache.set(locale, t);
  }
  return t;
}

/** The given namespaces of a dictionary (what a client provider receives). */
export function pickNamespaces(dict: Dictionary, namespaces: readonly Namespace[]): Resources {
  return Object.fromEntries(namespaces.map((ns) => [ns, dict[ns]])) as Resources;
}

type Tree = { [key: string]: string | Tree };

/**
 * A newer dictionary laid over the bundled one: string leaves of `update` replace or add, everything else keeps
 * the bundled value, so a partial or older CDN file never removes a key the code uses.
 */
export function mergeDictionary(base: Dictionary, update: unknown): Dictionary {
  const walk = (b: Tree, u: unknown): Tree => {
    if (u === null || typeof u !== 'object' || Array.isArray(u)) return b;
    const out: Tree = { ...b };
    for (const [k, v] of Object.entries(u as Record<string, unknown>)) {
      const current = b[k];
      if (typeof v === 'string' && v.trim() !== '' && (current === undefined || typeof current === 'string')) out[k] = v;
      else if (v !== null && typeof v === 'object' && (current === undefined || typeof current === 'object'))
        out[k] = walk((current as Tree | undefined) ?? {}, v);
    }
    return out;
  };
  return walk(base as unknown as Tree, update) as unknown as Dictionary;
}
