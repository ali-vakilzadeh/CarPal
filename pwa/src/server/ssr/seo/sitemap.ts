// Sitemaps (P5.T1): /sitemap.xml is an index of /sitemaps/<kind>.xml (pages, shops, parts-sellers, parts, showcases).
// The contract has no "list every public organization" read, so the URLs come from public reads only (DI-37): a
// search per pilot city (providers, vendors) → shop and parts-seller pages; each provider's portfolio → showcases;
// each vendor's part categories (public.org_get coverage) → a first page of parts per category and language. Every
// collection has a call budget (the cp-ssr bucket, DI-26) and is cached for SITEMAP_TTL_MS. Each URL lists its
// language versions (xhtml:link hreflang) as Google's sitemap guide asks.
import 'server-only';
import type { PublicOrgCard, ResultCard } from '@carpal/api-contracts';
import { LOCALES, DEFAULT_LOCALE, type Locale } from '@/lib/i18n/locales';
import { partPath, sellerPath, shopPath, showcasePath } from '@/lib/seo/urls';
import { loadClientConfig } from '@/server/config';
import { ssrApi } from '../api';

export const SITEMAP_KINDS = ['pages', 'shops', 'parts-sellers', 'parts', 'showcases'] as const;
export type SitemapKind = (typeof SITEMAP_KINDS)[number];
export const isSitemapKind = (v: string): v is SitemapKind => (SITEMAP_KINDS as readonly string[]).includes(v);

export const SITEMAP_TTL_MS = 6 * 60 * 60_000;
const SEARCH_PAGES_PER_CITY = 3;
const MAX_PORTFOLIO_READS = 100;
const MAX_VENDOR_READS = 50;
const MAX_PART_SEARCHES = 40; // per language

/** One page in every language. */
export interface SitemapEntry {
  paths: Record<Locale, string>;
  lastModified?: string;
  images?: string[];
}

const xml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export function urlsetXml(origin: string, entries: readonly SitemapEntry[]): string {
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">',
  ];
  for (const e of entries) {
    const links = [
      ...LOCALES.map((l) => `<xhtml:link rel="alternate" hreflang="${l}" href="${xml(origin + e.paths[l])}"/>`),
      `<xhtml:link rel="alternate" hreflang="x-default" href="${xml(origin + e.paths[DEFAULT_LOCALE])}"/>`,
    ].join('');
    for (const l of LOCALES) {
      out.push(
        `<url><loc>${xml(origin + e.paths[l])}</loc>${links}` +
          (e.lastModified ? `<lastmod>${xml(e.lastModified)}</lastmod>` : '') +
          (e.images ?? []).map((src) => `<image:image><image:loc>${xml(src)}</image:loc></image:image>`).join('') +
          '</url>',
      );
    }
  }
  out.push('</urlset>');
  return out.join('\n');
}

export function sitemapIndexXml(origin: string, kinds: readonly SitemapKind[] = SITEMAP_KINDS): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...kinds.map((k) => `<sitemap><loc>${xml(`${origin}/sitemaps/${k}.xml`)}</loc></sitemap>`),
    '</sitemapindex>',
  ].join('\n');
}

const both = (path: (l: Locale) => string): Record<Locale, string> =>
  Object.fromEntries(LOCALES.map((l) => [l, path(l)])) as Record<Locale, string>;

/** The static public pages. */
export function staticEntries(): SitemapEntry[] {
  return [{ paths: both((l) => `/${l}`) }, { paths: both((l) => `/${l}/how-ranking-works`) }];
}

interface Collected {
  providers: PublicOrgCard[];
  vendors: PublicOrgCard[];
}

/** Published organizations found by a search per pilot city (deduplicated). */
async function collectOrgs(): Promise<Collected> {
  const api = ssrApi(DEFAULT_LOCALE);
  const { config } = await loadClientConfig(DEFAULT_LOCALE);
  const found = { providers: new Map<string, PublicOrgCard>(), vendors: new Map<string, PublicOrgCard>() };
  for (const city of config.region.cities) {
    for (const mode of ['providers', 'vendors'] as const) {
      try {
        const first = await api.api('search.run', {
          body: { search_mode: mode, entry_point: 'directory_page', location: { mode: 'chosen_city', city_key: city.city_key }, limit: 50 },
        });
        let results: ResultCard[] = first.results;
        let cursor = first.next_cursor;
        for (let page = 1; cursor && page < SEARCH_PAGES_PER_CITY; page++) {
          const next = await api.api('search.page', { path: { session_id: first.session_id }, query: { cursor } });
          results = results.concat(next.items);
          cursor = next.next_cursor;
        }
        for (const r of results) {
          const o = r.organization;
          if (!o.slug) continue;
          if (o.roles.includes('provider')) found.providers.set(o.id, o);
          if (o.roles.includes('vendor')) found.vendors.set(o.id, o);
        }
      } catch (err) {
        console.warn(`sitemap: search in ${city.city_key} (${mode}) failed`, err);
      }
    }
  }
  return { providers: [...found.providers.values()], vendors: [...found.vendors.values()] };
}

