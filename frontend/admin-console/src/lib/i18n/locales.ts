// UI locales of the console (GD-05): EN and FA with full RTL, no locale segment in URLs (internal app, no SEO).
// The language comes from the cpa_locale cookie (from AC4 on: the staff member's me.locale, switchable in the avatar
// menu), else Accept-Language, else the deployment default (OQ-06 default: fa). The cookie name differs from the
// PWA's cp_locale because cookies on localhost are shared across ports in development.
export const LOCALES = ['fa', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'fa';
export const LOCALE_COOKIE = 'cpa_locale';
/** Request header the proxy sets with the negotiated locale for server components. */
export const LOCALE_HEADER = 'x-carpal-locale';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

export function directionOf(locale: Locale): 'rtl' | 'ltr' {
  return locale === 'fa' ? 'rtl' : 'ltr';
}

/** Picks the UI locale: the remembered cookie, else the best Accept-Language match, else the fallback. */
export function negotiateLocale(
  acceptLanguage: string | null | undefined,
  cookie?: string | null,
  fallback: Locale = DEFAULT_LOCALE,
): Locale {
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
  return ranked.map((x) => x.lang).find(isLocale) ?? fallback;
}
