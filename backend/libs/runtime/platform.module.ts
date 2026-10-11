// PlatformModule.forRoot(): the platform libraries of one deployable as Nest
// providers (global, so every domain module can inject them). Port
// implementations owned by domain modules (MembershipDirectory,
// OrganizationDirectory, DriverAssignments, PurposeVerifier,
// AttestationVerifier) are injected optionally: modules that own them are
// @Global and export the abstract class token; until then the stubs of
// libs/authz apply.
import { Global, Inject, Module, type DynamicModule, type OnApplicationShutdown, type Provider } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Authenticator, JwtKeyRing, SessionStore, TokenService, type AttestationVerifier } from '#libs/auth/index.js';
import {
  Authorizer,
  DriverAssignments,
  EmptyDirectory,
  MembershipDirectory,
  NoDriverAssignments,
  OrganizationDirectory,
  PurposeVerifier,
  WellFormedPurposeVerifier,
} from '#libs/authz/index.js';
import { dataDir, regionConfigDir, type AppDbRole, type CarpalConfig } from '#libs/config/index.js';
import { CryptoServices } from '#libs/crypto/index.js';
import { Database } from '#libs/db/index.js';
import { FlagService } from '#libs/flags/index.js';
import { MapLinkResolver } from '#libs/geo/index.js';
import { IdempotencyStore } from '#libs/idempotency/index.js';
import { ContractValidator } from '#libs/http-pipeline/index.js';
import { createInfra, type Infra } from '#libs/infra/index.js';
import { JobRunner, JobService } from '#libs/jobs/index.js';
import { LinkTokens } from '#libs/link-tokens/index.js';
import { createLogger, type Logger } from '#libs/observability/index.js';
import { LoadShedder, RateLimiter } from '#libs/rate-limit/index.js';
import { RegionConfigService } from '#libs/region-config/index.js';
import { TxRunner } from '#libs/tenancy/index.js';
import { CARPAL_CONFIG, HOST, INFRA, LOGGER, type RuntimeHost } from './tokens.js';

const DB_ROLE: Record<RuntimeHost, AppDbRole> = {
  api: 'carpal_api',
  'admin-api': 'carpal_admin_api',
  auth: 'carpal_auth',
  worker: 'carpal_worker',
};

/** Token for an optional AttestationVerifier (auth server, S3). */
export abstract class AttestationVerifierPort implements AttestationVerifier {
  abstract verify(input: { attestation?: string; pow?: string; clientId?: string; opId: string }): Promise<boolean>;
}

export interface PlatformOptions {
  host: RuntimeHost;
  config: CarpalConfig;
  /** Shared adapters (pnpm dev runs all deployables in one process); created and owned here when absent. */
  infra?: Infra;
  /** Root logger; a child bound to the host is used. */
  logger?: Logger;
  /** Extra providers (tests override ports and services). */
  providers?: Provider[];
}

class PlatformLifecycle implements OnApplicationShutdown {
  constructor(
    private readonly database: Database,
    private readonly infra: Infra,
    private readonly ownsInfra: boolean,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.database.close();
    if (this.ownsInfra) await this.infra.close();
  }
}

