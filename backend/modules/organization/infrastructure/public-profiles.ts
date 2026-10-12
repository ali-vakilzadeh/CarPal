// PublicProfiles (interface/public-profiles.ts): reads under the caller's
// public RLS context (organizations active, profiles published, locations
// active, catalog public, capabilities approved and ≥ low_evidence,
// certifications verified) and projects them by allowlist.
import { Injectable, Optional } from '@nestjs/common';
import { l10n, type L10n, type Locale } from '#libs/i18n/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { MediaService } from '#modules/media/interface/media.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { textArray } from '#libs/db/index.js';
import { toPublicLocation, toPublicLocationPin } from '../api/public-projections.js';
import { PublicProfiles, type PublicLocationPin, type PublicProfileParts, type PublishedVendor } from '../interface/public-profiles.js';

type T = Record<string, string> | null;

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
}
