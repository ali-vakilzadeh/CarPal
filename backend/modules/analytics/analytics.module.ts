// analytics module (41 §2.1 M14; 40 §22 events.ingest, §23.5 audit search and
// dashboards; W12). Two Nest modules share this folder:
//   AnalyticsModule        (global, every deployable) the analytics database
//                          pools, the W12 sink and event consumer, the gauge
//                          registry, its DSR erase (pseudonym key), and the
//                          handlers (events.ingest on api; audit search and
//                          dashboards on admin-api: other hosts skip them).
//   AnalyticsWorkerModule  W12 ingest processor and the W15 rules: daily
//                          aggregates and monthly partitions of the analytics
//                          database (hosted by workers/analytics-pipeline and
//                          the scheduler).
import { Global, Injectable, Module, Optional, type OnModuleInit } from '@nestjs/common';
import { PersonalDataRegistry } from '#modules/identity/interface/identity.js';
import { AnalyticsDashboardHandler, AuditSearchHandler, EventsIngestHandler } from './application/analytics-ops.js';
import {
  AnalyticsEventConsumer,
  AnalyticsIngestProcessor,
  AnalyticsPartitionsRule,
  AnalyticsPools,
  AnalyticsSink,
  DailyMetricsRule,
} from './application/pipeline.js';
import { MetricGauges } from './interface/analytics.js';

export {
  ANALYTICS_INGEST_QUEUE,
  AnalyticsIngestProcessor,
  AnalyticsPools,
  AnalyticsSink,
  DailyMetricsRule,
} from './application/pipeline.js';

/** DSR deletion deletes the pseudonym key: the user's past analytics events become unlinkable (52 ActorPseudonym). */
@Injectable()
export class AnalyticsRegistrations implements OnModuleInit {
  constructor(
    private readonly sink: AnalyticsSink,
    @Optional() private readonly personal?: PersonalDataRegistry,
  ) {}

  onModuleInit(): void {
    this.personal?.register('analytics', { erase: (scope, userId) => this.sink.forget(scope, userId) });
  }
}

@Global()
@Module({
  providers: [
    AnalyticsPools,
    AnalyticsSink,
    // One registry per application context (contexts share a process in pnpm dev and tests).
    { provide: MetricGauges, useFactory: () => new MetricGauges() },
    AnalyticsEventConsumer,
    AnalyticsRegistrations,
    EventsIngestHandler,
    AuditSearchHandler,
    AnalyticsDashboardHandler,
  ],
  exports: [AnalyticsPools, AnalyticsSink, MetricGauges],
})
export class AnalyticsModule {}

@Module({
  providers: [AnalyticsIngestProcessor, DailyMetricsRule, AnalyticsPartitionsRule],
  exports: [AnalyticsIngestProcessor, DailyMetricsRule],
})
export class AnalyticsWorkerModule {}
