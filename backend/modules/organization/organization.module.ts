// organization module (41 §2.1 M2; 40 §7-§9). Two Nest modules share this folder:
//   OrganizationModule     (global, every deployable) the ports organization
//                          serves: OrganizationDirectory (L4), OrgCards,
//                          ProviderCapabilities, PublicProfiles (public
//                          projections for S6), VendorCatalog and OrgLocations
//                          (inventory, S5), ProviderBooking (appointments,
//                          S7), TrustFigures (W3 trust scoring, S7), the OrganizationExtensions
//                          registry, its media attachment targets and the
//                          consent.withdrawn consumer (run by the worker).
//   OrganizationApiModule  §7-§9 operations on the api host (organization-api.module.ts)
import { Global, Injectable, Module, Optional, type OnModuleInit } from '@nestjs/common';
import { OrganizationDirectory } from '#libs/authz/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { AttachmentTargets, type AttachmentTarget } from '#modules/media/interface/media.js';
import { OrganizationAdminRegistrations } from './application/admin-registrations.js';
import { OrganizationAiRegistrations } from './application/ai-registrations.js';
import { ConsentWithdrawnPortfolioConsumer } from './events/consent-withdrawn.consumer.js';
import { ReactionChangedPortfolioConsumer } from './events/reaction-changed.consumer.js';
import { DbProviderBooking } from './infrastructure/booking.js';
import { DbOrgLifecycle } from './infrastructure/lifecycle.js';
import { DbOrganizationDirectory } from './infrastructure/organization-directory.js';
import { DbOrgCards } from './infrastructure/org-cards.js';
import { DbProviderCapabilities } from './infrastructure/provider-capabilities.js';
import { DbPublicOrgCards } from './infrastructure/public-org-cards.js';
import { DbPublicProfiles } from './infrastructure/public-profiles.js';
import { DbTrustFigures } from './infrastructure/trust-figures.js';
import { DbOrgLocations, DbVendorCatalog } from './infrastructure/vendor-catalog.js';
import { ProviderBooking } from './interface/booking.js';
import { OrgLifecycle } from './interface/lifecycle.js';
import { OrganizationExtensions } from './interface/extensions.js';
import { OrgCards } from './interface/org-cards.js';
import { ProviderCapabilities } from './interface/provider-capabilities.js';
import { PublicOrgCards, PublicProfiles } from './interface/public-profiles.js';
import { TrustFigures } from './interface/trust-figures.js';
import { OrgLocations, VendorCatalog } from './interface/vendor-catalog.js';

const orgTarget = (id: string | undefined, groups: string[]): AttachmentTarget | null =>
  id ? { owner: { type: 'organization', id }, groups } : null;

/**
 * Records of this module that media can be attached to (media.attach asks
 * the owning module): the organization itself (logo, cover: M+), portfolio
 * items (before/after, gallery: P*) and job logs (photos: P*).
 */
@Injectable()
export class OrganizationRegistrations implements OnModuleInit {
  constructor(@Optional() private readonly targets?: AttachmentTargets) {}

  onModuleInit(): void {
    if (!this.targets) return;
    this.targets.register('organization', async (scope: TxScope, id) => {
      const o = await scope.db
        .selectFrom('organization.organizations')
        .select('id')
        .where('id', '=', id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      return orgTarget(o?.id, ['M+']);
    });
    this.targets.register('portfolio_item', async (scope, id) => {
      const p = await scope.db
        .selectFrom('organization.portfolio_items')
        .select('provider_organization_id')
        .where('id', '=', id)
        .where('status', '<>', 'archived')
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      return orgTarget(p?.provider_organization_id, ['P*']);
    });
    this.targets.register('provider_job_log', async (scope, id) => {
      const j = await scope.db
        .selectFrom('organization.provider_job_logs')
        .select('provider_organization_id')
        .where('id', '=', id)
        .where('status', '=', 'active')
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      return orgTarget(j?.provider_organization_id, ['P*']);
    });
  }
}

@Global()
@Module({
  providers: [
    { provide: OrganizationDirectory, useClass: DbOrganizationDirectory },
    { provide: OrgCards, useClass: DbOrgCards },
    { provide: ProviderCapabilities, useClass: DbProviderCapabilities },
    { provide: PublicProfiles, useClass: DbPublicProfiles },
    { provide: PublicOrgCards, useClass: DbPublicOrgCards },
    { provide: VendorCatalog, useClass: DbVendorCatalog },
    { provide: OrgLocations, useClass: DbOrgLocations },
    { provide: ProviderBooking, useClass: DbProviderBooking },
    { provide: TrustFigures, useClass: DbTrustFigures },
    { provide: OrgLifecycle, useClass: DbOrgLifecycle },
    // One registry per application context (contexts share a process in pnpm dev and tests).
    { provide: OrganizationExtensions, useFactory: () => new OrganizationExtensions() },
    OrganizationRegistrations,
    OrganizationAdminRegistrations,
    OrganizationAiRegistrations,
    ConsentWithdrawnPortfolioConsumer,
    ReactionChangedPortfolioConsumer,
  ],
  exports: [
    OrganizationDirectory,
    OrgCards,
    ProviderCapabilities,
    PublicProfiles,
    PublicOrgCards,
    VendorCatalog,
    OrgLocations,
    ProviderBooking,
    TrustFigures,
    OrgLifecycle,
    OrganizationExtensions,
  ],
})
export class OrganizationModule {}
