'use client';
// MCP access log (AC13.T3, Docs/23 A-MCP-02, Docs/40 admin.mcp_access_log_search; ADM, rate-limited, audited): every
// AI read of data and every AI tool call — client, the principal it acted for (masked), the resource or tool, risk,
// the policy decision, the consent and approval behind it, the model, the result and the latency. Read-only and
// immutable. Staff press Search (the search is recorded); a principal id is matched exactly. An entry with an AI output
// links to it on AI oversight (by organization and day: no operation reads one insight by id, DI-37). A link with
// ?log=<id> (from an AI evidence block) opens this tab and marks that entry when the search finds it. Export of the
// results (Docs/23 "logged") has no operation (DI-37).
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { McpAccessLogView, McpClientView } from '@carpal/api-contracts';
import { DataTable, maskTail, useCursorPaging, type Column } from '@/components/admin';
import { Badge } from '@/components/ds/badge';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { useApiQuery } from '@/lib/api/query';
import { MCP_RESOURCES, MCP_TOOLS } from '@/lib/config/mcp-catalog';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { dayIn } from '@/features/analytics';
import {
  defaultDays,
  ID_RE,
  TextFilter,
  useUrlSearch,
  WindowField,
  windowDraftProblem,
  type SearchWindow,
  type WindowDraft,
} from '@/features/audit';
import { decisionLabel, operationTypeLabel, POLICY_DECISIONS, resultLabel, riskLabel } from './mcp-logic';

const KEYS = ['client', 'key', 'decision', 'principal'] as const;
const PAGE = 50;
/** The gateway logs `tool:<key>` without the version and `res:<key>` (backend ai-mcp gateway). */
const KEY_SUGGESTIONS = [...MCP_RESOURCES, ...MCP_TOOLS.map((v) => v.replace(/@\d+$/, ''))];

type Draft = Record<(typeof KEYS)[number], string> & { window: WindowDraft };

export function AccessLog({ clients }: { clients: readonly McpClientView[] }) {
  const t = useT();
  const f = useFormat();
  const params = useSearchParams();
  const highlight = params.get('log');
  const search = useUrlSearch(KEYS);
  const [draft, setDraft] = useState<Draft>(() => {
    const days = search.window?.kind === 'days' ? search.window : defaultDays(Date.now(), f.timeZone);
    return {
      ...search.values,
      window: {
        choice: search.window?.kind === 'preset' ? search.window.preset : search.window ? 'days' : '7',
        from: days.from,
        to: days.to,
      },
    };
  });
  const [tried, setTried] = useState(false);
  const principalProblem = draft.principal.trim() && !ID_RE.test(draft.principal.trim());
  const windowProblem = windowDraftProblem(draft.window);
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (principalProblem || windowProblem) return;
    const w: SearchWindow =
      draft.window.choice === 'days'
        ? { kind: 'days', from: draft.window.from, to: draft.window.to }
        : { kind: 'preset', preset: draft.window.choice };
    search.submit(draft, w, { tab: 'log', ...(highlight ? { log: highlight } : {}) });
  };
  const set = (k: (typeof KEYS)[number], v: string) => setDraft((d) => ({ ...d, [k]: v }));

  return (
    <section aria-labelledby="mcp-log-title" data-testid="mcp-log">
      <h2 id="mcp-log-title" className="adm-section-title">
        {t('admin.mcp.log.title')}
      </h2>
      <p className="adm-measure">{t('admin.mcp.log.intro')}</p>
      {highlight ? <Banner tone="info" text={t('admin.mcp.log.entry', { id: highlight })} /> : null}
      <form className="adm-search" noValidate onSubmit={onSubmit} aria-label={t('admin.mcp.log.searchLabel')} data-testid="mcp-log-search">
        <div className="adm-search-row">
          <div className="adm-filter">
            <label htmlFor="mcp-log-client">{t('admin.mcp.log.client')}</label>
            <select id="mcp-log-client" className="adm-select" value={draft.client} onChange={(e) => set('client', e.target.value)}>
              <option value="">{t('admin.kit.table.all')}</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <TextFilter
            id="mcp-log-key"
            label={t('admin.mcp.log.key')}
            value={draft.key}
            onChange={(v) => set('key', v)}
            list={KEY_SUGGESTIONS}
            maxLength={80}
          />
          <div className="adm-filter">
            <label htmlFor="mcp-log-decision">{t('admin.mcp.log.decision')}</label>
            <select id="mcp-log-decision" className="adm-select" value={draft.decision} onChange={(e) => set('decision', e.target.value)}>
              <option value="">{t('admin.kit.table.all')}</option>
              {POLICY_DECISIONS.map((d) => (
                <option key={d} value={d}>
                  {decisionLabel(d, t)}
                </option>
              ))}
            </select>
          </div>
          <TextFilter
            id="mcp-log-principal"
            label={t('admin.mcp.log.principal')}
            value={draft.principal}
            onChange={(v) => set('principal', v)}
            hint={t('admin.mcp.log.principalHint')}
            error={tried && principalProblem ? t('admin.audit.search.badId') : undefined}
          />
          <WindowField draft={draft.window} onChange={(w) => setDraft((d) => ({ ...d, window: w }))} tried={tried} />
          <Button type="submit" icon="search">
            {t('admin.audit.search.submit')}
          </Button>
        </div>
        <p className="adm-muted">{t('admin.audit.search.recorded')}</p>
      </form>
      {search.instants ? (
        <LogResults
          key={`${search.at}-${JSON.stringify(search.values)}`}
          filters={search.values}
          instants={search.instants}
          clients={clients}
          highlight={highlight}
        />
      ) : (
        <p className="adm-muted" data-testid="mcp-log-idle">
          {t('admin.mcp.log.idle')}
        </p>
      )}
    </section>
  );
}

