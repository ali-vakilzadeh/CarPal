// Search projections (52 §10, S6.T1/T2): the five documents of the search
// index, built from the owning modules' interfaces in the worker's system
// context and written through the SearchIndex port. Only published and
// approved content and public/trade_only inventory is indexed; price_trade
// and private notes never are; locations carry the public point only
// (SEC-OUT-4). Text is analyzed by the index (libs/i18n searchTokens).
import { Injectable, Optional } from '@nestjs/common';
import type { Infra, SearchDocument } from '#libs/infra/index.js';
import type { Logger } from '#libs/observability/index.js';
import { InjectInfra, InjectLogger } from '#libs/runtime/index.js';
import { searchTokens } from '#libs/i18n/index.js';
import { TxRunner, type TxScope } from '#libs/tenancy/index.js';
import { CommunityRead, type CommunityEntity } from '#modules/community/interface/community.js';
import { InventoryRead } from '#modules/inventory/interface/inventory.js';
import { PublicProfiles, type OrgSearchSource } from '#modules/organization/interface/public-profiles.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { TrustRead } from '#modules/trust/interface/trust.js';
import { AppointmentFacts } from '#modules/appointment/interface/appointments.js';
import { CONFIDENCE_LEVEL } from '../domain/ranking.js';

export const INDEX = {
  providers: 'providers',
  vendors: 'vendors',
  inventory: 'inventory',
  community: 'community',
  taxonomy: 'taxonomy',
} as const;

/** Taxonomy projection version marker (doc id in the taxonomy index). */
const TAXONOMY_META = '_meta';
const BATCH = 100;
/** Horizon of ProviderDoc.next_available_at (40 ResultCard.next_available_slot: the next 30 days). */
export const NEXT_SLOT_DAYS = 30;

export type ProviderDoc = SearchDocument & {
  organization_id: string;
  name: string;
  slug: string | null;
  /** 40 OrgType (map pins, contract 1.1.0). */
  organization_type: string;
  provider_type: string;
  service_modes: string[];
  price_tier: string;
  warranty_offered: boolean;
  response_time_target: string | null;
  measured_response_time_minutes: number | null;
  languages: string[];
  activity_status: string;
  service_node_ids: string[];
  offered_node_ids: string[];
  capabilities: {
    brand: string | null;
    model: string | null;
    series: string | null;
    system: string;
    task: string | null;
    level: number;
    evidence: number;
  }[];
  brand_node_ids: string[];
  model_node_ids: string[];
  series_node_ids: string[];
  locations: LocationDoc[];
  overall_rating: number | null;
  review_count: number;
  badges: string[];
  verified: boolean;
  fleet_friendly: boolean;
  ev_ready: boolean;
  /** 54 §3 trust score (0–100, W3), null until scored. */
  trust_score: number | null;
  /**
   * Earliest open appointment slot in the next 30 days (ISO), null without a calendar or a free slot
   * (ResultCard.next_available_slot, SearchFilters.available_within_days; the 54 §5.1 operational fit
   * counts the first 14 days, ranking.rankingSlot). Re-projected by SearchSlotRefreshRule once it passes.
   */
  next_available_at: string | null;
};

export type VendorDoc = SearchDocument & {
  organization_id: string;
  name: string;
  slug: string | null;
  organization_type: string;
  vendor_type: string;
  delivery_options: string[];
  trade_customers_supported: boolean;
  catalog_quality_score: number;
  measured_response_time_minutes: number | null;
  part_category_node_ids: string[];
  brand_node_ids: string[];
  locations: LocationDoc[];
  overall_rating: number | null;
  review_count: number;
  verified: boolean;
};

export type InventoryDoc = SearchDocument & {
  inventory_item_id: string;
  vendor_organization_id: string;
  part_category_node_ids: string[];
  part_origin: string;
  condition: string;
  stock_status: string;
  visibility: 'public' | 'trade_only';
  price_on_request: boolean;
  fitment: {
    brand: string;
    model: string | null;
    series: string | null;
    year_start: number | null;
    year_end: number | null;
    confidence: string;
  }[];
  fitment_brand_ids: string[];
  data_quality_score: number;
  locations: LocationDoc[];
};

