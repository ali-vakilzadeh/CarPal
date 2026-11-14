// admin module (41 §2.1 M15; 40 §22 reports.create, §23; SEC-ADM). Four Nest
// modules share this folder:
//   AdminModule        (global, every deployable) the admin registries
//                      (FourEyesExecutors, PurposeQueues, PurposeBindings, ModerationTargets,
//                      RetentionHandlers), FourEyes, ModerationLog, the
//                      purpose verifier of the authorizer (SEC-ADM-5) and the
//                      flag and rate cache listener (feature_flag.changed, exchange_rate.changed).
//   AdminApiModule     §23 moderation, flags, retention, assist sessions and
//                      four-eyes operations on the admin-api host.
//   AdminPublicModule  reports.create on the api host.
//   AdminWorkerModule  W15 rules: expiry of pending changes and assist
//                      sessions, the daily retention run.
import {
  Global,
  Inject,
  Injectable,
  Module,
  Optional,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { sql } from 'kysely';
import { PurposeVerifier } from '#libs/authz/index.js';
import { ApiError } from '#libs/contract/index.js';
import { uuidv7 } from '#libs/crypto/index.js';
import { FlagService } from '#libs/flags/index.js';
import { ExchangeRates } from '#libs/region-config/index.js';
import type { Infra } from '#libs/infra/index.js';
import type { Logger } from '#libs/observability/index.js';
import { HOST, InjectInfra, InjectLogger } from '#libs/runtime/index.js';
import { MetricGauges } from '#modules/analytics/interface/analytics.js';
import { AdminExpiryRule, ModerationIntakeRule, registerPlatformRetention, RetentionRule } from './application/admin-rules.js';
import { FourEyesDecideHandler, FourEyesListHandler } from './application/four-eyes-ops.js';
import { CaseSnapshots } from './application/case-snapshots.js';
import {
  CaseActionHandler,
  CaseAssignHandler,
  CaseCloseHandler,
  CaseContextHandler,
  CaseGetHandler,
  CasesListHandler,
  CaseViews,
  ReportsCreateHandler,
  ReportsListHandler,
  ReportTriageHandler,
} from './application/moderation-ops.js';
import {
  applyFlagChange,
  applyRetentionChange,
  AssistSessionEndHandler,
  AssistSessionStartHandler,
  FlagsListHandler,
  FlagUpdateHandler,
  applyExchangeRateChange,
  ExchangeRatesListHandler,
  ExchangeRateUpdateHandler,
} from './application/platform-ops.js';
import {
  AdminJobGetHandler,
  AdminRegionSettingsHandler,
  RetentionListHandler,
  RetentionUpdateHandler,
} from './application/platform-ops.js';
import {
  DbFourEyes,
  DbModerationIntake,
  DbModerationLog,
  DbPurposeSubjects,
  QueuePurposeVerifier,
} from './infrastructure/admin-services.js';
import {
  FourEyes,
  FourEyesExecutors,
  ModerationIntake,
  ModerationLog,
  ModerationTargets,
  pathRecord,
  PurposeBindings,
  PurposeQueues,
  PurposeSubjects,
  RetentionHandlers,
  StaffNames,
  type RecordBinding,
  type SubjectRef,
} from './interface/admin.js';

const OPEN_CASE = ['open', 'investigating', 'escalated'];

@Injectable()
export class AdminRegistrations implements OnModuleInit {
  constructor(
    private readonly purposes: PurposeQueues,
    private readonly bindings: PurposeBindings,
    private readonly targets: ModerationTargets,
    private readonly executors: FourEyesExecutors,
    private readonly retention: RetentionHandlers,
    private readonly flags: FlagService,
    private readonly rates: ExchangeRates,
    @Optional() private readonly gauges?: MetricGauges,
  ) {}

  onModuleInit(): void {
    this.gauges?.register('gauge.moderation_open_cases', async (scope) =>
      Number(
        (
          await sql<{
            n: string;
          }>`SELECT count(*) AS n FROM admin.moderation_cases WHERE status IN ('open','investigating','escalated') AND deleted_at IS NULL`.execute(
            scope.db,
          )
        ).rows[0]!.n,
      ),
    );
    this.gauges?.register('gauge.reports_open', async (scope) =>
      Number(
        (
          await sql<{ n: string }>`SELECT count(*) AS n FROM admin.content_reports WHERE status = 'open' AND deleted_at IS NULL`.execute(
            scope.db,
          )
        ).rows[0]!.n,
      ),
    );
    // case:<id> — an open moderation case assigned to the caller or to nobody (SEC-ADM-5). Its subjects (S14,
    // BR-09): the target, the target's author and organization (as the owning module names them) and the reporters.
    this.purposes.register('case', {
      open: async (scope, staffUserId, id) => {
        const c = await scope.db
          .selectFrom('admin.moderation_cases')
          .select(['status', 'assigned_to'])
          .where('id', '=', id)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        return !!c && OPEN_CASE.includes(c.status) && (c.assigned_to === null || c.assigned_to === staffUserId);
      },
      subjects: async (scope, id) => {
        const c = await scope.db
          .selectFrom('admin.moderation_cases')
          .select(['target_entity_type', 'target_entity_id'])
          .where('id', '=', id)
          .executeTakeFirst();
        if (!c) return [];
        const out: SubjectRef[] = [{ type: c.target_entity_type, id: c.target_entity_id }];
        const handler = this.targets.get(c.target_entity_type);
        const [author, org] = await Promise.all([
          handler?.author?.(scope, c.target_entity_id) ?? null,
          handler?.subjectOrganization?.(scope, c.target_entity_id) ?? null,
        ]);
        if (author) out.push({ type: 'user', id: author });
        if (org) out.push({ type: 'organization', id: org });
        const reporters = await scope.db
          .selectFrom('admin.content_reports')
          .select('reporter_user_id')
          .distinct()
          .where('moderation_case_id', '=', id)
          .where('deleted_at', 'is', null)
          .limit(200)
          .execute();
        for (const r of reporters) out.push({ type: 'user', id: r.reporter_user_id });
        return out;
      },
    });
    // The record of each PURP operation (S14, BR-09): a path parameter here; admin.media_download_url is bound by the
    // media module (a file is about its attachments and owning organization), admin.users_search scopes its results.
    const recordBindings: [string, RecordBinding][] = [
      ['admin.case_get', pathRecord('case', 'case_id')],
      ['admin.case_context', pathRecord('case', 'case_id')],
      ['admin.case_action', pathRecord('case', 'case_id')],
      ['admin.dispute_get', pathRecord('dispute', 'dispute_id')],
      ['admin.dispute_resolve', pathRecord('dispute', 'dispute_id')],
      ['admin.dsr_update', pathRecord('dsr', 'request_id')],
      ['admin.dsr_export', pathRecord('dsr', 'request_id')],
      ['admin.dsr_execute_deletion', pathRecord('dsr', 'request_id')],
      ['admin.verification_decide', pathRecord('verification', 'verification_id')],
      // Reading a review under its approval item or a dispute about it; deciding only under the approval item.
      ['admin.review_approval_get', pathRecord('review', 'review_id')],
      ['admin.review_approval_decide', pathRecord('approval', 'review_id')],
      ['admin.user_get', pathRecord('user', 'user_id')],
      ['admin.org_get', pathRecord('organization', 'org_id')],
      ['admin.users_search', async () => 'scoped'],
    ];
    for (const [opId, binding] of recordBindings) this.bindings.register(opId, binding);
    this.executors.register('admin.flag_update', async (scope, change) => {
      const row = await scope.db
        .selectFrom('admin.feature_flags')
        .selectAll()
        .where('id', '=', change.targetId)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw new ApiError('NOT_FOUND', { detail: 'flag gone' });
      const p = change.payload as { enabled?: boolean; targeting?: Record<string, unknown> | null; reason: string };
      await applyFlagChange(scope, this.flags, row, p, change.requestedBy);
    });
    this.executors.register('admin.exchange_rate_update', async (scope, change) => {
      const row = await scope.db
        .selectFrom('admin.exchange_rates')
        .selectAll()
        .where('id', '=', change.targetId)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw new ApiError('NOT_FOUND', { detail: 'exchange rate gone' });
      await applyExchangeRateChange(scope, this.rates, row, change.payload as { per_usd: string; reason: string }, change.requestedBy);
    });
    this.executors.register('admin.retention_update', async (scope, change) =>
      applyRetentionChange(scope, change.targetId, change.payload as Parameters<typeof applyRetentionChange>[2]),
    );
    registerPlatformRetention(this.retention);
  }
}

/** Drops this process's flag cache when any process changes a flag (SEC-AI-6: the kill switch acts at once). */
@Injectable()
export class FlagCacheListener implements OnApplicationBootstrap, OnApplicationShutdown {
  #unsubscribe: (() => void) | null = null;

  constructor(
    private readonly flags: FlagService,
    private readonly rates: ExchangeRates,
    @InjectInfra() private readonly infra: Infra,
    @InjectLogger() private readonly logger: Logger,
    @Inject(HOST) private readonly host: string,
  ) {}

  onApplicationBootstrap(): void {
    try {
      this.#unsubscribe = this.infra.bus.subscribe({
        consumer: `flags.cache.${this.host}.${uuidv7()}`,
        subjects: ['feature_flag.changed', 'exchange_rate.changed'],
        handler: async () => {
          this.flags.invalidate();
          this.rates.invalidate();
        },
      });
    } catch (err) {
      this.logger.warn({ err }, 'flag cache: no event subscription (cache refreshes by time only)');
    }
  }

  onApplicationShutdown(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }
}

