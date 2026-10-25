'use client';
// i18n in client components (GD-10): <I18nProvider> gets the namespaces it needs from the server layout (the same,
// possibly CDN-refreshed text the server rendered, so hydration matches), nested <I18nNamespaces> add a feature
// area's namespaces, useT() returns the typed translate function. react-i18next carries the instance, so later
// screens can also use its <Trans> for rich text.
import type { i18n as I18n } from 'i18next';
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { I18nextProvider, useTranslation } from 'react-i18next';
import { addResources, createI18n, translator } from './core';
import type { Resources, Translate } from './keys';
import { directionOf, type Locale } from './locales';

const LocaleContext = createContext<Locale | null>(null);

export function I18nProvider({ locale, resources, children }: { locale: Locale; resources: Resources; children: ReactNode }) {
  // One instance per language; a language switch remounts the [locale] layout with a new locale.
  const [state, setState] = useState(() => ({ locale, instance: createI18n(locale, resources) }));
  let instance: I18n = state.instance;
  if (state.locale !== locale) {
    instance = createI18n(locale, resources);
    setState({ locale, instance });
  } else addResources(instance, locale, resources);
  return (
    <LocaleContext.Provider value={locale}>
      <I18nextProvider i18n={instance}>{children}</I18nextProvider>
    </LocaleContext.Provider>
  );
}

/** Adds a feature area's namespaces below the root provider (e.g. the garage layout adds 'garage'). */
export function I18nNamespaces({ resources, children }: { resources: Resources; children: ReactNode }) {
  const locale = useLocale();
  const { i18n } = useTranslation();
  addResources(i18n, locale, resources);
  return <>{children}</>;
}

export function useLocale(): Locale {
  const locale = useContext(LocaleContext);
  if (!locale) throw new Error('useLocale outside <I18nProvider>');
  return locale;
}

export function useDirection(): 'rtl' | 'ltr' {
  return directionOf(useLocale());
}

export function useT(): Translate {
  const { i18n } = useTranslation();
  return useMemo(() => translator(i18n), [i18n]);
}
