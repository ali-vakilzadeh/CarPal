// Minimal dictionary access for server components (P1). The i18next runtime with namespaces, CDN refresh and
// formatting arrives in P3.T2; keys stay the same.
import en from '@carpal/i18n/locales/en.json';
import fa from '@carpal/i18n/locales/fa.json';
import type { Locale } from './locales';

type Dict = typeof en;

/** Dotted keys of the English dictionary (the reference language). */
type Leaves<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];
export type MessageKey = Leaves<Dict>;

const DICTIONARIES: Record<Locale, Dict> = { en, fa };

function lookup(dict: unknown, key: string): string | undefined {
  let node = dict;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

/** Returns a translate function for a locale; falls back to English, then to the key. */
export function getTranslator(locale: Locale): (key: MessageKey) => string {
  const dict = DICTIONARIES[locale];
  return (key) => lookup(dict, key) ?? lookup(en, key) ?? key;
}
