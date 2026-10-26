// Data of the directory pages (P6.T7, Docs/22 W-PUB-04): the URL's city, category and brand resolved through the
// region config and the cached taxonomy (slugs; unknown → 404), the ranked list from search.run (providers, the
// chosen city, the category and brand as filters, entry point directory_page; cached 60 s like every public read —
// the cp-ssr token may call search operations, DI-14), 3 related questions while qna.enabled is on, and the series
// of the brand for the refinement chips.
import 'server-only';
import type { PublicQuestion, ResultCard, TaxonomyNode } from '@carpal/api-contracts';
import { DIRECTORY_LIMIT, isSlug, type DirectoryFacets, type Facet } from '@/features/directory/model';
import type { Locale } from '@/lib/i18n/locales';
import { taxonomy } from '@/server/taxonomy';
import type { PageContext } from './page-context';
import { publicList } from './public-reads';

const facet = (n: TaxonomyNode): Facet => ({ id: n.id, slug: n.slug, name: n.name.text });
const RELATED_QUESTIONS = 3;
const RELATED_CATEGORIES = 8;
const POPULAR_BRANDS = 10;

export type Resolved = { kind: 'ok'; facets: DirectoryFacets } | { kind: 'not_found' };

/** /<city>/<facet>[/<brand>] (+ ?series=<slug> on brand pages). */
export async function resolveDirectory(
  ctx: Pick<PageContext, 'locale' | 'region'>,
  citySlug: string,
  facetSlug: string,
  rest: readonly string[],
  seriesSlug?: string | null,
): Promise<Resolved> {
  const city = ctx.region.cities.find((c) => c.city_key === citySlug);
  if (!city || !isSlug(facetSlug) || rest.length > 1 || (rest[0] !== undefined && !isSlug(rest[0]))) return { kind: 'not_found' };
  const [systems, brands] = await Promise.all([
    taxonomy().nodes(ctx.locale, 'service_system'),
    taxonomy().nodes(ctx.locale, 'vehicle_brand'),
  ]);
  const category = systems.find((n) => n.slug === facetSlug && !n.parent_id) ?? null;
  let brand: TaxonomyNode | null = null;
  if (category) {
    if (rest[0]) {
      brand = brands.find((n) => n.slug === rest[0]) ?? null;
      if (!brand) return { kind: 'not_found' };
    }
  } else {
    brand = brands.find((n) => n.slug === facetSlug) ?? null;
    if (!brand || rest.length) return { kind: 'not_found' };
  }
  let series: DirectoryFacets['series'] = null;
  if (brand && isSlug(seriesSlug)) {
    const s = (await brandSeries(ctx.locale, brand.id)).find((n) => n.slug === seriesSlug);
    if (s?.parent_id) series = { ...facet(s), modelId: s.parent_id };
  }
  return {
    kind: 'ok',
    facets: {
      city: { key: city.city_key, name: city.label.text },
      category: category ? facet(category) : null,
      brand: brand ? facet(brand) : null,
      series,
    },
  };
}

/** Every series of a brand (its models' series), in taxonomy order. */
export async function brandSeries(locale: Locale, brandId: string): Promise<TaxonomyNode[]> {
  const models = await taxonomy().nodes(locale, 'vehicle_model', brandId);
  const lists = await Promise.all(models.map((m) => taxonomy().nodes(locale, 'vehicle_series', m.id)));
  return lists.flat();
}

/** The ranked providers of a directory page (first page; up to DIRECTORY_LIMIT). */
export async function directoryResults(locale: Locale, f: DirectoryFacets): Promise<ResultCard[] | null> {
  const res = await publicList(locale, 'search.run', {
    body: {
      search_mode: 'providers',
      entry_point: 'directory_page',
      location: { mode: 'chosen_city', city_key: f.city.key },
      limit: DIRECTORY_LIMIT,
      filters: {
        ...(f.category ? { service_system_node_ids: [f.category.id] } : {}),
        ...(f.brand ? { brand_node_id: f.brand.id } : {}),
        ...(f.series ? { model_node_id: f.series.modelId, series_node_id: f.series.id } : {}),
      },
    },
  });
  return res?.results ?? null;
}

export async function relatedQuestions(locale: Locale, f: DirectoryFacets, enabled: boolean): Promise<PublicQuestion[]> {
  if (!enabled) return [];
  const page = await publicList(locale, 'questions.search', {
    body: {
      ...(f.category ? { category_node_id: f.category.id } : {}),
      ...(f.brand ? { brand_node_id: f.brand.id } : {}),
      limit: RELATED_QUESTIONS,
    },
  });
  return page?.items.slice(0, RELATED_QUESTIONS) ?? [];
}

/** Related links: other top-level categories and popular brands (taxonomy order). */
export async function directoryLinks(locale: Locale, f: DirectoryFacets): Promise<{ categories: Facet[]; brands: Facet[] }> {
  const [systems, brands] = await Promise.all([taxonomy().nodes(locale, 'service_system'), taxonomy().nodes(locale, 'vehicle_brand')]);
  return {
    categories: systems
      .filter((n) => !n.parent_id && n.id !== f.category?.id)
      .slice(0, RELATED_CATEGORIES)
      .map(facet),
    brands: brands
      .filter((n) => n.id !== f.brand?.id)
      .slice(0, POPULAR_BRANDS)
      .map(facet),
  };
}
