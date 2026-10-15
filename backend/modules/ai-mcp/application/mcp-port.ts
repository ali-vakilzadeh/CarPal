// McpClientPort (41 §1 D6/D7, GD-35): the one way the facade and the AI
// workers reach an AI tool. The port receives a context package the facade
// has already minimized and scoped to the caller's tenant (53 §2.5, §11,
// SEC-AI-4) and user text as delimited data (SEC-AI-2), and returns the
// global tool output of 53 §8.1. Adapters: the deterministic lite stub
// (CARPAL_MCP_MODE=stub) and "unavailable" (every call fails like a model
// outage, 53 §16.2). The real MCP gateway client is the next iteration.
import type { InsightType } from '#libs/contract/generated/enums.js';
import type { Locale } from '#libs/i18n/index.js';
import type { McpClientName, ToolSpec } from '../domain/tools.js';

export interface ToolPrincipal {
  type: 'user' | 'organization' | 'system';
  id: string;
  organizationId: string | null;
}

export interface ToolCall {
  tool: ToolSpec;
  client: McpClientName;
  principal: ToolPrincipal;
  locale: Locale;
  /** The insight type the facade stores the output as (its payload schema is checked, SEC-AI-5). */
  insightType: InsightType;
  /** 53 §11 context package: ids, enums, counts and short texts of the caller's own and public data. */
  context: Record<string, unknown>;
  /** SEC-AI-2: user-written text, never instructions; adapters pass it in a delimited data field. */
  userText: readonly string[];
  signal: AbortSignal;
}

export type SafetyFlag = 'safety_critical' | 'legal_sensitive' | 'privacy_sensitive';

/** A suggestion the tool proposes (stored as AiSuggestion rows, decided by a human). */
export interface ProposedSuggestion {
  target: { type: string; id: string };
  text: string;
  action: 'add' | 'update' | 'remove' | 'publish_draft' | 'confirm' | 'review';
  payload: Record<string, unknown> | null;
}

/** 53 §8.1 global tool output. */
export interface ToolOutput {
  summary: string;
  payload: Record<string, unknown> | null;
  confidence: number | null;
  evidence: { type: string; id: string }[];
  safetyFlags: SafetyFlag[];
  suggestions: ProposedSuggestion[];
  modelVersion: string;
  promptKey: string | null;
  promptVersion: string | null;
}

/** Model or gateway failure (53 §16.1 model / timeout error): the facade answers 503 AI_UNAVAILABLE. */
export class McpUnavailableError extends Error {
  constructor(message = 'AI tool unavailable') {
    super(message);
    this.name = 'McpUnavailableError';
  }
}

export abstract class McpClientPort {
  abstract invoke(call: ToolCall): Promise<ToolOutput>;
}

/** CARPAL_MCP_MODE=unavailable: every tool call fails (staging/prod until the MCP gateway exists). */
export class UnavailableMcpClient extends McpClientPort {
  async invoke(): Promise<ToolOutput> {
    throw new McpUnavailableError('no MCP gateway configured');
  }
}
