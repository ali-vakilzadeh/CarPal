// Counts behind profile completeness and the publish rules (52 §21), read
// in the member's RLS context. Figures owned by other modules come from
// OrganizationExtensions (0 until those modules register).
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { TxScope } from '#libs/tenancy/index.js';
import type { ProviderFacts, VendorFacts } from '../domain/profile-rules.js';
import { OrganizationExtensions } from '../interface/extensions.js';

@Injectable()
export class ProfileFacts {
  constructor(private readonly ext: OrganizationExtensions) {}

  async #locations(scope: TxScope, orgId: string) {
    const r = await scope.db
      .selectFrom('organization.organization_locations')
      .select([
        sql<number>`count(*) FILTER (WHERE status = 'active')::int`.as('active'),
        sql<number>`count(*) FILTER (WHERE status = 'active' AND location_verified_at IS NOT NULL)::int`.as('verified'),
        sql<number>`count(*) FILTER (WHERE status = 'active' AND hours IS NOT NULL)::int`.as('hours'),
      ])
      .where('organization_id', '=', orgId)
      .where('deleted_at', 'is', null)
      .executeTakeFirstOrThrow();
    return { active: Number(r.active), verified: Number(r.verified), hours: Number(r.hours) };
  }

  async #orgStatus(scope: TxScope, orgId: string): Promise<string> {
    const o = await scope.db.selectFrom('organization.organizations').select('status').where('id', '=', orgId).executeTakeFirst();
    return o?.status ?? 'archived';
  }

  async #count(
    scope: TxScope,
    table:
      | 'organization.provider_service_categories'
      | 'organization.provider_vehicle_coverage'
      | 'organization.provider_certifications'
      | 'organization.portfolio_items'
      | 'organization.vendor_coverage',
    orgColumn: 'provider_organization_id' | 'vendor_organization_id',
    orgId: string,
    statuses: string[],
  ): Promise<number> {
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM ${sql.table(table)}
       WHERE ${sql.ref(orgColumn)} = ${orgId}::uuid AND status = ANY(${statuses}::text[]) AND deleted_at IS NULL`.execute(scope.db);
    return Number(rows[0]?.n ?? 0);
  }

  async provider(scope: TxScope, orgId: string): Promise<ProviderFacts> {
    const profile = await scope.db
      .selectFrom('organization.provider_profiles')
      .selectAll()
      .where('organization_id', '=', orgId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    const loc = await this.#locations(scope, orgId);
    const today = new Date().toISOString().slice(0, 10);
    const period = { from: today, to: today };
    return {
      orgStatus: await this.#orgStatus(scope, orgId),
      hasProfile: !!profile,
      publicStatus: profile?.public_status ?? null,
      descriptionSet: !!profile?.description_translations,
      contactChannels: Array.isArray(profile?.contact_channels) ? profile.contact_channels.length : 0,
      activeLocations: loc.active,
      verifiedLocations: loc.verified,
      hoursSet: loc.hours > 0,
      activeServiceCategories: await this.#count(scope, 'organization.provider_service_categories', 'provider_organization_id', orgId, [
        'active',
      ]),
      activeCoverage: await this.#count(scope, 'organization.provider_vehicle_coverage', 'provider_organization_id', orgId, ['active']),
      portfolioItems: await this.#count(scope, 'organization.portfolio_items', 'provider_organization_id', orgId, [
        'draft',
        'pending_review',
        'published',
      ]),
      activeCertifications: await this.#count(scope, 'organization.provider_certifications', 'provider_organization_id', orgId, ['active']),
      appointmentCapacityEnabled: profile?.appointment_capacity_enabled ?? false,
      reviewCount: await this.ext.insight('provider.review_count', scope, orgId, period, 0),
      responseRateKnown: profile?.measured_response_time_minutes !== null && profile?.measured_response_time_minutes !== undefined,
    };
  }

  async vendor(scope: TxScope, orgId: string): Promise<VendorFacts> {
    const profile = await scope.db
      .selectFrom('organization.vendor_profiles')
      .selectAll()
      .where('organization_id', '=', orgId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    const loc = await this.#locations(scope, orgId);
    return {
      orgStatus: await this.#orgStatus(scope, orgId),
      hasProfile: !!profile,
      publicStatus: profile?.public_status ?? null,
      descriptionSet: !!profile?.description_translations,
      activeLocations: loc.active,
      verifiedLocations: loc.verified,
      hoursSet: loc.hours > 0,
      returnPolicySet: !!profile?.return_policy_translations,
      warrantyPolicySet: !!profile?.warranty_policy_translations,
      responseTargetSet: !!profile?.response_time_target,
      activeCoverage: await this.#count(scope, 'organization.vendor_coverage', 'vendor_organization_id', orgId, ['active']),
      catalogComingSoon: profile?.catalog_coming_soon ?? false,
      activeItems: await this.ext.activeItems(scope, orgId),
    };
  }
}
