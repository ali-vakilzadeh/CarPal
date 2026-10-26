// Page metadata of the public pages (P5.T1, Docs/22 §6): title and description per language, the canonical URL of
// this language, hreflang links to every language plus x-default (the region default, fa), Open Graph / Twitter
// previews (cover or after-photo; never a map image, open point 10) and the index rule. URLs are root-relative;
// metadataBase (the [locale] layout) makes them absolute.
import type { Metadata } from 'next';
import { inLocale } from '@/lib/seo/urls';
import { DEFAULT_LOCALE, LOCALES, type Locale } from '@/lib/i18n/locales';

const OG_LOCALE: Record<Locale, string> = { fa: 'fa_IR', en: 'en_US' };

export interface PageMeta {
  locale: Locale;
  /** This page in this language, e.g. /fa/shop/reza-auto. */
  path: string;
  /** The same page in each language when the path differs by more than the locale segment (localized slugs). */
  alternates?: Partial<Record<Locale, string>>;
  /** Full title (the site name is part of it, e.g. "… | CarPal"). */
  title: string;
  description: string;
  image?: string | null;
  type?: 'website' | 'article';
  /** Docs/22 §6 "Indexed: No" pages and the not-available states. */
  noindex?: boolean;
  siteName: string;
}

/** hreflang map: every language and x-default (the region's default language). */
export function languageAlternates(path: string, alternates: Partial<Record<Locale, string>> = {}): Record<string, string> {
  const byLocale = Object.fromEntries(LOCALES.map((l) => [l, alternates[l] ?? inLocale(path, l)]));
  return { ...byLocale, 'x-default': byLocale[DEFAULT_LOCALE]! };
}

/** Description text for a meta tag: one line, at most 160 characters, cut at a word. */
export function metaDescription(text: string, max = 160): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function pageMetadata(m: PageMeta): Metadata {
  const description = metaDescription(m.description);
  const images = m.image ? [{ url: m.image }] : undefined;
  return {
    title: { absolute: m.title },
    description,
    alternates: { canonical: m.path, languages: languageAlternates(m.path, m.alternates) },
    openGraph: {
      title: m.title,
      description,
      url: m.path,
      siteName: m.siteName,
      locale: OG_LOCALE[m.locale],
      alternateLocale: LOCALES.filter((l) => l !== m.locale).map((l) => OG_LOCALE[l]),
      type: m.type ?? 'website',
      ...(images ? { images } : {}),
    },
    twitter: { card: images ? 'summary_large_image' : 'summary', title: m.title, description, ...(images ? { images } : {}) },
    robots: m.noindex ? { index: false, follow: true } : { index: true, follow: true },
  };
}

/** Metadata of a "not available" state rendered with status 200 (OQ-14): never indexed, no preview. */
export function unavailableMetadata(title: string): Metadata {
  return { title, robots: { index: false, follow: false } };
}
