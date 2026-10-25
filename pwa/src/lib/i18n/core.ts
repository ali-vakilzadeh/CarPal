// The i18next instance used on the server and in the browser (GD-10). Nothing here imports the dictionaries: the
// server passes in the whole (possibly CDN-refreshed) dictionary, the browser only the namespaces its client
// components need, so the client bundle carries no translations of its own.
import { createInstance, type i18n as I18n } from 'i18next';
import type { Locale } from './locales';
import type { MessageKey, MessageVars, Namespace, Resources, Translate } from './keys';

export function createI18n(locale: Locale, resources: Resources): I18n {
  const instance = createInstance();
  void instance.init({
    lng: locale,
    fallbackLng: false,
    supportedLngs: [locale],
    resources: { [locale]: resources as Record<string, object> },
    ns: Object.keys(resources),
    defaultNS: false,
    initAsync: false,
    // Text is rendered by React (as text), never as HTML (GD-15).
    interpolation: { escapeValue: false },
    returnNull: false,
    returnEmptyString: false,
  });
  return instance;
}

/** Adds namespaces to a running instance (nested providers of feature areas). */
export function addResources(instance: I18n, locale: Locale, resources: Resources): void {
  for (const [ns, data] of Object.entries(resources)) {
    if (data && !instance.hasResourceBundle(locale, ns)) instance.addResourceBundle(locale, ns, data, true, false);
  }
}

/** A typed translate function over "<namespace>.<path>" keys. */
export function translator(instance: I18n): Translate {
  const t = instance.t.bind(instance) as unknown as (key: string, options: Record<string, unknown>) => string;
  return (key: MessageKey, vars?: MessageVars) => {
    const dot = key.indexOf('.');
    const ns = key.slice(0, dot) as Namespace;
    const path = key.slice(dot + 1);
    if (!instance.exists(path, { ns, ...(typeof vars?.count === 'number' ? { count: vars.count } : {}) })) return key;
    return t(path, { ns, ...vars });
  };
}
