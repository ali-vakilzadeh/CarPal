// ai-mcp module (41 §2.1 M16; 40 §21, §23.5; GD-35). Three Nest modules
// share this folder:
//   AiMcpModule        (global, every deployable) the in-process MCP gateway
//                      (McpClientPort: lite stub or unavailable; carpal_ai
//                      store; policy pre-checks; access log hand-off to W13),
//                      AiReferences, SuggestionAppliers and AiContextSources
//                      for the modules that own the data, the S8
//                      registrations (DSR, retention, taxonomy, gauges,
//                      ai_output moderation, MCP client 4EYES) and the §23.5
//                      admin data operations (admin-api host).
//   AiMcpApiModule     the §21 operations on the api host (ai-mcp-api.module.ts).
//   AiMcpWorkerModule  W9-W11, W13, W14 logic for workers/ (ai-mcp-worker.module.ts).
import { Global, Module } from '@nestjs/common';
import type { CarpalConfig } from '#libs/config/index.js';
import { CARPAL_CONFIG } from '#libs/runtime/index.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import {
  AiInsightsSearchHandler,
  AiMcpAdminRegistrations,
  McpAccessLogSearchHandler,
  McpClientsListHandler,
  McpClientUpdateHandler,
} from './application/admin-ops.js';
import { McpGateway } from './application/gateway.js';
import { McpClientPort, UnavailableMcpClient } from './application/mcp-port.js';
import { AiReferencesImpl } from './application/references.js';
import { AiMcpRegistrations } from './application/registrations.js';
import { AiStore } from './infrastructure/ai-store.js';
import { LiteMcpClient } from './infrastructure/lite-mcp.js';
import { AiContextSources, AiReferences, SuggestionAppliers } from './interface/ai.js';

@Global()
@Module({
  providers: [
    AiStore,
    {
      provide: McpClientPort,
      useFactory: (config: CarpalConfig, taxonomy: TaxonomyResolver) =>
        config.mcp.mode === 'stub' ? new LiteMcpClient(taxonomy, config) : new UnavailableMcpClient(),
      inject: [CARPAL_CONFIG, TaxonomyResolver],
    },
    McpGateway,
    { provide: AiReferences, useClass: AiReferencesImpl },
    { provide: SuggestionAppliers, useFactory: () => new SuggestionAppliers() },
    { provide: AiContextSources, useFactory: () => new AiContextSources() },
    AiMcpAdminRegistrations,
    AiMcpRegistrations,
    // admin-api host (§23.5); other hosts skip them.
    AiInsightsSearchHandler,
    McpClientsListHandler,
    McpClientUpdateHandler,
    McpAccessLogSearchHandler,
  ],
  exports: [AiStore, McpClientPort, McpGateway, AiReferences, SuggestionAppliers, AiContextSources],
})
export class AiMcpModule {}

export { AiMcpApiModule } from './ai-mcp-api.module.js';
export {
  AiMcpWorkerModule,
  AI_INSIGHT_QUEUE,
  MCP_ACCESS_LOG_QUEUE,
  AiFeatureRunner,
  McpAuditLogger,
  SkillHeatmapBuilder,
  SkillHeatmapNightlyRule,
} from './ai-mcp-worker.module.js';