@Global()
@Module({})
export class PlatformModule {
  static forRoot(o: PlatformOptions): DynamicModule {
    const config = o.config;
    const logger = (o.logger ?? createLogger({ level: config.logLevel, base: { service: 'carpal-backend', env: config.env } })).child({
      host: o.host,
    });
    const ownsInfra = !o.infra;
    const infra = o.infra ?? createInfra(config, { dataDir: config.infra === 'lite' ? dataDir : null, logger });
    const providers: Provider[] = [
      { provide: CARPAL_CONFIG, useValue: config },
      { provide: LOGGER, useValue: logger },
      { provide: INFRA, useValue: infra },
      { provide: HOST, useValue: o.host },
      { provide: Database, useFactory: () => new Database(config, DB_ROLE[o.host], { applicationName: `carpal-${o.host}` }) },
      { provide: TxRunner, useFactory: (db: Database) => new TxRunner(db, logger), inject: [Database] },
      { provide: CryptoServices, useFactory: () => new CryptoServices(config.secrets.master) },
      {
        provide: JwtKeyRing,
        useFactory: (c: CryptoServices) =>
          config.secrets.jwtPrivateJwks ? JwtKeyRing.fromPrivateJwks(config.secrets.jwtPrivateJwks) : JwtKeyRing.derived(c.keys),
        inject: [CryptoServices],
      },
      { provide: TokenService, useFactory: (k: JwtKeyRing) => new TokenService(k, config.http.issuer), inject: [JwtKeyRing] },
      { provide: SessionStore, useFactory: () => new SessionStore(infra.kv) },
      {
        provide: Authenticator,
        useFactory: (tokens: TokenService, sessions: SessionStore, c: CryptoServices, attestation?: AttestationVerifierPort) =>
          new Authenticator({
            tokens,
            sessions,
            kv: infra.kv,
            hmac: c.hmac,
            audiences: config.http.audiences,
            strict: config.strictAuth,
            ...(attestation ? { attestation } : {}),
          }),
        inject: [TokenService, SessionStore, CryptoServices, { token: AttestationVerifierPort, optional: true }],
      },
      {
        provide: Authorizer,
        useFactory: (
          authenticator: Authenticator,
          memberships?: MembershipDirectory,
          orgs?: OrganizationDirectory,
          drivers?: DriverAssignments,
          purposes?: PurposeVerifier,
        ) => {
          const empty = new EmptyDirectory();
          return new Authorizer({
            memberships: memberships ?? empty,
            organizations: orgs ?? empty,
            drivers: drivers ?? new NoDriverAssignments(),
            purposes: purposes ?? new WellFormedPurposeVerifier(),
            authenticator,
            kv: infra.kv,
            cacheTtlMs: config.pipeline.authzCacheMs,
          });
        },
        inject: [
          Authenticator,
          { token: MembershipDirectory, optional: true },
          { token: OrganizationDirectory, optional: true },
          { token: DriverAssignments, optional: true },
          { token: PurposeVerifier, optional: true },
        ],
      },
      {
        provide: FlagService,
        useFactory: (tx: TxRunner) => new FlagService(tx, config.env, config.pipeline.flagRefreshMs, logger),
        inject: [TxRunner],
      },
      {
        provide: RateLimiter,
        useFactory: () =>
          new RateLimiter({
            kv: infra.kv,
            ...(config.pipeline.rateLimitOverrides ? { overridesJson: config.pipeline.rateLimitOverrides } : {}),
            scale: config.pipeline.rateLimitScale,
            onEscalation: (key) => logger.warn({ security_event: 'rate_limit_escalation', key }, 'rate-limit escalation: temporary block'),
          }),
      },
      { provide: LoadShedder, useFactory: () => new LoadShedder(config.pipeline.maxInflight) },
      { provide: IdempotencyStore, useFactory: () => new IdempotencyStore(infra.kv) },
      { provide: ContractValidator, useFactory: () => new ContractValidator() },
      { provide: RegionConfigService, useFactory: () => new RegionConfigService(regionConfigDir, config.region) },
      { provide: LinkTokens, useFactory: (c: CryptoServices) => new LinkTokens(c.hmac), inject: [CryptoServices] },
      { provide: JobService, useFactory: () => new JobService(infra.jobs) },
      { provide: JobRunner, useFactory: (tx: TxRunner) => new JobRunner(tx, infra.jobs, logger), inject: [TxRunner] },
      { provide: MapLinkResolver, useFactory: () => new MapLinkResolver() },
      { provide: PlatformLifecycle, useFactory: (db: Database) => new PlatformLifecycle(db, infra, ownsInfra), inject: [Database] },
      ...(o.providers ?? []),
    ];
    const exported = providers.map((p) => (typeof p === 'function' ? p : p.provide)).filter((t) => t !== PlatformLifecycle);
    return { module: PlatformModule, global: true, imports: [DiscoveryModule], providers, exports: [...exported, DiscoveryModule] };
  }
}

/** Parameter decorators for the non-class tokens. */
export const InjectConfig = (): ParameterDecorator => Inject(CARPAL_CONFIG);
export const InjectLogger = (): ParameterDecorator => Inject(LOGGER);
export const InjectInfra = (): ParameterDecorator => Inject(INFRA);
