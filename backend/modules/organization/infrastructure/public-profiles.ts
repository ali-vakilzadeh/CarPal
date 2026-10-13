// PublicProfiles (interface/public-profiles.ts): reads under the caller's
// public RLS context (organizations active, profiles published, locations
// active, catalog public, capabilities approved and ≥ low_evidence,
// certifications verified) and projects them by allowlist.
import { Injectable, Optional } from '@nestjs/common';
import { sql, type Selectable } from 'kysely';
import { l10n, type L10n, type Locale } from '#libs/i18n/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { MediaService } from '#modules/media/interface/media.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { textArray, type DB } from '#libs/db/index.js';
import { toPublicLocation, toPublicLocationPin } from '../api/public-projections.js';
import {
  PublicProfiles,
  type OrgSearchSource,
  type PortfolioQuery,
  type PortfolioSearchSource,
  type PublicLocationPin,
  type PublicOrgCardParts,
  type PublicPortfolioParts,
  type PublicProfileParts,
  type PublishedVendor,
} from '../interface/public-profiles.js';

type T = Record<string, string> | null;
type PortfolioRow = Selectable<DB['organization.portfolio_items']>;

@Injectable()
export class DbPublicProfiles extends PublicProfiles {
  constructor(
    private readonly taxonomy: TaxonomyResolver,
    @Optional() private readonly media?: MediaService,
  ) {
    super();
  }

