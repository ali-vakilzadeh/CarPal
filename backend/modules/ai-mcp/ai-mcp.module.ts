// ai-mcp module (41 §2.1 M16; 40 §21, §23.5). S8 delivers the admin-plane
// data operations only (AI oversight: insights search, MCP client registry,
// access log search) and the ai_output moderation target; the §21 facade,
// McpClientPort and the AI workers arrive in S9 (GD-07).
import { Global, Module } from '@nestjs/common';
import {
  AiInsightsSearchHandler,
  AiMcpAdminRegistrations,
  McpAccessLogSearchHandler,
  McpClientsListHandler,
  McpClientUpdateHandler,
} from './application/admin-ops.js';

@Global()
@Module({
  providers: [
    AiMcpAdminRegistrations,
    // admin-api host (§23.5); other hosts skip them.
    AiInsightsSearchHandler,
    McpClientsListHandler,
    McpClientUpdateHandler,
    McpAccessLogSearchHandler,
  ],
})
export class AiMcpModule {}
