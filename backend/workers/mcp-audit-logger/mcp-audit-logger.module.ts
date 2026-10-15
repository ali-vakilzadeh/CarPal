// W13 mcp-audit-logger (41 §2.4): persists the McpAccessLog records the MCP
// gateway hands over asynchronously (queue mcp.access_log) and warns on
// denied calls.
import { Injectable, Module, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type { Infra } from '#libs/infra/index.js';
import { InjectInfra } from '#libs/runtime/index.js';
import { AiMcpWorkerModule, MCP_ACCESS_LOG_QUEUE, McpAuditLogger } from '#modules/ai-mcp/ai-mcp.module.js';

@Injectable()
export class McpAuditLoggerHost implements OnApplicationBootstrap, OnApplicationShutdown {
  #stop: (() => void) | null = null;

  constructor(
    private readonly logger: McpAuditLogger,
    @InjectInfra() private readonly infra: Infra,
  ) {}

  onApplicationBootstrap(): void {
    this.#stop = this.infra.jobs.process(MCP_ACCESS_LOG_QUEUE, (job) => this.logger.persist(job), 2);
  }

  onApplicationShutdown(): void {
    this.#stop?.();
    this.#stop = null;
  }
}

@Module({ imports: [AiMcpWorkerModule], providers: [McpAuditLoggerHost] })
export class McpAuditLoggerModule {}
