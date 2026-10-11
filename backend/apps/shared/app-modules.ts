// Composition of the four deployables (41 §1: D1 auth, D2 api, D3 admin-api,
// D5 worker). Each is a Nest module tree on top of PlatformModule; domain
// modules are added here as the stages deliver them.
import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import type { CarpalConfig } from '#libs/config/index.js';
import type { Infra } from '#libs/infra/index.js';
import type { Logger } from '#libs/observability/index.js';
import { PlatformOpsModule } from '#libs/platform/index.js';
import { PlatformModule, type RuntimeHost } from '#libs/runtime/index.js';
import { IdentityModule } from '#modules/identity/identity.module.js';
import { OrganizationModule } from '#modules/organization/organization.module.js';
import { ConsumerHostModule } from '#workers/consumer-host/consumer-host.module.js';
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

/** Domain modules shared by api, admin-api and auth (only their port implementations exist in S2). */
const DOMAIN_MODULES = [IdentityModule, OrganizationModule];

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
export const apiAppModule = (o: AppOptions): DynamicModule => root('api', o, [...DOMAIN_MODULES, PlatformOpsModule]);

/** D3 admin API: the same modules with the admin plane ({adm}) routes only. */
export const adminApiAppModule = (o: AppOptions): DynamicModule => root('admin-api', o, [...DOMAIN_MODULES]);

/** D1 auth server: identity account logic behind /oauth/*, /v1/auth/*, /.well-known/*. */
export const authAppModule = (o: AppOptions): DynamicModule => root('auth', o, [IdentityModule]);

/** D5 workers: W1 outbox relay, event consumers, W15 scheduler. */
export const workerAppModule = (o: AppOptions): DynamicModule =>
  root('worker', o, [...DOMAIN_MODULES, OutboxRelayModule, ConsumerHostModule, SchedulerModule]);
