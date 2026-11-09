// Copied from pwa/src/lib/i18n/core.ts (admin console GD-05).
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

/** The label of an enum value this build does not know (TR-3, P13.T5). */
export const UNKNOWN_VALUE_KEY = 'common.unknownValue';

/**
 * A typed translate function over "<namespace>.<path>" keys. A missing key answers the key itself (visible in
 * development and tests), except a missing value in a group of value labels — `appointments.status.<status>` where
 * `appointments.status` is an object — which is an enum value from a newer server and reads "Unknown" (Appendix C).
 */
export function translator(instance: I18n): Translate {
  const t = instance.t.bind(instance) as unknown as (key: string, options: Record<string, unknown>) => string;
  const translate = (key: MessageKey, vars?: MessageVars): string => {
    const dot = key.indexOf('.');
    const ns = key.slice(0, dot) as Namespace;
    const path = key.slice(dot + 1);
    if (!instance.exists(path, { ns, ...(typeof vars?.count === 'number' ? { count: vars.count } : {}) })) {
      const last = path.lastIndexOf('.');
      const group = last > 0 ? instance.getResource(instance.language, ns, path.slice(0, last)) : undefined;
      if (key !== UNKNOWN_VALUE_KEY && /^[a-z][a-z0-9_]*$/.test(path.slice(last + 1)) && group && typeof group === 'object')
        return translate(UNKNOWN_VALUE_KEY as MessageKey);
      return key;
    }
    return t(path, { ns, ...vars });
  };
  return translate;
}
