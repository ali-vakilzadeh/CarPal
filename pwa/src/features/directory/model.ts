// Directory pages (P6.T7, Docs/22 W-PUB-04): /<locale>/<city>/<category>[/<brand>] and /<locale>/<city>/<brand> —
// city = region city_key, category = a service-system slug, brand = a vehicle-brand slug (taxonomy slugs are the
// same in every language, so the hreflang pair differs only in the locale segment). Pure helpers: paths, the index
// rule (open point 6, chosen rule: a page is indexed and listed in the sitemap only with ≥ 3 providers; city ×
// category pages are listed, brand combinations are linked but not listed) and the intro counted from structured data
// (number of shops, verified businesses and verified jobs from the match reasons; no AI-written text).
import type { ResultCard } from '@carpal/api-contracts';
import type { Locale } from '@/lib/i18n/locales';

export const DIRECTORY_MIN_RESULTS = 3;
export const DIRECTORY_LIMIT = 50;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface Facet {
  id: string;
  slug: string;
  name: string;
}

export interface DirectoryFacets {
  city: { key: string; name: string };
  category: Facet | null;
  brand: Facet | null;
  /** A series refinement (?series=<slug>): never indexed, canonical = the brand page. */
  series: (Facet & { modelId: string }) | null;
}

export const isSlug = (v: string | undefined | null): v is string => !!v && v.length <= 80 && SLUG.test(v);

export function directoryPath(locale: Locale, city: string, category?: string | null, brand?: string | null): string {
  const parts = [locale, city, category, brand].filter(Boolean).map((p) => encodeURIComponent(p!));
  return `/${parts.join('/')}`;
}

export function facetsPath(locale: Locale, f: Pick<DirectoryFacets, 'city' | 'category' | 'brand'>): string {
  return directoryPath(locale, f.city.key, f.category?.slug, f.brand?.slug);
}

export function indexable(resultCount: number, f: Pick<DirectoryFacets, 'series'>): boolean {
  return resultCount >= DIRECTORY_MIN_RESULTS && !f.series;
}

export interface DirectoryStats {
  shops: number;
  verified: number;
  jobs: number;
}

/** Counts for the intro: shops in the list, verified businesses, and verified jobs named by the capability reasons. */
export function directoryStats(results: readonly ResultCard[]): DirectoryStats {
  const orgs = new Map<string, { verified: boolean; jobs: number }>();
  for (const r of results) {
    const jobs = Math.max(
      0,
      ...r.reasons
        .filter((x) => x.reason_type === 'capability_evidence')
        .map((x) => (typeof x.values.jobs === 'number' ? x.values.jobs : 0)),
    );
    const prev = orgs.get(r.organization.id);
    orgs.set(r.organization.id, { verified: r.organization.verified, jobs: Math.max(prev?.jobs ?? 0, jobs) });
  }
  let verified = 0;
  let jobs = 0;
  for (const o of orgs.values()) {
    if (o.verified) verified++;
    jobs += o.jobs;
  }
  return { shops: orgs.size, verified, jobs };
}

/** Which heading the page has. */
export function headingKind(f: Pick<DirectoryFacets, 'category' | 'brand'>): 'categoryBrand' | 'category' | 'brand' {
  if (f.category && f.brand) return 'categoryBrand';
  return f.category ? 'category' : 'brand';
}