async function showcaseEntries(providers: readonly PublicOrgCard[]): Promise<SitemapEntry[]> {
  const api = ssrApi(DEFAULT_LOCALE);
  const entries: SitemapEntry[] = [];
  for (const org of providers.slice(0, MAX_PORTFOLIO_READS)) {
    try {
      const page = await api.api('public.org_portfolio', { path: { org_id: org.id }, query: { limit: 50 } });
      for (const item of page.items) {
        const images = item.media.filter((m) => m.role === 'after' && m.url).map((m) => m.url!);
        entries.push({ paths: both((l) => showcasePath(l, item.id, item.title)), lastModified: item.published_at, images });
      }
    } catch (err) {
      console.warn('sitemap: portfolio read failed', err);
    }
  }
  return entries;
}

async function partEntries(vendors: readonly PublicOrgCard[]): Promise<SitemapEntry[]> {
  const byItem = new Map<string, Partial<Record<Locale, string>>>();
  const categories = new Map<string, string[]>();
  for (const org of vendors.slice(0, MAX_VENDOR_READS)) {
    try {
      const profile = await ssrApi(DEFAULT_LOCALE).api('public.org_get', { path: { slug: org.slug! } });
      const ids = (profile.vendor?.coverage ?? []).filter((c) => c.coverage_type === 'part_category').map((c) => c.node_id);
      if (ids.length) categories.set(org.id, ids);
    } catch (err) {
      console.warn('sitemap: vendor read failed', err);
    }
  }
  for (const locale of LOCALES) {
    let budget = MAX_PART_SEARCHES;
    for (const org of vendors) {
      for (const category of categories.get(org.id) ?? []) {
        if (budget-- <= 0) break;
        try {
          const page = await ssrApi(locale).api('public.org_inventory_search', {
            path: { org_id: org.id },
            body: { part_category_node_id: category, limit: 50 },
          });
          for (const item of page.items) {
            const paths = byItem.get(item.id) ?? {};
            paths[locale] = partPath(locale, org.slug!, item.id, item.name.text);
            byItem.set(item.id, paths);
          }
        } catch (err) {
          console.warn('sitemap: inventory search failed', err);
        }
      }
    }
  }
  return [...byItem.values()].filter((p): p is Record<Locale, string> => LOCALES.every((l) => p[l])).map((paths) => ({ paths }));
}

/** Builds each kind at most once per SITEMAP_TTL_MS; organizations are collected once for all kinds. */
export class SitemapSource {
  #orgs: { at: number; value: Promise<Collected> } | null = null;
  readonly #kinds = new Map<SitemapKind, { at: number; value: Promise<SitemapEntry[]> }>();

  constructor(private readonly now: () => number = Date.now) {}

  #collected(): Promise<Collected> {
    const now = this.now();
    if (!this.#orgs || now - this.#orgs.at >= SITEMAP_TTL_MS) {
      const value = collectOrgs();
      value.catch(() => (this.#orgs = null));
      this.#orgs = { at: now, value };
    }
    return this.#orgs.value;
  }

  entries(kind: SitemapKind): Promise<SitemapEntry[]> {
    const now = this.now();
    const hit = this.#kinds.get(kind);
    if (hit && now - hit.at < SITEMAP_TTL_MS) return hit.value;
    const value = this.#build(kind);
    value.catch(() => this.#kinds.delete(kind));
    this.#kinds.set(kind, { at: now, value });
    return value;
  }

  async #build(kind: SitemapKind): Promise<SitemapEntry[]> {
    if (kind === 'pages') return staticEntries();
    const { providers, vendors } = await this.#collected();
    if (kind === 'shops') return providers.map((o) => ({ paths: both((l) => shopPath(l, o.slug!)) }));
    if (kind === 'parts-sellers') return vendors.map((o) => ({ paths: both((l) => sellerPath(l, o.slug!)) }));
    if (kind === 'showcases') return showcaseEntries(providers);
    return partEntries(vendors);
  }
}

export const sitemaps = new SitemapSource();
