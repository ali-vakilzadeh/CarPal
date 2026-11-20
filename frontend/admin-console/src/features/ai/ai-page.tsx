'use client';
// AI oversight (AC13.T4, Docs/23 A-AI-01 and A-AI-02 read-only; ADM, MOD): two tabs.
// - Overview: the AI automation kill switch (platform admins; the switch itself is on Feature flags), alert cards, the
//   oversight numbers of the ai_quality dashboard for a period and its daily charts. Docs/23 also asks for volume by
//   feature, edit-before-accept and override rates, latency, errors, cost, model and prompt versions and a language
//   split: the dashboard carries none of them (DI-37).
// - Insights: AI outputs searched by type, user feedback, organization and window (admin.ai_insights_search,
//   rate-limited), with the selected insight's summary, evidence and payload. Read-only: Mark OK / wrong, the prompt
//   ticket and the evaluation set wait for backend BR-14 (owner, 2026-11-15).
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { CaseLayout, DataTable, EntityChip, problemText, useCursorPaging, type Column } from '@/components/admin';
import { Badge } from '@/components/ds/badge';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { useApiQuery, useSession } from '@/lib/api/query';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import { canCall } from '@/lib/roles';
import { MetricChart, metricLabel, PeriodControl, StatTile, useDashboard, useRangeText, useUrlPeriod, dayIn } from '@/features/analytics';
import {
  defaultDays,
  ID_RE,
  instantsOf,
  TextFilter,
  useUrlSearch,
  WindowField,
  windowDraftProblem,
  type SearchWindow,
  type WindowDraft,
} from '@/features/audit';
import { KILL_SWITCH } from '@/features/flags';
import {
  aiAlerts,
  aiNumbers,
  approvalLabel,
  FEEDBACK,
  feedbackLabel,
  INSIGHT_TYPES,
  insightTypeLabel,
  safetyLabel,
  visibilityLabel,
  type Feedback,
  type InsightRow,
} from './ai-logic';

type Tab = 'overview' | 'insights';

export function AiPage() {
  const t = useT();
  const params = useSearchParams();
  const pathname = usePathname();
  const tab: Tab = params.get('tab') === 'insights' ? 'insights' : 'overview';
  return (
    <div className="adm-page" data-testid="ai-page">
      <h1 className="adm-page-title">{t('admin.ai.title')}</h1>
      <nav className="adm-tabs" aria-label={t('admin.ai.tabsLabel')}>
        <Link href={pathname} aria-current={tab === 'overview' ? 'page' : undefined} className="adm-tab" data-tab="overview">
          {t('admin.ai.tab.overview')}
        </Link>
        <Link
          href={`${pathname}?tab=insights`}
          aria-current={tab === 'insights' ? 'page' : undefined}
          className="adm-tab"
          data-tab="insights"
        >
          {t('admin.ai.tab.insights')}
        </Link>
      </nav>
      {tab === 'overview' ? <AiOverview /> : <AiInsights />}
    </div>
  );
}