  async #locations(scope: TxScope, orgIds: readonly string[]) {
    if (orgIds.length === 0) return [];
    return scope.db
      .selectFrom('organization.organization_locations')
      .selectAll()
      .where('organization_id', 'in', [...orgIds])
      .where('status', '=', 'active')
      .where('deleted_at', 'is', null)
      .orderBy('is_primary', 'desc')
      .orderBy('id')
      .execute();
  }

  async vendors(scope: TxScope, orgIds: readonly string[]): Promise<Map<string, PublishedVendor>> {
    const ids = [...new Set(orgIds)].slice(0, 500);
    if (ids.length === 0) return new Map();
    const rows = await scope.db
      .selectFrom('organization.vendor_profiles as p')
      .innerJoin('organization.organizations as o', 'o.id', 'p.organization_id')
      .select(['p.organization_id', 'p.trade_customers_supported'])
      .where('p.organization_id', 'in', ids)
      .where('p.public_status', '=', 'published')
      .where('p.deleted_at', 'is', null)
      .where('o.status', '=', 'active')
      .where('o.deleted_at', 'is', null)
      .execute();
    return new Map(
      rows.map((r) => [r.organization_id, { orgId: r.organization_id, tradeCustomersSupported: r.trade_customers_supported }]),
    );
  }

  async profile(scope: TxScope, orgId: string, locale: Locale, now = new Date()): Promise<PublicProfileParts | null> {
    const org = await scope.db
      .selectFrom('organization.organizations')
      .selectAll()
      .where('id', '=', orgId)
      .where('status', '=', 'active')
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!org) return null;
    const [provider, vendor] = await Promise.all([
      scope.db
        .selectFrom('organization.provider_profiles')
        .selectAll()
        .where('organization_id', '=', orgId)
        .where('public_status', '=', 'published')
        .where('deleted_at', 'is', null)
        .executeTakeFirst(),
      scope.db
        .selectFrom('organization.vendor_profiles')
        .selectAll()
        .where('organization_id', '=', orgId)
        .where('public_status', '=', 'published')
        .where('deleted_at', 'is', null)
        .executeTakeFirst(),
    ]);
    if (!provider && !vendor) return null;
    const locations = (await this.#locations(scope, [orgId])).slice(0, 20).map((l) => toPublicLocation(l, locale, now));
    const label = async (ids: (string | null)[]) =>
      this.taxonomy.labels(
        ids.filter((x): x is string => !!x),
        locale,
      );
    const text = (m: T): L10n | null => l10n(m, locale);
    const roles: ('provider' | 'vendor')[] = [...(provider ? (['provider'] as const) : []), ...(vendor ? (['vendor'] as const) : [])];
    const logos = this.media ? await this.media.logoUrls(scope, [orgId]) : new Map<string, string>();

    let providerPart: Record<string, unknown> | null = null;
    if (provider) {
      const [categories, coverage, capabilities, certifications] = await Promise.all([
        scope.db
          .selectFrom('organization.provider_service_categories')
          .selectAll()
          .where('provider_organization_id', '=', orgId)
          .where('status', '=', 'active')
          .where('visibility', '=', 'public')
          .orderBy('id')
          .limit(200)
          .execute(),
        scope.db
          .selectFrom('organization.provider_vehicle_coverage')
          .selectAll()
          .where('provider_organization_id', '=', orgId)
          .where('status', '=', 'active')
          .orderBy('id')
          .limit(500)
          .execute(),
        scope.db
          .selectFrom('organization.provider_capabilities')
          .selectAll()
          .where('provider_organization_id', '=', orgId)
          .where('status', '=', 'active')
          .where('public_visibility', '=', true)
          .where('confidence_level', '<>', 'self_declared')
          .orderBy('id')
          .limit(500)
          .execute(),
        scope.db
          .selectFrom('organization.provider_certifications')
          .select(['name', 'issuer', 'certification_type'])
          .where('provider_organization_id', '=', orgId)
          .where('status', '=', 'active')
          .where('verification_status', '=', 'verified')
          .orderBy('id')
          .limit(50)
          .execute(),
      ]);
      const labels = await label([
        ...textArray(provider.amenity_node_ids),
        ...categories.map((c) => c.taxonomy_node_id),
        ...coverage.flatMap((c) => [c.brand_node_id, c.model_node_id, c.series_node_id]),
        ...capabilities.flatMap((c) => [
          c.brand_node_id,
          c.model_node_id,
          c.series_node_id,
          c.service_system_node_id,
          c.service_task_node_id,
        ]),
      ]);
      const lb = (id: string | null) => (id ? (labels.get(id) ?? null) : null);
      providerPart = {
        provider_type: provider.provider_type,
        years_in_business: provider.years_in_business,
        languages_spoken: textArray(provider.languages_spoken),
        amenities: textArray(provider.amenity_node_ids)
          .filter((id) => labels.has(id))
          .map((id) => ({ node_id: id, label: labels.get(id)! })),
        service_modes: textArray(provider.service_modes),
        price_tier: provider.price_tier,
        warranty_offered: provider.warranty_offered,
        warranty_policy: text(provider.warranty_policy_translations as T),
        response_time_target: provider.response_time_target,
        service_categories: categories
          .map((c) => ({
            node_id: c.taxonomy_node_id,
            label: text(c.display_name_translations as T) ?? lb(c.taxonomy_node_id),
            experience_level: c.experience_level,
          }))
          .filter((c) => c.label),
        coverage: coverage
          .filter((c) => lb(c.brand_node_id))
          .map((c) => ({ brand: lb(c.brand_node_id), model: lb(c.model_node_id), series: lb(c.series_node_id) })),
        capabilities: capabilities
          .filter((c) => lb(c.service_system_node_id))
          .map((c) => ({
            brand: lb(c.brand_node_id),
            model: lb(c.model_node_id),
            series: lb(c.series_node_id),
            service_system: lb(c.service_system_node_id),
            service_task: lb(c.service_task_node_id),
            experience_level: c.experience_level,
            confidence_level: c.confidence_level,
            evidence_count: c.evidence_count,
          })),
        certifications,
      };
    }

    let vendorPart: Record<string, unknown> | null = null;
    if (vendor) {
      const coverage = await scope.db
        .selectFrom('organization.vendor_coverage')
        .selectAll()
        .where('vendor_organization_id', '=', orgId)
        .where('status', '=', 'active')
        .orderBy('id')
        .limit(500)
        .execute();
      const labels = await label(coverage.map((c) => c.taxonomy_node_id));
      vendorPart = {
        vendor_type: vendor.vendor_type,
        delivery_options: textArray(vendor.delivery_options),
        trade_customers_supported: vendor.trade_customers_supported,
        default_price_visibility: vendor.default_price_visibility,
        return_policy: text(vendor.return_policy_translations as T),
        warranty_policy: text(vendor.warranty_policy_translations as T),
        catalog_quality_score: vendor.catalog_quality_score,
        coverage: coverage
          .filter((c) => labels.has(c.taxonomy_node_id))
          .map((c) => ({ node_id: c.taxonomy_node_id, label: labels.get(c.taxonomy_node_id)!, coverage_type: c.coverage_type })),
      };
    }

    return {
      id: org.id,
      slug: org.slug,
      name: org.name,
      organization_type: org.organization_type,
      roles,
      verified: org.verification_status === 'verified',
      price_tier: provider?.price_tier ?? null,
      measured_response_time_minutes: provider?.measured_response_time_minutes ?? vendor?.measured_response_time_minutes ?? null,
      logo_url: logos.get(org.id) ?? null,
      description: text((provider?.description_translations ?? vendor?.description_translations ?? org.description_translations) as T),
      website: org.website,
      // SEC-OUT-3: the provider's public contact channels are the only contact data shown publicly.
      contact_channels: provider ? (provider.contact_channels as unknown[]) : [],
      locations,
      provider: providerPart,
      vendor: vendorPart,
    };
  }

  async pins(scope: TxScope, orgIds: readonly string[]): Promise<Map<string, PublicLocationPin[]>> {
    const ids = [...new Set(orgIds)].slice(0, 500);
    if (ids.length === 0) return new Map();
    const published = await scope.db
      .selectFrom('organization.organizations as o')
      .select('o.id')
      .where('o.id', 'in', ids)
      .where('o.status', '=', 'active')
      .where((eb) =>
        eb.or([
          eb.exists(
            eb
              .selectFrom('organization.provider_profiles as p')
              .select('p.id')
              .whereRef('p.organization_id', '=', 'o.id')
              .where('p.public_status', '=', 'published'),
          ),
          eb.exists(
            eb
              .selectFrom('organization.vendor_profiles as v')
              .select('v.id')
              .whereRef('v.organization_id', '=', 'o.id')
              .where('v.public_status', '=', 'published'),
          ),
        ]),
      )
      .execute();
    const out = new Map<string, PublicLocationPin[]>();
    for (const l of await this.#locations(
      scope,
      published.map((p) => p.id),
    ))
      out.set(l.organization_id, [...(out.get(l.organization_id) ?? []), toPublicLocationPin(l)]);
    return out;
  }

  /** Organizations among `ids` that are active with a published provider and/or vendor profile, with their roles. */
  async #published(scope: TxScope, orgIds: readonly string[]) {
    const ids = [...new Set(orgIds)].slice(0, 500);
    if (ids.length === 0) return [];
    return scope.db
      .selectFrom('organization.organizations as o')
      .leftJoin('organization.provider_profiles as p', (j) =>
        j.onRef('p.organization_id', '=', 'o.id').on('p.public_status', '=', 'published').on('p.deleted_at', 'is', null),
      )
      .leftJoin('organization.vendor_profiles as v', (j) =>
        j.onRef('v.organization_id', '=', 'o.id').on('v.public_status', '=', 'published').on('v.deleted_at', 'is', null),
      )
      .select([
        'o.id',
        'o.slug',
        'o.name',
        'o.organization_type',
        'o.verification_status',
        'o.trust_score',
        'o.description_translations as o_description',
        'p.id as p_id',
        'p.price_tier as p_price_tier',
        'p.measured_response_time_minutes as p_response',
        'v.id as v_id',
        'v.measured_response_time_minutes as v_response',
      ])
      .where('o.id', 'in', ids)
      .where('o.status', '=', 'active')
      .where('o.deleted_at', 'is', null)
      .where((eb) => eb.or([eb('p.id', 'is not', null), eb('v.id', 'is not', null)]))
      .execute();
  }

  async idBySlug(scope: TxScope, slug: string): Promise<string | null> {
    const row = await scope.db
      .selectFrom('organization.organizations')
      .select('id')
      .where('slug', '=', slug.toLowerCase())
      .where('status', '=', 'active')
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!row) return null;
    return (await this.#published(scope, [row.id])).length ? row.id : null;
  }

  async cards(scope: TxScope, orgIds: readonly string[]): Promise<Map<string, PublicOrgCardParts>> {
    const rows = await this.#published(scope, orgIds);
    const logos =
      this.media && rows.length
        ? await this.media.logoUrls(
            scope,
            rows.map((r) => r.id),
          )
        : new Map<string, string>();
    return new Map(
      rows.map((r) => [
        r.id,
        {
          id: r.id,
          slug: r.slug,
          name: r.name,
          organization_type: r.organization_type,
          roles: [...(r.p_id ? (['provider'] as const) : []), ...(r.v_id ? (['vendor'] as const) : [])],
          verified: r.verification_status === 'verified',
          price_tier: r.p_id ? (r.p_price_tier ?? null) : null,
          measured_response_time_minutes: r.p_response ?? r.v_response ?? null,
          logo_url: logos.get(r.id) ?? null,
        },
      ]),
    );
  }

  async searchSources(scope: TxScope, orgIds: readonly string[]): Promise<Map<string, OrgSearchSource>> {
    const rows = await this.#published(scope, orgIds);
    const out = new Map<string, OrgSearchSource>();
    if (rows.length === 0) return out;
    const ids = rows.map((r) => r.id);
    const pIds = rows.filter((r) => r.p_id).map((r) => r.id);
    const vIds = rows.filter((r) => r.v_id).map((r) => r.id);
    const db = scope.db;
    const [locations, providers, vendors, categories, coverage, capabilities, certifications, portfolio, vendorCoverage] =
      await Promise.all([
        this.#locations(scope, ids),
        pIds.length ? db.selectFrom('organization.provider_profiles').selectAll().where('organization_id', 'in', pIds).execute() : [],
        vIds.length ? db.selectFrom('organization.vendor_profiles').selectAll().where('organization_id', 'in', vIds).execute() : [],
        pIds.length
          ? db
              .selectFrom('organization.provider_service_categories')
              .select(['provider_organization_id as org', 'taxonomy_node_id'])
              .where('provider_organization_id', 'in', pIds)
              .where('status', '=', 'active')
              .where('visibility', '=', 'public')
              .where('deleted_at', 'is', null)
              .execute()
          : [],
        pIds.length
          ? db
              .selectFrom('organization.provider_vehicle_coverage')
              .select(['provider_organization_id as org', 'brand_node_id', 'model_node_id', 'series_node_id'])
              .where('provider_organization_id', 'in', pIds)
              .where('status', '=', 'active')
              .where('deleted_at', 'is', null)
              .execute()
          : [],
        pIds.length
          ? db
              .selectFrom('organization.provider_capabilities')
              .select([
                'provider_organization_id as org',
                'brand_node_id',
                'model_node_id',
                'series_node_id',
                'service_system_node_id',
                'service_task_node_id',
                'confidence_level',
                'evidence_count',
              ])
              .where('provider_organization_id', 'in', pIds)
              .where('status', '=', 'active')
              .where('public_visibility', '=', true)
              .where('confidence_level', '<>', 'self_declared')
              .where('deleted_at', 'is', null)
              .execute()
          : [],
        pIds.length
          ? db
              .selectFrom('organization.provider_certifications')
              .select(['provider_organization_id as org', 'certification_type'])
              .where('provider_organization_id', 'in', pIds)
              .where('status', '=', 'active')
              .where('verification_status', '=', 'verified')
              .where('deleted_at', 'is', null)
              .execute()
          : [],
        pIds.length
          ? db
              .selectFrom('organization.portfolio_items')
              .select(['provider_organization_id as org', (eb) => eb.fn.countAll<string>().as('n')])
              .where('provider_organization_id', 'in', pIds)
              .where('status', '=', 'published')
              .where('visibility', '=', 'public')
              .where('deleted_at', 'is', null)
              .groupBy('provider_organization_id')
              .execute()
          : [],
        vIds.length
          ? db
              .selectFrom('organization.vendor_coverage')
              .select(['vendor_organization_id as org', 'taxonomy_node_id', 'coverage_type'])
              .where('vendor_organization_id', 'in', vIds)
              .where('status', '=', 'active')
              .where('deleted_at', 'is', null)
              .execute()
          : [],
      ]);
    const group = <R extends { org: string }>(list: readonly R[]) => {
      const m = new Map<string, R[]>();
      for (const x of list) m.set(x.org, [...(m.get(x.org) ?? []), x]);
      return (id: string): R[] => m.get(id) ?? [];
    };
    const cat = group(categories);
    const cov = group(coverage);
    const cap = group(capabilities);
    const cert = group(certifications);
    const port = group(portfolio);
    const vcov = group(vendorCoverage);
    for (const r of rows) {
      const p = r.p_id ? providers.find((x) => x.id === r.p_id) : undefined;
      const v = r.v_id ? vendors.find((x) => x.id === r.v_id) : undefined;
      out.set(r.id, {
        id: r.id,
        slug: r.slug,
        name: r.name,
        organization_type: r.organization_type,
        verified: r.verification_status === 'verified',
        trust_score: r.trust_score === null ? null : Number(r.trust_score),
        description_translations: ((p?.description_translations ?? v?.description_translations ?? r.o_description) as T) ?? null,
        locations: locations
          .filter((l) => l.organization_id === r.id)
          .map((l) => ({ ...toPublicLocationPin(l), hours: l.hours ?? null, timezone: l.timezone })),
        provider: p
          ? {
              provider_type: p.provider_type,
              service_modes: textArray(p.service_modes),
              price_tier: p.price_tier,
              warranty_offered: p.warranty_offered,
              response_time_target: p.response_time_target,
              measured_response_time_minutes: p.measured_response_time_minutes,
              languages_spoken: textArray(p.languages_spoken),
              profile_completeness: p.profile_completeness,
              activity_status: p.activity_status,
              amenity_node_ids: textArray(p.amenity_node_ids),
              category_node_ids: cat(r.id).map((c) => c.taxonomy_node_id),
              coverage: cov(r.id).map(({ org: _o, ...c }) => c),
              capabilities: cap(r.id).map(({ org: _o, ...c }) => c),
              certification_types: [...new Set(cert(r.id).map((c) => c.certification_type))],
              published_portfolio_count: Number(port(r.id)[0]?.n ?? 0),
            }
          : null,
        vendor: v
          ? {
              vendor_type: v.vendor_type,
              delivery_options: textArray(v.delivery_options),
              trade_customers_supported: v.trade_customers_supported,
              default_price_visibility: v.default_price_visibility,
              catalog_quality_score: v.catalog_quality_score,
              measured_response_time_minutes: v.measured_response_time_minutes,
              coverage: vcov(r.id).map((c) => ({ node_id: c.taxonomy_node_id, coverage_type: c.coverage_type })),
            }
          : null,
      });
    }
    return out;
  }

  async publishedIds(scope: TxScope, afterId: string | null, limit: number): Promise<string[]> {
    let q = scope.db
      .selectFrom('organization.organizations as o')
      .select('o.id')
      .where('o.status', '=', 'active')
      .where('o.deleted_at', 'is', null)
      .where((eb) =>
        eb.or([
          eb.exists(
            eb
              .selectFrom('organization.provider_profiles as p')
              .select('p.id')
              .whereRef('p.organization_id', '=', 'o.id')
              .where('p.public_status', '=', 'published'),
          ),
          eb.exists(
            eb
              .selectFrom('organization.vendor_profiles as v')
              .select('v.id')
              .whereRef('v.organization_id', '=', 'o.id')
              .where('v.public_status', '=', 'published'),
          ),
        ]),
      );
    if (afterId) q = q.where('o.id', '>', afterId);
    return (await q.orderBy('o.id').limit(limit).execute()).map((r) => r.id);
  }

  async changedSince(scope: TxScope, since: Date, limit: number): Promise<{ ids: string[]; until: Date | null }> {
    // Every table of the public projection, by its organization column (updated_at moves on every write, core.tg_touch).
    const { rows } = await sql<{ org: string; at: Date }>`
      SELECT org, max(at) AS at FROM (
        SELECT id AS org, updated_at AS at FROM organization.organizations WHERE updated_at > ${since}
        UNION ALL SELECT organization_id, updated_at FROM organization.organization_locations WHERE updated_at > ${since}
        UNION ALL SELECT organization_id, updated_at FROM organization.provider_profiles WHERE updated_at > ${since}
        UNION ALL SELECT organization_id, updated_at FROM organization.vendor_profiles WHERE updated_at > ${since}
        UNION ALL SELECT provider_organization_id, updated_at FROM organization.provider_service_categories WHERE updated_at > ${since}
        UNION ALL SELECT provider_organization_id, updated_at FROM organization.provider_vehicle_coverage WHERE updated_at > ${since}
        UNION ALL SELECT provider_organization_id, updated_at FROM organization.provider_capabilities WHERE updated_at > ${since}
        UNION ALL SELECT provider_organization_id, updated_at FROM organization.provider_certifications WHERE updated_at > ${since}
        UNION ALL SELECT provider_organization_id, updated_at FROM organization.portfolio_items WHERE updated_at > ${since}
        UNION ALL SELECT vendor_organization_id, updated_at FROM organization.vendor_coverage WHERE updated_at > ${since}
      ) c GROUP BY org ORDER BY max(at), org LIMIT ${limit}`.execute(scope.db);
    return { ids: rows.map((r) => r.org), until: rows.length ? new Date(rows.at(-1)!.at) : null };
  }

  /** Published public portfolio items of active organizations with a published provider profile. */
  #portfolioQuery(scope: TxScope) {
    return scope.db
      .selectFrom('organization.portfolio_items as i')
      .innerJoin('organization.organizations as o', 'o.id', 'i.provider_organization_id')
      .selectAll('i')
      .where('i.status', '=', 'published')
      .where('i.visibility', '=', 'public')
      .where('i.deleted_at', 'is', null)
      .where('o.status', '=', 'active')
      .where('o.deleted_at', 'is', null)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('organization.provider_profiles as p')
            .select('p.id')
            .whereRef('p.organization_id', '=', 'i.provider_organization_id')
            .where('p.public_status', '=', 'published'),
        ),
      );
  }

  async #portfolioParts(scope: TxScope, rows: PortfolioRow[], locale: Locale): Promise<PublicPortfolioParts[]> {
    if (rows.length === 0) return [];
    const labels = await this.taxonomy.labels(
      rows
        .flatMap((r) => [
          r.brand_node_id,
          r.model_node_id,
          r.series_node_id,
          r.service_system_node_id,
          r.service_task_node_id,
          ...textArray(r.tag_node_ids),
        ])
        .filter((x): x is string => !!x),
      locale,
    );
    const lb = (id: string | null) => (id ? (labels.get(id) ?? null) : null);
    const media = this.media
      ? await this.media.publicAttachmentViews(
          scope,
          'portfolio_item',
          rows.map((r) => r.id),
        )
      : new Map<string, unknown[]>();
    return rows
      .filter((r) => lb(r.service_system_node_id))
      .map((r) => ({
        id: r.id,
        organization_id: r.provider_organization_id,
        title: r.title,
        description: r.description,
        content_locale: r.content_locale,
        vehicle: { brand: lb(r.brand_node_id), model: lb(r.model_node_id), series: lb(r.series_node_id) },
        service_system: lb(r.service_system_node_id)!,
        service_task: lb(r.service_task_node_id),
        tags: textArray(r.tag_node_ids)
          .filter((id) => labels.has(id))
          .map((id) => ({ node_id: id, label: labels.get(id)! })),
        job_date: r.job_date ?? null,
        caption: r.caption,
        media: (media.get(r.id) ?? []).slice(0, 40),
        like_count: r.like_count,
        published_at: new Date(r.published_at!).toISOString(),
      }));
  }

  async portfolio(scope: TxScope, orgId: string, q: PortfolioQuery, locale: Locale): Promise<PublicPortfolioParts[]> {
    let s = this.#portfolioQuery(scope).where('i.provider_organization_id', '=', orgId);
    if (q.service_system_node_id) s = s.where('i.service_system_node_id', '=', q.service_system_node_id);
    if (q.brand_node_id) s = s.where('i.brand_node_id', '=', q.brand_node_id);
    if (q.after) s = s.where(sql<boolean>`(i.published_at, i.id) < (${new Date(q.after.published_at)}, ${q.after.id}::uuid)`);
    const rows = await s.orderBy('i.published_at', 'desc').orderBy('i.id', 'desc').limit(q.limit).execute();
    return this.#portfolioParts(scope, rows, locale);
  }

  async portfolioItems(scope: TxScope, ids: readonly string[], locale: Locale): Promise<Map<string, PublicPortfolioParts>> {
    const unique = [...new Set(ids)].slice(0, 200);
    if (unique.length === 0) return new Map();
    const rows = await this.#portfolioQuery(scope).where('i.id', 'in', unique).execute();
    return new Map((await this.#portfolioParts(scope, rows, locale)).map((p) => [p.id, p]));
  }

  async portfolioSources(scope: TxScope, ids: readonly string[]): Promise<Map<string, PortfolioSearchSource>> {
    const unique = [...new Set(ids)].slice(0, 500);
    if (unique.length === 0) return new Map();
    const rows = await this.#portfolioQuery(scope).where('i.id', 'in', unique).execute();
    return new Map(
      rows.map((r) => [
        r.id,
        {
          id: r.id,
          organization_id: r.provider_organization_id,
          title: r.title,
          description: r.description,
          caption: r.caption,
          content_locale: r.content_locale,
          node_ids: [
            r.brand_node_id,
            r.model_node_id,
            r.series_node_id,
            r.service_system_node_id,
            r.service_task_node_id,
            ...textArray(r.tag_node_ids),
          ].filter((x): x is string => !!x),
          published_at: new Date(r.published_at!),
        },
      ]),
    );
  }

  async portfolioIds(scope: TxScope, orgId: string): Promise<string[]> {
    const rows = await this.#portfolioQuery(scope).where('i.provider_organization_id', '=', orgId).execute();
    return rows.map((r) => r.id);
  }

  async portfolioItemStatus(scope: TxScope, itemId: string) {
    const row = await scope.db
      .selectFrom('organization.portfolio_items')
      .select(['provider_organization_id', 'status', 'customer_consent_status'])
      .where('id', '=', itemId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return row
      ? { organizationId: row.provider_organization_id, status: row.status, customerConsentStatus: row.customer_consent_status }
      : null;
  }
}
