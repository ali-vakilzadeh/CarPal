// The bundled dictionaries for server code and tests: the shared namespaces of shared/i18n plus the console's 'admin'
// namespace. Client code never imports this module (it would bundle both languages): it gets its namespaces from
// <I18nProvider>. No CDN refresh here (unlike the PWA): the console ships its text with each deploy.
import sharedEn from '@carpal/i18n/locales/en.json';
import sharedFa from '@carpal/i18n/locales/fa.json';
import { createI18n, translator } from './core';
import { SHARED_NAMESPACES, type Dictionary, type Namespace, type Resources, type Translate } from './keys';
import type { Locale } from './locales';
import adminEn from './locales/en.json';
import adminFa from './locales/fa.json';

export type { Dictionary, MessageKey, MessageVars, Namespace, Resources, Translate } from './keys';

function compose(shared: typeof sharedEn, admin: typeof adminEn): Dictionary {
  const picked = Object.fromEntries(SHARED_NAMESPACES.map((ns) => [ns, shared[ns]])) as Pick<
    typeof sharedEn,
    (typeof SHARED_NAMESPACES)[number]
  >;
  return { ...picked, ...admin };
}

// The Persian files have the same shape (pnpm i18n:check); the casts only drop the literal string types.
export const BUNDLED: Record<Locale, Dictionary> = {
  en: compose(sharedEn, adminEn),
  fa: compose(sharedFa as unknown as typeof sharedEn, adminFa as unknown as typeof adminEn),
};
export const NAMESPACES = Object.keys(BUNDLED.en) as Namespace[];

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
export function pickNamespaces(dict: Dictionary, namespaces: readonly Namespace[] = NAMESPACES): Resources {
  return Object.fromEntries(namespaces.map((ns) => [ns, dict[ns]])) as Resources;
}