/** The AI automation kill switch as a status (platform admins may read flags); the switch is on Feature flags. */
export function KillSwitchStatus({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const session = useSession();
  const allowed = canCall('admin.flags_list', session.data?.staff?.roles ?? []);
  const q = useApiQuery('admin.flags_list', { query: { flag_type: 'kill_switch', limit: 100 } }, { enabled: allowed, staleTime: 30_000 });
  if (!allowed) return compact ? null : <p className="adm-muted">{t('admin.ai.kill.adminsOnly')}</p>;
  const flag = q.data?.items.find((x) => x.key === KILL_SWITCH);
  const state = q.isError ? 'unknown' : !q.data ? 'loading' : !flag ? 'unknown' : flag.enabled ? 'on' : 'off';
  return (
    <div className="adm-ai-kill" data-testid="ai-kill" data-state={state}>
      {state === 'on' ? (
        <Badge tone="danger" icon="alert">
          {t('admin.ai.kill.on')}
        </Badge>
      ) : state === 'off' ? (
        <Badge tone="success" icon="check">
          {t('admin.ai.kill.off')}
        </Badge>
      ) : state === 'loading' ? (
        <span className="adm-muted">{t('admin.work.loading')}</span>
      ) : (
        <Badge tone="neutral">{t('admin.ai.kill.unknown')}</Badge>
      )}{' '}
      <Link href="/flags">{t('admin.ai.kill.manage')}</Link>
    </div>
  );
}

function AiOverview() {
  const t = useT();
  const f = useFormat();
  const period = useUrlPeriod('30', ['7', '30', '90']);
  const q = useDashboard('ai_quality', period.range);
  const rangeText = useRangeText(period.range);
  const n = q.data ? aiNumbers(q.data.metrics) : null;
  const alerts = n ? aiAlerts(n) : [];
  const pct = (v: number | null) => (v === null ? '—' : `${f.number(Math.round(v * 1000) / 10)} %`);
  const gaugeNote = n?.asOf
    ? t('admin.analytics.stat.asOf', { day: f.calendarDate(n.asOf, 'dateShort') })
    : t('admin.analytics.chart.noReading');
  return (
    <section aria-labelledby="ai-overview-title" data-testid="ai-overview">
      <h2 id="ai-overview-title" className="adm-section-title">
        {t('admin.ai.overview.title')}
      </h2>
      <div className="adm-ai-killrow">
        <span className="adm-stat-label">{t('admin.ai.kill.title')}</span>
        <KillSwitchStatus />
      </div>
      <PeriodControl value={period.choice} onChange={period.setChoice} presets={['7', '30', '90']} />
      <p className="adm-muted">{rangeText}</p>
      {q.isError && !q.data ? (
        <div className="adm-table-error">
          <Banner tone="danger" text={problemText(q.error, t)} />
          <Button size="sm" icon="refresh" onClick={() => void q.refetch()}>
            {t('admin.kit.table.retry')}
          </Button>
        </div>
      ) : !n || !q.data ? (
        <p role="status">{t('admin.work.loading')}</p>
      ) : (
        <>
          {alerts.length ? (
            <ul className="adm-ai-alerts" data-testid="ai-alerts">
              {alerts.map((a) => (
                <li key={a.kind} className="adm-ai-alert" data-alert={a.kind}>
                  <Icon name="alert" size={20} />
                  <div>
                    <p className="adm-ai-alert-title">
                      {a.kind === 'hallucinations'
                        ? t('admin.ai.alert.hallucinations', { n: f.number(a.n) })
                        : t('admin.ai.alert.acceptance', { rate: pct(a.rate) })}
                    </p>
                    <Link href={`/ai?tab=insights&feedback=${a.kind === 'hallucinations' ? 'hallucination_report' : 'rejected'}&window=30`}>
                      {t('admin.ai.alert.examples')}
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="adm-muted" data-testid="ai-no-alerts">
              {t('admin.ai.alert.none')}
            </p>
          )}
          <div className="adm-stats" data-testid="ai-stats">
            <StatTile label={t('admin.ai.stat.generated')} value={f.number(n.generated)} note={t('admin.analytics.stat.inPeriod')} />
            <StatTile label={t('admin.ai.stat.acceptance')} value={pct(n.acceptance)} note={gaugeNote} />
            <StatTile label={t('admin.ai.stat.pending')} value={n.pending === null ? '—' : f.number(n.pending)} note={gaugeNote} />
            <StatTile
              label={t('admin.ai.stat.hallucinations')}
              value={n.hallucinations === null ? '—' : f.number(n.hallucinations)}
              note={gaugeNote}
            />
          </div>
          <div className="adm-charts">
            {q.data.metrics.map((m) => (
              <MetricChart
                key={m.metric_key}
                metric={m}
                range={{ from: q.data.from, to: q.data.to }}
                title={metricLabel(m.metric_key, t)}
                refreshing={q.isFetching && q.isPlaceholderData}
              />
            ))}
          </div>
          <p className="adm-muted">{t('admin.ai.overview.notInContract')}</p>
        </>
      )}
    </section>
  );
}

const KEYS = ['type', 'feedback', 'org'] as const;
const PAGE = 50;

function AiInsights() {
  const t = useT();
  const f = useFormat();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const search = useUrlSearch(KEYS);
  // Insight searches are not audited: the list opens with the last 7 days.
  const [openedAt] = useState(() => Date.now());
  const instants = search.instants ?? instantsOf({ kind: 'preset', preset: '7' }, openedAt, f.timeZone);
  const [draft, setDraft] = useState(() => {
    const days = search.window?.kind === 'days' ? search.window : defaultDays(Date.now(), f.timeZone);
    return {
      ...search.values,
      window: {
        choice: search.window?.kind === 'preset' ? search.window.preset : search.window ? 'days' : '7',
        from: days.from,
        to: days.to,
      } as WindowDraft,
    };
  });
  const [tried, setTried] = useState(false);
  const orgProblem = draft.org.trim() && !ID_RE.test(draft.org.trim());
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (orgProblem || windowDraftProblem(draft.window)) return;
    const w: SearchWindow =
      draft.window.choice === 'days'
        ? { kind: 'days', from: draft.window.from, to: draft.window.to }
        : { kind: 'preset', preset: draft.window.choice };
    search.submit(draft, w, { tab: 'insights' });
  };
  const highlight = params.get('insight');
  const select = (row: InsightRow) => {
    const p = new URLSearchParams(params);
    p.set('insight', row.id);
    router.replace(`${pathname}?${p.toString()}`, { scroll: false });
  };
  return (
    <section aria-labelledby="ai-insights-title" data-testid="ai-insights">
      <h2 id="ai-insights-title" className="adm-section-title">
        {t('admin.ai.insights.title')}
      </h2>
      <p className="adm-measure">{t('admin.ai.insights.intro')}</p>
      <Banner tone="info" text={t('admin.ai.insights.readOnly')} />
      <form
        className="adm-search"
        noValidate
        onSubmit={onSubmit}
        aria-label={t('admin.ai.insights.searchLabel')}
        data-testid="ai-insights-search"
      >
        <div className="adm-search-row">
          <div className="adm-filter">
            <label htmlFor="ai-type">{t('admin.ai.insights.type')}</label>
            <select
              id="ai-type"
              className="adm-select"
              value={draft.type}
              onChange={(e) => setDraft((d) => ({ ...d, type: e.target.value }))}
            >
              <option value="">{t('admin.kit.table.all')}</option>
              {INSIGHT_TYPES.map((x) => (
                <option key={x} value={x}>
                  {insightTypeLabel(x, t)}
                </option>
              ))}
            </select>
          </div>
          <div className="adm-filter">
            <label htmlFor="ai-feedback">{t('admin.ai.insights.feedback')}</label>
            <select
              id="ai-feedback"
              className="adm-select"
              value={draft.feedback}
              onChange={(e) => setDraft((d) => ({ ...d, feedback: e.target.value }))}
            >
              <option value="">{t('admin.kit.table.all')}</option>
              {FEEDBACK.map((x) => (
                <option key={x} value={x}>
                  {feedbackLabel(x, t)}
                </option>
              ))}
            </select>
          </div>
          <TextFilter
            id="ai-org"
            label={t('admin.ai.insights.org')}
            value={draft.org}
            onChange={(v) => setDraft((d) => ({ ...d, org: v }))}
            error={tried && orgProblem ? t('admin.audit.search.badId') : undefined}
          />
          <WindowField draft={draft.window} onChange={(w) => setDraft((d) => ({ ...d, window: w }))} tried={tried} />
          <Button type="submit" icon="search">
            {t('admin.audit.search.submit')}
          </Button>
        </div>
      </form>
      <InsightResults
        key={`${search.at}-${JSON.stringify(search.values)}`}
        filters={search.values}
        instants={instants}
        highlight={highlight}
        onSelect={select}
      />
    </section>
  );
}

function InsightResults({
  filters,
  instants,
  highlight,
  onSelect,
}: {
  filters: Record<(typeof KEYS)[number], string>;
  instants: { from: string; to: string };
  highlight: string | null;
  onSelect: (row: InsightRow) => void;
}) {
  const t = useT();
  const f = useFormat();
  const paging = useCursorPaging('ai-insights');
  const body = {
    ...(filters.type && (INSIGHT_TYPES as readonly string[]).includes(filters.type)
      ? { insight_type: filters.type as InsightRow['insight_type'] }
      : {}),
    ...(filters.feedback && (FEEDBACK as readonly string[]).includes(filters.feedback)
      ? { has_feedback: filters.feedback as Feedback }
      : {}),
    ...(filters.org ? { organization_id: filters.org } : {}),
    from: instants.from,
    to: instants.to,
    limit: PAGE,
    ...(paging.cursor ? { cursor: paging.cursor } : {}),
  };
  const q = useApiQuery('admin.ai_insights_search', { body }, { staleTime: 5 * 60_000 });
  const items = q.data?.items as InsightRow[] | undefined;
  const selected = items?.find((x) => x.id === highlight) ?? null;
  const columns: Column<InsightRow>[] = [
    { id: 'type', header: t('admin.ai.col.type'), pinned: true, cell: (x) => insightTypeLabel(x.insight_type, t) },
    {
      id: 'created',
      header: t('admin.ai.col.created'),
      cell: (x, ctx) => <time dateTime={x.created_at}>{ctx.digits(f.date(x.created_at, 'dateTime'))}</time>,
    },
    { id: 'model', header: t('admin.ai.col.model'), cell: (x) => <Bidi ltr>{x.model_version}</Bidi> },
    { id: 'approval', header: t('admin.ai.col.approval'), cell: (x) => approvalLabel(x.human_approval_status, t) },
    {
      id: 'confidence',
      header: t('admin.ai.col.confidence'),
      align: 'end',
      cell: (x) => (x.confidence_score === null ? '—' : `${f.number(x.confidence_score)} %`),
    },
    {
      id: 'safety',
      header: t('admin.ai.col.safety'),
      cell: (x) => (x.safety_flags.length ? x.safety_flags.map((s) => safetyLabel(s, t)).join(', ') : '—'),
    },
    { id: 'locale', header: t('admin.ai.col.locale'), defaultHidden: true, cell: (x) => <Bidi ltr>{x.locale}</Bidi> },
  ];
  return (
    <CaseLayout
      labels={{
        list: t('admin.ai.insights.listLabel'),
        item: t('admin.ai.insights.itemLabel'),
        decision: t('admin.ai.insights.decisionLabel'),
      }}
      list={
        <>
          <p className="adm-muted">
            {t('admin.audit.between', { from: f.date(instants.from, 'dateTime'), to: f.date(instants.to, 'dateTime') })}
          </p>
          <DataTable
            id="ai-insights"
            caption={t('admin.ai.insights.listLabel')}
            columns={columns}
            rows={items}
            rowKey={(x) => x.id}
            loading={q.isPending}
            error={q.error}
            onRetry={() => void q.refetch()}
            emptyText={t('admin.ai.insights.empty')}
            selectedKey={highlight}
            onSelect={onSelect}
            paging={{
              page: paging.page,
              hasPrev: paging.page > 1,
              hasNext: !!q.data?.next_cursor,
              onPrev: paging.prev,
              onNext: () => q.data?.next_cursor && paging.next(q.data.next_cursor),
            }}
          />
        </>
      }
      item={
        selected ? (
          <InsightDetail insight={selected} />
        ) : highlight && items ? (
          <p className="adm-muted" data-testid="ai-insight-missing">
            {t('admin.ai.insights.notInPage')}
          </p>
        ) : (
          <p className="adm-muted">{t('admin.ai.insights.pick')}</p>
        )
      }
      decision={
        <>
          <h2 className="adm-panel-title">{t('admin.ai.insights.decisionLabel')}</h2>
          <p className="adm-muted">{t('admin.ai.insights.decisionsLater')}</p>
        </>
      }
    />
  );
}

function InsightDetail({ insight }: { insight: InsightRow }) {
  const t = useT();
  const f = useFormat();
  const session = useSession();
  const canOpenLog = canCall('admin.mcp_access_log_search', session.data?.staff?.roles ?? []);
  const day = dayIn(Date.parse(insight.created_at), f.timeZone);
  const logParams = new URLSearchParams({ tab: 'log', from: day, to: day, at: String(Date.parse(insight.created_at)) });
  return (
    <article data-testid="ai-insight" data-insight={insight.id}>
      <h2 className="adm-panel-title">{insightTypeLabel(insight.insight_type, t)}</h2>
      <p>
        <Bidi>{insight.summary}</Bidi>
      </p>
      <dl className="adm-facts">
        <div>
          <dt>{t('admin.ai.col.created')}</dt>
          <dd>{f.date(insight.created_at, 'dateTime')}</dd>
        </div>
        <div>
          <dt>{t('admin.ai.detail.subject')}</dt>
          <dd>
            <EntityChip type={insight.subject.type} id={insight.subject.id} />
          </dd>
        </div>
        {insight.organization_id ? (
          <div>
            <dt>{t('admin.ai.detail.organization')}</dt>
            <dd>
              <EntityChip type="organization" id={insight.organization_id} href={`/orgs/${encodeURIComponent(insight.organization_id)}`} />
            </dd>
          </div>
        ) : null}
        <div>
          <dt>{t('admin.ai.col.model')}</dt>
          <dd>
            <Bidi ltr>{insight.model_version}</Bidi>
          </dd>
        </div>
        <div>
          <dt>{t('admin.ai.col.confidence')}</dt>
          <dd>{insight.confidence_score === null ? '—' : `${f.number(insight.confidence_score)} %`}</dd>
        </div>
        <div>
          <dt>{t('admin.ai.col.approval')}</dt>
          <dd>{approvalLabel(insight.human_approval_status, t)}</dd>
        </div>
        <div>
          <dt>{t('admin.ai.detail.visibility')}</dt>
          <dd>{visibilityLabel(insight.visibility, t)}</dd>
        </div>
        <div>
          <dt>{t('admin.ai.col.safety')}</dt>
          <dd>{insight.safety_flags.length ? insight.safety_flags.map((s) => safetyLabel(s, t)).join(', ') : '—'}</dd>
        </div>
        {insight.expires_at ? (
          <div>
            <dt>{t('admin.ai.detail.expires')}</dt>
            <dd>{f.date(insight.expires_at, 'dateTime')}</dd>
          </div>
        ) : null}
      </dl>
      {insight.evidence_references.length ? (
        <>
          <h3 className="adm-subtitle">{t('admin.ai.detail.evidence')}</h3>
          <ul className="adm-ai-evidence">
            {insight.evidence_references.map((r) => (
              <li key={`${r.type}:${r.id}`}>
                <EntityChip type={r.type} id={r.id} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {insight.structured_payload ? (
        <details className="adm-ai-payload">
          <summary>{t('admin.ai.detail.payload')}</summary>
          <pre dir="ltr">{JSON.stringify(insight.structured_payload, null, 2)}</pre>
        </details>
      ) : null}
      {canOpenLog ? (
        <p>
          <Link href={`/mcp?${logParams.toString()}`}>{t('admin.ai.detail.log')}</Link>
        </p>
      ) : null}
    </article>
  );
}