const DECISION_TONE: Record<string, 'success' | 'danger' | 'signal' | 'neutral'> = {
  allowed: 'success',
  denied: 'danger',
  consent_required: 'signal',
  approval_required: 'signal',
  rate_limited: 'signal',
  error: 'danger',
};

function LogResults({
  filters,
  instants,
  clients,
  highlight,
}: {
  filters: Record<(typeof KEYS)[number], string>;
  instants: { from: string; to: string };
  clients: readonly McpClientView[];
  highlight: string | null;
}) {
  const t = useT();
  const f = useFormat();
  const paging = useCursorPaging('mcp-log');
  const body = {
    ...(filters.client ? { mcp_client_id: filters.client } : {}),
    ...(filters.key ? { resource_or_tool_key: filters.key } : {}),
    ...(filters.decision ? { policy_decision: filters.decision as McpAccessLogView['policy_decision'] } : {}),
    ...(filters.principal ? { principal_id: filters.principal } : {}),
    from: instants.from,
    to: instants.to,
    limit: PAGE,
    ...(paging.cursor ? { cursor: paging.cursor } : {}),
  };
  const q = useApiQuery('admin.mcp_access_log_search', { body }, { staleTime: Infinity, gcTime: 60_000 });
  const clientName = (id: string) => clients.find((c) => c.id === id)?.name;
  const columns: Column<McpAccessLogView>[] = [
    {
      id: 'time',
      header: t('admin.mcp.log.col.time'),
      pinned: true,
      cell: (l, ctx) => <time dateTime={l.created_at}>{ctx.digits(f.date(l.created_at, 'dateTime'))}</time>,
    },
    {
      id: 'client',
      header: t('admin.mcp.log.col.client'),
      cell: (l) => <Bidi ltr>{clientName(l.mcp_client_id) ?? maskTail(l.mcp_client_id, 6)}</Bidi>,
    },
    {
      id: 'principal',
      header: t('admin.mcp.log.col.principal'),
      cell: (l) => (
        <>
          {t(`admin.mcp.principal.${l.principal.type}` as MessageKey)} <Bidi ltr>{maskTail(l.principal.id, 4)}</Bidi>
        </>
      ),
    },
    {
      id: 'key',
      header: t('admin.mcp.log.col.key'),
      cell: (l) => (
        <>
          <Bidi ltr>{l.resource_or_tool_key}</Bidi>
          <span className="adm-muted"> · {operationTypeLabel(l.operation_type, t)}</span>
        </>
      ),
    },
    { id: 'risk', header: t('admin.mcp.log.col.risk'), cell: (l) => riskLabel(l.risk_level, t) },
    {
      id: 'decision',
      header: t('admin.mcp.log.col.decision'),
      cell: (l) => <Badge tone={DECISION_TONE[l.policy_decision] ?? 'neutral'}>{decisionLabel(l.policy_decision, t)}</Badge>,
    },
    {
      id: 'consent',
      header: t('admin.mcp.log.col.consent'),
      cell: (l) => (l.consent_reference_id ? t('admin.mcp.log.consentChecked') : t('admin.mcp.log.consentNone')),
    },
    {
      id: 'approval',
      header: t('admin.mcp.log.col.approval'),
      defaultHidden: true,
      cell: (l) => (l.approval_request_id ? t('admin.mcp.log.approvalAsked') : '—'),
    },
    {
      id: 'redactions',
      header: t('admin.mcp.log.col.redactions'),
      defaultHidden: true,
      cell: (l) => (l.redactions_applied.length ? <Bidi ltr>{l.redactions_applied.join(', ')}</Bidi> : '—'),
    },
    { id: 'result', header: t('admin.mcp.log.col.result'), cell: (l) => resultLabel(l.result_status, t) },
    { id: 'model', header: t('admin.mcp.log.col.model'), cell: (l) => (l.model_version ? <Bidi ltr>{l.model_version}</Bidi> : '—') },
    {
      id: 'latency',
      header: t('admin.mcp.log.col.latency'),
      align: 'end',
      cell: (l) => (l.latency_ms === null ? '—' : t('admin.mcp.log.ms', { n: f.number(l.latency_ms) })),
    },
    {
      id: 'insight',
      header: t('admin.mcp.log.col.insight'),
      cell: (l) => (l.output_insight_id ? <Link href={insightHref(l, f.timeZone)}>{t('admin.mcp.log.openInsight')}</Link> : '—'),
    },
  ];
  return (
    <section aria-labelledby="mcp-log-results" data-testid="mcp-log-results">
      <h3 id="mcp-log-results" className="adm-subtitle">
        {t('admin.audit.results')}
      </h3>
      <p className="adm-muted">
        {t('admin.audit.between', { from: f.date(instants.from, 'dateTime'), to: f.date(instants.to, 'dateTime') })}
      </p>
      <DataTable
        id="mcp-log"
        caption={t('admin.mcp.log.title')}
        columns={columns}
        rows={q.data?.items}
        rowKey={(l) => l.id}
        selectedKey={highlight}
        loading={q.isPending}
        error={q.error}
        onRetry={() => void q.refetch()}
        emptyText={t('admin.mcp.log.empty')}
        shortcuts={false}
        paging={{
          page: paging.page,
          hasPrev: paging.page > 1,
          hasNext: !!q.data?.next_cursor,
          onPrev: paging.prev,
          onNext: () => q.data?.next_cursor && paging.next(q.data.next_cursor),
        }}
      />
    </section>
  );
}

/** AI oversight's insight list around an access-log entry: its organization (when any) and its day. */
export function insightHref(l: Pick<McpAccessLogView, 'output_insight_id' | 'organization_id' | 'created_at'>, timeZone: string): string {
  const day = dayIn(Date.parse(l.created_at), timeZone);
  const p = new URLSearchParams({ tab: 'insights', insight: l.output_insight_id ?? '', from: day, to: day });
  if (l.organization_id) p.set('org', l.organization_id);
  return `/ai?${p.toString()}`;
}
