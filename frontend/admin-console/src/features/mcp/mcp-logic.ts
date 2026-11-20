// MCP client rules (AC13.T2/T3, Docs/23 A-MCP-01/02, Docs/40 admin.mcp_client_update, backend ai-mcp admin-ops):
// - a change of scopes, resources or tools waits for a second administrator (202 PendingChange), even when the list is
//   the same, and replaces the whole list; so the console sends only the lists that changed, keeps values it does not
//   know (the backend checks none of them) and never sends a status with them (a suspension would then wait too);
// - suspending (and revoking) applies at once; reactivating a suspended client waits for a second administrator;
//   revoked is final (the console does not offer it: token handling is out of scope, Docs/23 Rotate, DI-37).
import type { McpAccessLogView, McpClientView } from '@carpal/api-contracts';
import { MCP_RESOURCES, MCP_SCOPES, MCP_TOOLS } from '@/lib/config/mcp-catalog';
import type { MessageKey, Translate } from '@/lib/i18n/keys';

export type AccessField = 'allowed_scopes' | 'allowed_resources' | 'allowed_tools';
export const ACCESS_FIELDS: readonly AccessField[] = ['allowed_scopes', 'allowed_resources', 'allowed_tools'];

export const CATALOG: Record<AccessField, readonly string[]> = {
  allowed_scopes: MCP_SCOPES,
  allowed_resources: MCP_RESOURCES,
  allowed_tools: MCP_TOOLS,
};

/** The domain of a catalog value: "read:vehicle.summary:owned" → vehicle, "res:taxonomy.vehicle.brands" → taxonomy. */
export function domainOf(value: string): string {
  const body = value.includes(':') ? value.slice(value.indexOf(':') + 1) : value;
  return body.split(/[.:@]/)[0] || value;
}

export interface CatalogGroup {
  /** The domain, or null for "Other" (values not in the catalog). */
  domain: string | null;
  values: string[];
}

/** The checkbox tree of one field: catalog values by domain, then the client's values the catalog lacks. */
export function catalogTree(field: AccessField, current: readonly string[]): CatalogGroup[] {
  const known = new Set(CATALOG[field]);
  const groups = new Map<string, string[]>();
  for (const v of CATALOG[field]) {
    const d = domainOf(v);
    groups.set(d, [...(groups.get(d) ?? []), v]);
  }
  const out: CatalogGroup[] = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([domain, values]) => ({ domain, values }));
  const other = [...new Set(current.filter((v) => !known.has(v)))].sort();
  if (other.length) out.push({ domain: null, values: other });
  return out;
}

export type AccessDraft = Record<AccessField, string[]>;

export const draftOf = (c: McpClientView): AccessDraft => ({
  allowed_scopes: [...c.allowed_scopes],
  allowed_resources: [...c.allowed_resources],
  allowed_tools: [...c.allowed_tools],
});

const sameSet = (a: readonly string[], b: readonly string[]) => {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((v) => sb.has(v));
};

/** The lists that changed (only those are sent), with what was added and removed in each. */
export function accessChanges(c: McpClientView, draft: AccessDraft) {
  const body: Partial<Record<AccessField, string[]>> = {};
  const diff: { field: AccessField; added: string[]; removed: string[] }[] = [];
  for (const f of ACCESS_FIELDS) {
    if (sameSet(c[f], draft[f])) continue;
    body[f] = [...new Set(draft[f])];
    diff.push({ field: f, added: draft[f].filter((v) => !c[f].includes(v)), removed: c[f].filter((v) => !draft[f].includes(v)) });
  }
  return { body, diff };
}

export type StatusAction = 'suspend' | 'reactivate';

/** What a client's status allows: suspend an active client (at once), reactivate a suspended one (four-eyes). */
export function statusAction(status: McpClientView['status']): StatusAction | null {
  return status === 'active' ? 'suspend' : status === 'suspended' ? 'reactivate' : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Labels ("Unknown (<value>)" for a value this console does not know, PWA P13 rule)

const CLIENT_TYPES = ['internal_assistant', 'matching_engine', 'moderation_assistant', 'analytics_engine', 'partner_agent_future'];
const STATUSES = ['active', 'suspended', 'revoked'];
const ENVIRONMENTS = ['dev', 'staging', 'prod'];
export const POLICY_DECISIONS: readonly McpAccessLogView['policy_decision'][] = [
  'allowed',
  'denied',
  'consent_required',
  'approval_required',
  'rate_limited',
  'error',
];
const RISKS = ['read_only', 'personalized_read', 'draft_creation', 'external_action', 'admin_action'];
const RESULTS = ['success', 'failure', 'partial'];
const OP_TYPES = ['resource_read', 'tool_invoke'];

const label = (known: readonly string[], prefix: string) => (v: string, t: Translate) =>
  known.includes(v) ? t(`admin.mcp.${prefix}.${v}` as MessageKey) : t('admin.kit.unknown', { value: v });

export const clientTypeLabel = label(CLIENT_TYPES, 'clientType');
export const clientStatusLabel = label(STATUSES, 'status');
export const environmentLabel = label(ENVIRONMENTS, 'environment');
export const decisionLabel = label(POLICY_DECISIONS, 'decision');
export const riskLabel = label(RISKS, 'risk');
export const resultLabel = label(RESULTS, 'result');
export const operationTypeLabel = label(OP_TYPES, 'opType');