@Global()
@Module({
  providers: [
    { provide: FourEyesExecutors, useFactory: () => new FourEyesExecutors() },
    { provide: PurposeQueues, useFactory: () => new PurposeQueues() },
    { provide: PurposeBindings, useFactory: () => new PurposeBindings() },
    { provide: PurposeSubjects, useClass: DbPurposeSubjects },
    { provide: ModerationTargets, useFactory: () => new ModerationTargets() },
    { provide: RetentionHandlers, useFactory: () => new RetentionHandlers() },
    StaffNames,
    { provide: FourEyes, useClass: DbFourEyes },
    { provide: ModerationLog, useClass: DbModerationLog },
    { provide: ModerationIntake, useClass: DbModerationIntake },
    { provide: PurposeVerifier, useClass: QueuePurposeVerifier },
    AdminRegistrations,
    FlagCacheListener,
  ],
  exports: [
    FourEyesExecutors,
    PurposeQueues,
    PurposeBindings,
    PurposeSubjects,
    ModerationTargets,
    RetentionHandlers,
    StaffNames,
    FourEyes,
    ModerationLog,
    ModerationIntake,
    PurposeVerifier,
  ],
})
export class AdminModule {}

@Module({
  providers: [
    CaseSnapshots,
    CaseViews,
    FourEyesListHandler,
    FourEyesDecideHandler,
    ReportsListHandler,
    ReportTriageHandler,
    CasesListHandler,
    CaseGetHandler,
    CaseContextHandler,
    CaseAssignHandler,
    CaseActionHandler,
    CaseCloseHandler,
    FlagsListHandler,
    FlagUpdateHandler,
    ExchangeRatesListHandler,
    ExchangeRateUpdateHandler,
    RetentionListHandler,
    RetentionUpdateHandler,
    AdminJobGetHandler,
    AdminRegionSettingsHandler,
    AssistSessionStartHandler,
    AssistSessionEndHandler,
  ],
})
export class AdminApiModule {}

@Module({ providers: [ReportsCreateHandler] })
export class AdminPublicModule {}

@Module({ providers: [AdminExpiryRule, RetentionRule, ModerationIntakeRule], exports: [ModerationIntakeRule] })
export class AdminWorkerModule {}

export { AdminExpiryRule, ModerationIntakeRule, RetentionRule };
