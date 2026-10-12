// Composition of the four deployables (41 §1: D1 auth, D2 api, D3 admin-api,
// D5 worker). Each is a Nest module tree on top of PlatformModule; domain
// modules are added here as the stages deliver them.
import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import type { CarpalConfig } from '#libs/config/index.js';
import type { Infra } from '#libs/infra/index.js';
import type { Logger } from '#libs/observability/index.js';
import { PlatformOpsModule } from '#libs/platform/index.js';
import { PlatformModule, type RuntimeHost } from '#libs/runtime/index.js';
import { BillingModule } from '#modules/billing/billing.module.js';
import { IdentityAccountModule } from '#modules/identity/identity-account.module.js';
import { IdentityAuthModule } from '#modules/identity/identity-auth.module.js';
import { IdentityModule } from '#modules/identity/identity.module.js';
import { InventoryApiModule } from '#modules/inventory/inventory-api.module.js';
import { InventoryWorkerModule } from '#modules/inventory/inventory-worker.module.js';
import { InventoryModule } from '#modules/inventory/inventory.module.js';
import { MediaApiModule } from '#modules/media/media-api.module.js';
import { MediaModule } from '#modules/media/media.module.js';
import { OrganizationApiModule } from '#modules/organization/organization-api.module.js';
import { OrganizationModule } from '#modules/organization/organization.module.js';
import { TaxonomyModule } from '#modules/taxonomy/taxonomy.module.js';
import { VehicleApiModule } from '#modules/vehicle/vehicle-api.module.js';
import { VehicleWorkerModule } from '#modules/vehicle/vehicle-worker.module.js';
import { VehicleModule } from '#modules/vehicle/vehicle.module.js';
import { ConsumerHostModule } from '#workers/consumer-host/consumer-host.module.js';
import { ImportJobsModule } from '#workers/import-jobs/import-jobs.module.js';
import { MediaProcessorModule } from '#workers/media-processor/media-processor.module.js';
import { OutboxRelayModule } from '#workers/outbox-relay/outbox-relay.module.js';
import { SchedulerModule } from '#workers/scheduler/scheduler.module.js';

export interface AppOptions {
  config: CarpalConfig;
  infra?: Infra;
  logger?: Logger;
  /** Extra modules (tests add handler modules). */
  imports?: DynamicModule['imports'];
  /** Extra platform providers (tests override ports). */
  providers?: Provider[];
}

/** Domain modules shared by api, admin-api and worker (ports, interfaces and their handlers). */
const DOMAIN_MODULES = [IdentityModule, OrganizationModule, BillingModule, TaxonomyModule, MediaModule, VehicleModule, InventoryModule];

function root(host: RuntimeHost, o: AppOptions, imports: NonNullable<DynamicModule['imports']>): DynamicModule {
  @Module({})
  class AppRoot {}
  Object.defineProperty(AppRoot, 'name', { value: `${host.replace(/-(.)/g, (_, c: string) => c.toUpperCase())}AppModule` });
  return {
    module: AppRoot,
    imports: [
      PlatformModule.forRoot({
        host,
        config: o.config,
        ...(o.infra ? { infra: o.infra } : {}),
        ...(o.logger ? { logger: o.logger } : {}),
        ...(o.providers ? { providers: o.providers } : {}),
      }),
      ...imports,
      ...(o.imports ?? []),
    ],
  };
}

/** D2 public API: every domain module, {me} {org} {pub} operations, platform ops. */
export const apiAppModule = (o: AppOptions): DynamicModule =>
  root('api', o, [
    ...DOMAIN_MODULES,
    IdentityAccountModule,
    OrganizationApiModule,
    MediaApiModule,
    VehicleApiModule,
    InventoryApiModule,
    PlatformOpsModule,
  ]);

/** D3 admin API: the same modules with the admin plane ({adm}) routes only. */
export const adminApiAppModule = (o: AppOptions): DynamicModule => root('admin-api', o, [...DOMAIN_MODULES]);

/** D1 auth server: identity account logic behind /oauth/*, /v1/auth/*, /.well-known/* (carpal_auth: identity schema only). */
export const authAppModule = (o: AppOptions): DynamicModule => root('auth', o, [IdentityModule, IdentityAuthModule]);

/** D5 workers: W1 outbox relay, event consumers, W6 media processor, W7 import jobs, W15 scheduler and module rules. */
export const workerAppModule = (o: AppOptions): DynamicModule =>
  root('worker', o, [
    ...DOMAIN_MODULES,
    OutboxRelayModule,
    ConsumerHostModule,
    MediaProcessorModule,
    ImportJobsModule,
    VehicleWorkerModule,
    InventoryWorkerModule,
    SchedulerModule,
  ]);
