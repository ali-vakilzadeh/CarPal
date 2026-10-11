// Platform operations of 40 §22 owned by backend/libs: health.get,
// config.client, jobs.get, jobs.cancel.
import { Inject, Injectable, Optional } from '@nestjs/common';
import { Authorizer } from '#libs/authz/index.js';
import { ApiError } from '#libs/contract/index.js';
import { type CarpalConfig } from '#libs/config/index.js';
import { FlagService } from '#libs/flags/index.js';
import { Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import { JobService, toJobView, type JobRow } from '#libs/jobs/index.js';
import { RegionConfigService } from '#libs/region-config/index.js';
import { CARPAL_CONFIG } from '#libs/runtime/tokens.js';
import type { TxScope } from '#libs/tenancy/index.js';

/** Version of the taxonomy dictionary the clients cache (taxonomy module, S3). */
export abstract class TaxonomyVersion {
  abstract current(): Promise<string>;
}
/** Catalog version seeded from Docs/44 (42 §8) until the taxonomy module provides it. */
const SEEDED_TAXONOMY_VERSION = '1.0.0';

@Injectable()
@Operation('health.get')
export class HealthHandler implements OperationHandler {
  handle(): OperationResult {
    // Liveness only: no version or dependency details (40 §22.2).
    return { body: { status: 'ok' } };
  }
}

@Injectable()
@Operation('config.client')
export class ClientConfigHandler implements OperationHandler {
  constructor(
    @Inject(CARPAL_CONFIG) private readonly config: CarpalConfig,
    private readonly flags: FlagService,
    private readonly region: RegionConfigService,
    @Optional() @Inject(TaxonomyVersion) private readonly taxonomy?: TaxonomyVersion,
  ) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const p = ctx.principal;
    const flags = await this.flags.evaluateAll({
      ...(p.kind === 'user' ? { userId: p.userId } : {}),
      ...(p.kind === 'anonymous' ? { anonKey: p.anonKey } : {}),
      region: this.config.region,
    });
    return {
      body: {
        min_supported_version: (ctx.client && this.config.http.clientMinVersions[ctx.client.clientId]) ?? '1.0.0',
        latest_version: this.config.http.clientLatestVersion,
        contract_version: '1.0.0',
        i18n: { version: this.config.http.i18n.version, base_url: this.config.http.i18n.baseUrl },
        taxonomy_version: (await this.taxonomy?.current()) ?? SEEDED_TAXONOMY_VERSION,
        flags,
        region: this.region.forLocale(ctx.locale),
      },
      // Cacheable for 5 min per locale for anonymous callers (the pipeline keeps user responses private).
      cache: { public: 300 },
      contentLanguage: ctx.locale,
    };
  }
}

/**
 * Finds a job the caller may see: their own (owner), or one of an
 * organization they are an active member of (USR | ORG(ANY)). RLS
 * (core.background_jobs owner_all) enforces the same rule.
 */
async function findVisibleJob(scope: TxScope, authorizer: Authorizer, userId: string, jobId: string): Promise<JobRow | undefined> {
  const find = () => scope.db.selectFrom('core.background_jobs').selectAll().where('id', '=', jobId).executeTakeFirst();
  const own = await find();
  if (own) return own;
  for (const m of await authorizer.memberships(userId)) {
    await scope.setOrganization(m.orgId, m.role);
    const row = await find();
    if (row) return row;
  }
  return undefined;
}

@Injectable()
@Operation('jobs.get')
export class JobsGetHandler implements OperationHandler {
  constructor(private readonly authorizer: Authorizer) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    if (ctx.principal.kind !== 'user') throw new ApiError('NOT_FOUND');
    const userId = ctx.principal.userId;
    const row = await ctx.tx((scope) => findVisibleJob(scope, this.authorizer, userId, ctx.params.job_id!), { readOnly: true });
    if (!row) throw new ApiError('NOT_FOUND');
    return { body: toJobView(row) };
  }
}

@Injectable()
@Operation('jobs.cancel')
export class JobsCancelHandler implements OperationHandler {
  constructor(private readonly jobs: JobService) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    if (ctx.principal.kind !== 'user') throw new ApiError('NOT_FOUND');
    const userId = ctx.principal.userId;
    const row = await ctx.tx(async (scope) => {
      // "Cancels a queued or running job the caller started": the owner only.
      const job = await scope.db
        .selectFrom('core.background_jobs')
        .selectAll()
        .where('id', '=', ctx.params.job_id!)
        .where('owner_user_id', '=', userId)
        .forUpdate()
        .executeTakeFirst();
      if (!job) throw new ApiError('NOT_FOUND');
      return this.jobs.cancel(scope, job);
    });
    return { body: toJobView(row) };
  }
}
