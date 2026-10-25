// Where the synced design-system files are served (tools/sync-design-system.mjs --public → public/ds).
import type { Locale } from './i18n/locales';

export const DS_STYLESHEETS = ['/ds/tokens.css', '/ds/components/bundle.css'] as const;

/** One variable WOFF2 per script; only the current UI language's face is preloaded (design system "Performance"). */
export const DS_FONT_BY_LOCALE: Record<Locale, string> = {
  fa: '/ds/fonts/Vazirmatn-Arabic-Variable.woff2',
  en: '/ds/fonts/AtkinsonHyperlegibleNext-Latin-Variable.woff2',
};

/** Typography classes of tokens.css per UI language (Persian styles have their own sizes and line heights). */
export function typeClass(locale: Locale, role: 'title' | 'headline' | 'body' | 'label' | 'caption'): string {
  if (locale === 'fa') return `fa-${role}`;
  return { title: 'title-1', headline: 'headline', body: 'body', label: 'label', caption: 'caption' }[role];
}
