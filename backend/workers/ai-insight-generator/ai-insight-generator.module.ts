// W9 ai-insight-generator (41 §2.4) in the worker deployable: runs the §21.3
// AI feature jobs (queue ai.insight) through JobRunner, so core.background_jobs
// records running → succeeded / failed. Its event consumer (imports that asked
// for AI normalization) and the W10 skill heatmap, W11 fraud detection and W14
// embedding consumers are discovered by the consumer host; the nightly heatmap
// refresh by the scheduler.
import { Injectable, Module, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { JobRunner } from '#libs/jobs/index.js';
import { AI_INSIGHT_QUEUE, AiFeatureRunner, AiMcpWorkerModule } from '#modules/ai-mcp/ai-mcp.module.js';

@Injectable()
export class AiInsightGeneratorHost implements OnApplicationBootstrap, OnApplicationShutdown {
  #stop: (() => void) | null = null;

  constructor(
    private readonly runner: JobRunner,
    private readonly features: AiFeatureRunner,
  ) {}

  onApplicationBootstrap(): void {
    this.#stop = this.runner.register(AI_INSIGHT_QUEUE, (ctx) => this.features.run(ctx), 2);
  }

  onApplicationShutdown(): void {
    this.#stop?.();
    this.#stop = null;
  }
}

@Module({ imports: [AiMcpWorkerModule], providers: [AiInsightGeneratorHost] })
export class AiInsightGeneratorModule {}
