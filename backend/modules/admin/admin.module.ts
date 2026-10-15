// admin module (41 §2.1 M15; 40 §22 reports.create, §23; SEC-ADM). Four Nest
// modules share this folder:
//   AdminModule        (global, every deployable) the admin registries
//                      (FourEyesExecutors, PurposeQueues, ModerationTargets,
//                      RetentionHandlers), FourEyes, ModerationLog, the
//                      purpose verifier of the authorizer (SEC-ADM-5) and the
//                      flag cache listener (feature_flag.changed).
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
import type { Infra } from '#libs/infra/index.js';
import type { Logger } from '#libs/observability/index.js';
import { HOST, InjectInfra, InjectLogger } from '#libs/runtime/index.js';
import { MetricGauges } from '#modules/analytics/interface/analytics.js';
import { AdminExpiryRule, ModerationIntakeRule, registerPlatformRetention, RetentionRule } from './application/admin-rules.js';
import { FourEyesDecideHandler, FourEyesListHandler } from './application/four-eyes-ops.js';
import {
  CaseActionHandler,
  CaseAssignHandler,
  CaseCloseHandler,
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
} from './application/platform-ops.js';
import { RetentionListHandler, RetentionUpdateHandler } from './application/platform-ops.js';
import { DbFourEyes, DbModerationIntake, DbModerationLog, QueuePurposeVerifier } from './infrastructure/admin-services.js';
import {
  FourEyes,
  FourEyesExecutors,
  ModerationIntake,
  ModerationLog,
  ModerationTargets,
  PurposeQueues,
  RetentionHandlers,
  StaffNames,
} from './interface/admin.js';

const OPEN_CASE = ['open', 'investigating', 'escalated'];

@Injectable()
export class AdminRegistrations implements OnModuleInit {
  constructor(
    private readonly purposes: PurposeQueues,
    private readonly executors: FourEyesExecutors,
    private readonly retention: RetentionHandlers,
    private readonly flags: FlagService,
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
    // case:<id> — an open moderation case assigned to the caller or to nobody (SEC-ADM-5).
    this.purposes.register('case', async (scope, staffUserId, id) => {
      const c = await scope.db
        .selectFrom('admin.moderation_cases')
        .select(['status', 'assigned_to'])
        .where('id', '=', id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      return !!c && OPEN_CASE.includes(c.status) && (c.assigned_to === null || c.assigned_to === staffUserId);
    });
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
    @InjectInfra() private readonly infra: Infra,
    @InjectLogger() private readonly logger: Logger,
    @Inject(HOST) private readonly host: string,
  ) {}

  onApplicationBootstrap(): void {
    try {
      this.#unsubscribe = this.infra.bus.subscribe({
        consumer: `flags.cache.${this.host}.${uuidv7()}`,
        subjects: ['feature_flag.changed'],
        handler: async () => this.flags.invalidate(),
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
    CaseViews,
    FourEyesListHandler,
    FourEyesDecideHandler,
    ReportsListHandler,
    ReportTriageHandler,
    CasesListHandler,
    CaseGetHandler,
    CaseAssignHandler,
    CaseActionHandler,
    CaseCloseHandler,
    FlagsListHandler,
    FlagUpdateHandler,
    RetentionListHandler,
    RetentionUpdateHandler,
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
