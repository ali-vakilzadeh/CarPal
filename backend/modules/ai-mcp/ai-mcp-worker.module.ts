// AI worker logic (41 §2.4 W9-W11, W13, W14) for the worker deployable; the
// hosts in workers/ register the queues (ai.insight, mcp.access_log) and the
// scheduler runs the nightly heatmap rule. Event consumers are discovered by
// the consumer host.
import { Module } from '@nestjs/common';
import {
  EmbeddingIndexerConsumer,
  FraudDetectionConsumer,
  ImportNormalizationConsumer,
  McpAuditLogger,
  SkillHeatmapBuilder,
  SkillHeatmapConsumer,
  SkillHeatmapNightlyRule,
} from './application/ai-workers.js';
import { AiFeatureRunner } from './application/features.js';

export { AI_INSIGHT_QUEUE } from './application/features.js';
export { MCP_ACCESS_LOG_QUEUE } from './application/gateway.js';
export { AiFeatureRunner, McpAuditLogger, SkillHeatmapBuilder, SkillHeatmapNightlyRule };

@Module({
  providers: [
    AiFeatureRunner,
    McpAuditLogger,
    SkillHeatmapBuilder,
    SkillHeatmapConsumer,
    SkillHeatmapNightlyRule,
    FraudDetectionConsumer,
    ImportNormalizationConsumer,
    EmbeddingIndexerConsumer,
  ],
  exports: [AiFeatureRunner, McpAuditLogger, SkillHeatmapBuilder, SkillHeatmapNightlyRule],
})
export class AiMcpWorkerModule {}