export interface LocationDoc {
  location_id: string;
  point: { lat: number; lng: number };
  visibility: 'exact' | 'approximate';
  service_radius_km: number | null;
  city: string;
  hours: unknown;
  timezone: string;
}

@Injectable()
export class SearchProjections {
  #taxonomyVersion: string | null = null;

  constructor(
    private readonly tx: TxRunner,
    private readonly profiles: PublicProfiles,
    private readonly inventory: InventoryRead,
    private readonly taxonomy: TaxonomyResolver,
    @InjectInfra() private readonly infra: Infra,
    @InjectLogger() private readonly logger: Logger,
    @Optional() private readonly trust?: TrustRead,
    @Optional() private readonly community?: CommunityRead,
    @Optional() private readonly appointments?: AppointmentFacts,
  ) {}

  get index() {
    return this.infra.search;
  }

  /** The node ids and all their ancestors (a filter on a system finds its tasks' providers, a category its subcategories). */
  async #withAncestors(ids: Iterable<string | null | undefined>): Promise<string[]> {
    const out = new Set<string>();
    for (const id of ids) if (id) for (const a of await this.taxonomy.ancestors(id)) out.add(a);
    return [...out];
  }

  #locations(s: OrgSearchSource): LocationDoc[] {
    return s.locations.map((l) => ({ ...l }));
  }

  async #providerDoc(
    s: OrgSearchSource,
    rating: { overall: number | null; count: number },
    badges: string[],
    nextAvailable: Date | null,
  ): Promise<ProviderDoc> {
    const p = s.provider!;
    const caps = p.capabilities;
    return {
      organization_id: s.id,
      slug: s.slug,
      organization_type: s.organization_type,
      name: s.name,
      description: s.description_translations ?? {},
      provider_type: p.provider_type,
      service_modes: p.service_modes,
      price_tier: p.price_tier,
      warranty_offered: p.warranty_offered,
      response_time_target: p.response_time_target,
      measured_response_time_minutes: p.measured_response_time_minutes,
      languages: p.languages_spoken,
      profile_completeness: p.profile_completeness,
      activity_status: p.activity_status,
      category_node_ids: p.category_node_ids,
      // What the provider offers (categories, capability systems and tasks) and, for filters, those nodes with their ancestors.
      offered_node_ids: [
        ...new Set(
          [...p.category_node_ids, ...caps.flatMap((c) => [c.service_system_node_id, c.service_task_node_id])].filter(
            (x): x is string => !!x,
          ),
        ),
      ],
      service_node_ids: await this.#withAncestors([
        ...p.category_node_ids,
        ...caps.flatMap((c) => [c.service_system_node_id, c.service_task_node_id]),
      ]),
      capabilities: caps.map((c) => ({
        brand: c.brand_node_id,
        model: c.model_node_id,
        series: c.series_node_id,
        system: c.service_system_node_id,
        task: c.service_task_node_id,
        level: CONFIDENCE_LEVEL[c.confidence_level] ?? 0,
        evidence: c.evidence_count,
      })),
      brand_node_ids: [
        ...new Set([...p.coverage.map((c) => c.brand_node_id), ...caps.map((c) => c.brand_node_id)].filter((x): x is string => !!x)),
      ],
      model_node_ids: [
        ...new Set([...p.coverage.map((c) => c.model_node_id), ...caps.map((c) => c.model_node_id)].filter((x): x is string => !!x)),
      ],
      series_node_ids: [
        ...new Set([...p.coverage.map((c) => c.series_node_id), ...caps.map((c) => c.series_node_id)].filter((x): x is string => !!x)),
      ],
      amenity_node_ids: p.amenity_node_ids,
      certification_types: p.certification_types,
      portfolio_count: p.published_portfolio_count,
      locations: this.#locations(s),
      overall_rating: rating.overall,
      review_count: rating.count,
      badges,
      verified: s.verified,
      fleet_friendly: badges.includes('fleet_friendly'),
      ev_ready: badges.includes('ev_ready') || p.certification_types.includes('ev_high_voltage'),
      trust_score: s.trust_score,
      next_available_at: nextAvailable ? nextAvailable.toISOString() : null,
    };
  }

  async #vendorDoc(s: OrgSearchSource, rating: { overall: number | null; count: number }, itemCategories: string[]): Promise<VendorDoc> {
    const v = s.vendor!;
    return {
      organization_id: s.id,
      slug: s.slug,
      organization_type: s.organization_type,
      name: s.name,
      description: s.description_translations ?? {},
      vendor_type: v.vendor_type,
      delivery_options: v.delivery_options,
      trade_customers_supported: v.trade_customers_supported,
      catalog_quality_score: v.catalog_quality_score,
      measured_response_time_minutes: v.measured_response_time_minutes,
      part_category_node_ids: await this.#withAncestors([
        ...v.coverage.filter((c) => c.coverage_type === 'part_category').map((c) => c.node_id),
        ...itemCategories,
      ]),
      brand_node_ids: v.coverage.filter((c) => c.coverage_type !== 'part_category').map((c) => c.node_id),
      locations: this.#locations(s),
      overall_rating: rating.overall,
      review_count: rating.count,
      verified: s.verified,
    };
  }

  /**
   * Rebuilds the documents of organizations: provider and vendor documents,
   * the vendor's items and the provider's showcases; organizations that are
   * no longer public lose all of them.
   */
  async reindexOrgs(orgIds: readonly string[]): Promise<void> {
    const ids = [...new Set(orgIds)];
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);
      await this.tx.run({ actorType: 'system' }, async (scope) => {
        const sources = await this.profiles.searchSources(scope, chunk);
        const [ratings, badges] = await Promise.all([
          this.trust ? this.trust.ratings(scope, chunk) : new Map(),
          this.trust ? this.trust.badges(scope, chunk, 'en') : new Map(),
        ]);
        for (const orgId of chunk) {
          const s = sources.get(orgId);
          const rating = (ratings.get(orgId) as { overall: number | null; count: number } | undefined) ?? { overall: null, count: 0 };
          const orgBadges = ((badges.get(orgId) ?? []) as { badge_type: string }[]).map((b) => b.badge_type);
          const next =
            s?.provider && this.appointments ? await this.appointments.nextOpenSlot(scope, orgId, new Date(), NEXT_SLOT_DAYS) : null;
          if (s?.provider) await this.index.upsert(INDEX.providers, orgId, await this.#providerDoc(s, rating, orgBadges, next));
          else await this.index.remove(INDEX.providers, orgId);
          const itemCategories = s?.vendor ? await this.#reindexVendorItems(scope, s) : await this.#dropVendorItems(orgId);
          if (s?.vendor) await this.index.upsert(INDEX.vendors, orgId, await this.#vendorDoc(s, rating, itemCategories));
          else await this.index.remove(INDEX.vendors, orgId);
          await this.index.removeWhere(INDEX.community, [
            { field: 'entity_type', eq: 'portfolio_item' },
            { field: 'organization_id', eq: orgId },
          ]);
          if (s?.provider) await this.#upsertPortfolio(scope, await this.profiles.portfolioIds(scope, orgId));
        }
      });
    }
  }

  async #dropVendorItems(vendorId: string): Promise<string[]> {
    await this.index.removeWhere(INDEX.inventory, [{ field: 'vendor_organization_id', eq: vendorId }]);
    return [];
  }

  /** Every public item of a published vendor; returns their part categories (vendor document). */
  async #reindexVendorItems(scope: TxScope, vendor: OrgSearchSource): Promise<string[]> {
    await this.index.removeWhere(INDEX.inventory, [{ field: 'vendor_organization_id', eq: vendor.id }]);
    const ids = await this.inventory.vendorItemIds(scope, vendor.id);
    const categories = new Set<string>();
    for (let i = 0; i < ids.length; i += 500) {
      const sources = await this.inventory.searchSources(scope, ids.slice(i, i + 500));
      for (const s of sources.values()) {
        categories.add(s.part_category_node_id);
        await this.index.upsert(INDEX.inventory, s.id, await this.#itemDoc(s, vendor.locations));
      }
    }
    return [...categories];
  }

  async #itemDoc(
    s: Awaited<ReturnType<InventoryRead['searchSources']>> extends Map<string, infer V> ? V : never,
    locations: OrgSearchSource['locations'],
  ): Promise<InventoryDoc> {
    // The item's own location when it names one, else every location of the vendor.
    const own = locations.filter((l) => l.location_id === s.location_id);
    return {
      inventory_item_id: s.id,
      vendor_organization_id: s.vendor_organization_id,
      name: s.name_translations,
      normalized_name: s.normalized_name,
      sku: s.sku,
      part_numbers: s.part_numbers,
      brand: s.brand,
      part_category_node_id: s.part_category_node_id,
      part_category_node_ids: await this.#withAncestors([s.part_category_node_id]),
      part_origin: s.part_origin,
      condition: s.condition,
      stock_status: s.stock_status,
      visibility: s.visibility,
      price_public: s.price_public,
      currency: s.currency,
      price_on_request: s.price_on_request,
      fitment: s.fitment.map((f) => ({
        brand: f.brand_node_id,
        model: f.model_node_id,
        series: f.series_node_id,
        year_start: f.year_start,
        year_end: f.year_end,
        engine: f.engine_type_node_id,
        confidence: f.confidence,
      })),
      fitment_brand_ids: [...new Set(s.fitment.map((f) => f.brand_node_id))],
      data_quality_score: s.data_quality_score,
      locations: (own.length ? own : locations).map((l) => ({ ...l })),
    };
  }

  /** Items changed (inventory.updated): upserted when public, removed otherwise. */
  async reindexItems(itemIds: readonly string[]): Promise<void> {
    const ids = [...new Set(itemIds)];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      await this.tx.run({ actorType: 'system' }, async (scope) => {
        const sources = await this.inventory.searchSources(scope, chunk);
        const vendors = await this.profiles.searchSources(scope, [...new Set([...sources.values()].map((s) => s.vendor_organization_id))]);
        for (const id of chunk) {
          const s = sources.get(id);
          const vendor = s ? vendors.get(s.vendor_organization_id) : undefined;
          if (s && vendor?.vendor) await this.index.upsert(INDEX.inventory, id, await this.#itemDoc(s, vendor.locations));
          else await this.index.remove(INDEX.inventory, id);
        }
      });
    }
  }

  async #upsertPortfolio(scope: TxScope, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const sources = await this.profiles.portfolioSources(scope, ids);
    for (const id of ids) {
      const s = sources.get(id);
      const key = `portfolio_item:${id}`;
      if (!s) {
        await this.index.remove(INDEX.community, key);
        continue;
      }
      await this.index.upsert(INDEX.community, key, {
        entity_type: 'portfolio_item',
        entity_id: s.id,
        title: s.title,
        body: [s.description, s.caption].filter(Boolean).join('\n'),
        content_locale: s.content_locale,
        node_ids: await this.#withAncestors(s.node_ids),
        organization_id: s.organization_id,
        published_at: s.published_at.toISOString(),
        status: null,
        question_id: null,
      });
    }
  }

  /** Posts, questions and answers changed (community.content.changed, qna.question.created). */
  async reindexCommunity(refs: readonly { type: CommunityEntity | 'portfolio_item'; id: string }[]): Promise<void> {
    if (refs.length === 0) return;
    await this.tx.run({ actorType: 'system' }, async (scope) => {
      await this.#upsertPortfolio(
        scope,
        refs.filter((r) => r.type === 'portfolio_item').map((r) => r.id),
      );
      const own = refs.filter((r): r is { type: CommunityEntity; id: string } => r.type !== 'portfolio_item');
      if (own.length === 0 || !this.community) return;
      const sources = await this.community.searchSources(scope, own);
      for (const r of own) {
        const key = `${r.type}:${r.id}`;
        const s = sources.get(key);
        if (!s) await this.index.remove(INDEX.community, key);
        else
          await this.index.upsert(INDEX.community, key, {
            ...s,
            node_ids: await this.#withAncestors(s.node_ids),
            published_at: s.published_at.toISOString(),
          });
      }
    });
  }

  /**
   * The taxonomy projection (TaxonomySearchDoc) for the catalog version: one
   * document per active node with its names and the analyzed forms of every
   * name and synonym (the query interpreter's term lookup). Rebuilt when the
   * version changes; cheap to call before every search.
   */
  async ensureTaxonomy(): Promise<void> {
    const { version } = await this.taxonomy.version();
    if (this.#taxonomyVersion === version) return;
    const meta = await this.index.get(INDEX.taxonomy, TAXONOMY_META);
    if (meta?.version === version) {
      this.#taxonomyVersion = version;
      return;
    }
    const { nodes, synonyms } = await this.taxonomy.catalog();
    const bySynonym = new Map<string, string[]>();
    for (const s of synonyms) bySynonym.set(s.nodeId, [...(bySynonym.get(s.nodeId) ?? []), s.term]);
    const keep = new Set<string>();
    for (const n of nodes) {
      if (n.status !== 'active') continue;
      keep.add(n.id);
      const terms = [...Object.values(n.nameTranslations), ...(bySynonym.get(n.id) ?? [])]
        .map((t) => searchTokens(t).join(' '))
        .filter(Boolean);
      await this.index.upsert(INDEX.taxonomy, n.id, {
        node_id: n.id,
        type: n.type,
        status: n.status,
        names: n.nameTranslations,
        terms: [...new Set(terms)],
        parent_path: (await this.taxonomy.ancestors(n.id)).slice(1),
      });
    }
    for (const id of await this.index.ids(INDEX.taxonomy))
      if (id !== TAXONOMY_META && !keep.has(id)) await this.index.remove(INDEX.taxonomy, id);
    await this.index.upsert(INDEX.taxonomy, TAXONOMY_META, { version, status: 'meta' });
    this.#taxonomyVersion = version;
  }

  /** Providers whose projected next open slot lies before `now`, projected again (SearchSlotRefreshRule, S10); up to `limit` per call. */
  async refreshPassedSlots(now: Date, limit = 500): Promise<number> {
    const { hits } = await this.index.search(INDEX.providers, {
      filters: [{ field: 'next_available_at', lte: now.toISOString() }],
      size: limit,
    });
    const ids = hits.map((h) => h.id);
    if (ids.length) await this.reindexOrgs(ids);
    return ids.length;
  }

  /** Nightly reconciliation (and the lite rebuild at start): every public document rebuilt, stale ones removed. */
  async reconcile(): Promise<{ organizations: number; community: number }> {
    await this.ensureTaxonomy();
    const published = new Set<string>();
    let after: string | null = null;
    for (;;) {
      const page: string[] = await this.tx.run({ actorType: 'system' }, (scope) => this.profiles.publishedIds(scope, after, 500));
      if (page.length === 0) break;
      page.forEach((id) => published.add(id));
      await this.reindexOrgs(page);
      after = page.at(-1)!;
    }
    for (const index of [INDEX.providers, INDEX.vendors])
      for (const id of await this.index.ids(index)) if (!published.has(id)) await this.reindexOrgs([id]);
    let community = 0;
    if (this.community) {
      const keys = new Set<string>();
      let pos: string | null = null;
      for (;;) {
        const refs: { type: CommunityEntity; id: string }[] = await this.tx.run({ actorType: 'system' }, (scope) =>
          this.community!.publicRefs(scope, pos, 500),
        );
        if (refs.length === 0) break;
        refs.forEach((r) => keys.add(`${r.type}:${r.id}`));
        await this.reindexCommunity(refs);
        community += refs.length;
        pos = `${refs.at(-1)!.type}:${refs.at(-1)!.id}`;
      }
      for (const key of await this.index.ids(INDEX.community))
        if (!key.startsWith('portfolio_item:') && !keys.has(key)) await this.index.remove(INDEX.community, key);
    }
    this.logger.info({ organizations: published.size, community }, 'search projections reconciled');
    return { organizations: published.size, community };
  }
}
