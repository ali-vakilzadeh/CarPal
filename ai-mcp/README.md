# AI & MCP Platform

WP17 + WP18: the governed AI "integration spine" (MVP plan sections 7–9.4). Every AI feature and future external agent (OBDII, telematics, insurance, partners) reaches platform data only through this layer.

| Folder | Responsibility |
| :--- | :--- |
| `mcp-gateway/` | MCP server: client registry, resource catalog, tool catalog, policy engine (scopes, consent, redaction, human approval, rate limits), tool executor, immutable audit/access log. |
| `ai-inference/` | LLM orchestration (prompt selection, model routing, retries, fallback, streaming/async, cost controls), context service, insight store, vector index access (pgvector). Also the AI features from WP18. |
| `prompts/` | Versioned prompt registry (triage, review response, skill heatmap, inventory normalization, pre-visit summary, showroom caption), with EN/FA output support. |
| `pipelines/` | Event-driven AI consumers: AI insight generator, skill heatmap pipeline, fraud detection pipeline, MCP audit logger. |
| `evaluation/` | Evaluation store and AI quality tracking: acceptance, edit and correction rates, moderator overrides, match acceptance, hallucination reports, eval sets (EN/FA). |

Principle: **AI drafts, humans approve.** Write tools only create drafts, never final public changes.
