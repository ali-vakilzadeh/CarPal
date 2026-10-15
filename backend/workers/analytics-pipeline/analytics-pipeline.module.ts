// W12 analytics-pipeline (41 §2.4) in the worker deployable: client event
// batches accepted by events.ingest (queue analytics.ingest) are
// pseudonymized and written to the analytics database. Business events reach
// W12 through the outbox consumer AnalyticsEventConsumer (consumer host); the
// daily aggregates and partitions are W15 rules of AnalyticsWorkerModule.
import { Injectable, Module, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type { Infra } from '#libs/infra/index.js';
import { InjectInfra } from '#libs/runtime/index.js';
import { ANALYTICS_INGEST_QUEUE, AnalyticsIngestProcessor, AnalyticsWorkerModule } from '#modules/analytics/analytics.module.js';

@Injectable()
export class AnalyticsPipelineHost implements OnApplicationBootstrap, OnApplicationShutdown {
  #stop: (() => void) | null = null;

  constructor(
    @InjectInfra() private readonly infra: Infra,
    private readonly processor: AnalyticsIngestProcessor,
  ) {}

  onApplicationBootstrap(): void {
    this.#stop = this.infra.jobs.process(ANALYTICS_INGEST_QUEUE, (job) => this.processor.run(job), 2);
  }

  onApplicationShutdown(): void {
    this.#stop?.();
    this.#stop = null;
  }
}

@Module({ imports: [AnalyticsWorkerModule], providers: [AnalyticsPipelineHost] })
export class AnalyticsPipelineModule {}
