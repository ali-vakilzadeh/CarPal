// UI locales (GD-10). The pilot region config (shared/region-config/ir-pilot.json) lists fa and en with fa as
// default; locales.test.ts keeps these constants in step with it until config.client drives them (P3).
export const LOCALES = ['fa', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'fa';
/** Remembers the last UI language a visitor used, so "/" sends them back to it. */
export const LOCALE_COOKIE = 'cp_locale';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

export function directionOf(locale: Locale): 'rtl' | 'ltr' {
  return locale === 'fa' ? 'rtl' : 'ltr';
}

/** Picks the UI locale: the remembered cookie, else the best Accept-Language match, else the region default. */
export function negotiateLocale(acceptLanguage: string | null | undefined, cookie?: string | null): Locale {
  if (isLocale(cookie)) return cookie;
  const ranked = (acceptLanguage ?? '')
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const quality = q ? Number(q.slice(2)) : 1;
      return { lang: tag.toLowerCase().split('-')[0] ?? '', quality: Number.isFinite(quality) ? quality : 0, index };
    })
    .filter((x) => x.lang && x.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index);
  return ranked.map((x) => x.lang).find(isLocale) ?? DEFAULT_LOCALE;
}
