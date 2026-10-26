// Public page URLs (Docs/22 §6 URL map, DI-13): shops and parts sellers by organization slug, parts and showcases by
// "<id>-<slug>". The slug part of an id segment is decorative: pages look records up by id and redirect a wrong or
// missing slug to the canonical one, so a renamed item keeps its old links working. Free text never goes into a query
// string (GD-14); these paths carry only ids and slugs the records already publish.
import type { PublicOrgCard } from '@carpal/api-contracts';
import type { Locale } from '@/lib/i18n/locales';

const MAX_SLUG = 60;

/** A URL slug from a title or name: letters and digits of any script, lower-cased, words joined by '-'. */
export function slugify(text: string): string {
  const words = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‌‍]/g, '') // Persian zero-width joiners join a word, they do not split it
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  let slug = '';
  for (const w of words) {
    const next = slug ? `${slug}-${w}` : w;
    if (next.length > MAX_SLUG) break;
    slug = next;
  }
  return slug;
}

/** "<id>-<slug>", or the id alone when the text has no letters or digits. */
export function idSlug(id: string, text: string): string {
  const slug = slugify(text);
  return slug ? `${id}-${slug}` : id;
}

// UUIDv7 ids as the backend issues them (8-4-4-4-12 hex).
const ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-(.*))?$/i;

/** Splits "<id>-<slug>" (the slug may be missing); null when the segment does not start with an id. */
export function parseIdSlug(segment: string): { id: string; slug: string } | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  const m = ID.exec(decoded);
  return m ? { id: m[1]!.toLowerCase(), slug: m[2] ?? '' } : null;
}

export const shopPath = (locale: Locale, slug: string) => `/${locale}/shop/${encodeURIComponent(slug)}`;
export const sellerPath = (locale: Locale, slug: string) => `/${locale}/parts-seller/${encodeURIComponent(slug)}`;
export const partPath = (locale: Locale, vendorSlug: string, itemId: string, name: string) =>
  `/${locale}/parts/${encodeURIComponent(vendorSlug)}/${encodeURIComponent(idSlug(itemId, name))}`;
export const showcasePath = (locale: Locale, itemId: string, title: string) =>
  `/${locale}/post/${encodeURIComponent(idSlug(itemId, title))}`;

/** The public profile of an organization card: the shop page for providers (and hybrids), else the parts-seller page. */
export function orgPath(locale: Locale, org: Pick<PublicOrgCard, 'slug' | 'roles'>): string | null {
  if (!org.slug) return null;
  return org.roles.includes('provider') ? shopPath(locale, org.slug) : sellerPath(locale, org.slug);
}

/** The same page in another language: swaps the locale segment. */
export function inLocale(path: string, locale: Locale): string {
  return path.replace(/^\/[a-z]{2}(?=\/|$)/, `/${locale}`);
}
