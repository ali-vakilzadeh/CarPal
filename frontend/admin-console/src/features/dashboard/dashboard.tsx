'use client';
// The console home (AC13.T6, Docs/23 A-DASH-01; AC5.T7 built its My work part): where staff are needed today and how
// the platform is doing, filtered to the viewer's roles. Widgets, each loading and failing on its own (Retry):
//   1  My work: changes waiting for the caller's approval, items assigned to the caller, items at risk;
//      Queues: open items per queue (admin.work_summary; recoveries from their list, D-75), oldest, SLA state, red
//      when an item is past its target;
//   2  Safety: open cases about unsafe advice and critical cases, reports of unsafe advice (work_summary breakdown;
//      safety-critical triage sessions have no source until A-AI-03, BR-14);
//      Growth: new users, vehicles, provider profiles, appointment requests and completions, reviews published;
//   3  Trust: reviews published and awaiting approval, disputes opened, moderation actions (fraud flags and review
//      velocity alerts have no source, DI-36); AI: insights, acceptance, hallucination reports, the kill switch;
//   0  The daily exchange rate for administrators while it is not set today (AC14b.T3);
//   4  System: import, delivery and virus-scan failures, the SMS provider (warning while simulated), the mail transport
//      and the geocoder's requests (admin.system_health).
// The period of the metric widgets is today, 7 or 30 days (URL ?range=). Numbers are read again every 60 s while the
// page is visible (TanStack pauses intervals in a hidden tab). The region filter of Docs/23 waits for dimensions in
// the analytics store (DI-36).
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { DashboardKey, PendingChange, WorkQueueSummary } from '@carpal/api-contracts';
import { opLabel, problemText, SlaBadge } from '@/components/admin';
import { Badge } from '@/components/ds/badge';
import { Button } from '@/components/ds/button';
import { Icon, type IconName } from '@/components/ds/icon';
import type { ApiProblem } from '@/lib/api/problem';
import { apiQueryKey, isRefetch, useApiClient, useApiQuery, useSession } from '@/lib/api/query';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { canCall } from '@/lib/roles';
import { QUEUES, queueKey, summarizeQueue, type QueueSummary } from '@/lib/work/queues';
import { breakdownCount, slaOf, useWorkSummary, workQueue, WORK_REFRESH_MS, type QueueId } from '@/lib/work/summary';
import { roleNames } from '@/features/shell';
import { metricValue, PeriodControl, useRangeText, useUrlPeriod, type DayRange } from '@/features/analytics';
import { aiNumbers, KillSwitchStatus } from '@/features/ai';

const QUEUE_ICON: Record<QueueId, IconName> = {
  approvals: 'check',
  recoveries: 'lock',
  verification: 'shield',
  reviewApproval: 'star',
  reports: 'flag',
  cases: 'alert',
  disputes: 'comment',
  privacy: 'lock',
  badges: 'shield',
  planRequests: 'grid',
  support: 'help',
};

const PRESETS = ['today', '7', '30'] as const;

export function Dashboard() {
  const t = useT();
  const session = useSession();
  const staff = session.data?.staff ?? null;
  const roles = staff?.roles ?? [];
  const period = useUrlPeriod('today', PRESETS);
  if (!staff) return null;
  const metrics = canCall('admin.analytics_dashboard', roles);
  const ai = metrics && canCall('admin.ai_insights_search', roles);
  const system = canCall('admin.system_health', roles);
  const rates = canCall('admin.exchange_rate_update', roles);
  return (
    <div className="adm-page" data-testid="my-work">
      <h1 className="adm-page-title">{t('admin.work.title')}</h1>
      <p data-testid="home-roles">
        {t('admin.work.welcome', { name: staff.display_name })} {t('admin.console.home.roles', { roles: roleNames(roles, t) })}
      </p>
      <div className="adm-dash">
        {rates ? <RateWidget /> : null}
        <MyWorkWidget />
        <SafetyWidget />
        <QueuesWidget />
      </div>
      {metrics ? (
        <>
          <h2 className="adm-section-title">{t('admin.dash.metrics')}</h2>
          <PeriodControl value={period.choice} onChange={period.setChoice} presets={PRESETS} custom={false} />
          <div className="adm-dash">
            <GrowthWidget range={period.range} />
            <TrustWidget range={period.range} />
            {ai ? <AiWidget range={period.range} /> : null}
          </div>
        </>
      ) : null}
      {system ? (
        <div className="adm-dash">
          <SystemWidget />
        </div>
      ) : null}
      <p className="adm-muted">{t('admin.work.refresh')}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------

function Widget({
  id,
  title,
  icon,
  href,
  linkText,
  state,
  error,
  onRetry,
  wide,
  children,
}: {
  id: string;
  title: string;
  icon: IconName;
  href?: string;
  linkText?: string;
  state: 'loading' | 'error' | 'ready';
  error?: ApiProblem | null;
  onRetry?: () => void;
  wide?: boolean;
  children?: ReactNode;
}) {
  const t = useT();
  return (
    <section className="adm-widget" data-widget={id} data-state={state} data-wide={wide ? 'true' : undefined} aria-labelledby={`w-${id}`}>
      <h2 id={`w-${id}`} className="adm-widget-title">
        <Icon name={icon} size={20} />
        {title}
      </h2>
      {state === 'error' ? (
        <div className="adm-widget-error">
          <p>{error ? problemText(error, t) : t('admin.dash.failed')}</p>
          {onRetry ? (
            <Button size="sm" icon="refresh" onClick={onRetry}>
              {t('admin.kit.table.retry')}
            </Button>
          ) : null}
        </div>
      ) : state === 'loading' ? (
        <p role="status" className="adm-muted">
          {t('admin.work.loading')}
        </p>
      ) : (
        children
      )}
      {href && state === 'ready' ? (
        <p className="adm-widget-link">
          <Link href={href}>{linkText ?? t('admin.dash.open')}</Link>
        </p>
      ) : null}
    </section>
  );
}

function Figures({ rows }: { rows: { label: string; value: ReactNode; testId?: string }[] }) {
  return (
    <dl className="adm-figures">
      {rows.map((r) => (
        <div key={r.label} data-testid={r.testId}>
          <dt>{r.label}</dt>
          <dd>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The daily exchange rate (AC14b.T3, backend S26a): for administrators, while a display rate is not set today (the
// region's day), a card with the rate in force, how old it is and the action. Hidden once every rate is set today.

function RateWidget() {
  const t = useT();
  const f = useFormat();
  const q = useApiQuery('admin.exchange_rates_list', undefined, { refetchInterval: WORK_REFRESH_MS, staleTime: 30_000 });
  const missing = q.data?.items.filter((r) => !r.set_today) ?? [];
  if (q.isPending || (q.isSuccess && missing.length === 0)) return null;
  return (
    <Widget
      id="rate"
      title={t('admin.dash.rate.title')}
      icon="tag"
      state={q.isError ? 'error' : 'ready'}
      error={q.error}
      onRetry={() => void q.refetch()}
    >
      <ul className="adm-mine" data-testid="rate-card">
        {missing.map((r) => (
          <li key={r.currency} data-currency={r.currency}>
            <p>
              <Badge tone="signal" icon="clock">
                {t('admin.rates.notSetToday')}
              </Badge>
            </p>
            <p>{t('admin.rates.perUsd', { amount: f.number(Number(r.per_usd), { maximumFractionDigits: 4 }), currency: r.currency })}</p>
            <p className="adm-muted">{t('admin.dash.rate.age', { ago: f.relative(r.updated_at), name: r.updated_by_display })}</p>
            <p>
              <Link href={`/rates?currency=${encodeURIComponent(r.currency)}`}>{t('admin.rates.setTodayAction')}</Link>
            </p>
          </li>
        ))}
      </ul>
    </Widget>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Row 1: My work and Queues

function useApprovalsList() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const f = useFormat();
  const session = useSession();
  const def = QUEUES.find((q) => q.id === 'approvals')!;
  const allowed = canCall(def.opId, session.data?.staff?.roles ?? []);
  return useQuery<QueueSummary<PendingChange>, ApiProblem>({
    queryKey: queueKey('approvals'),
    queryFn: ({ signal }) =>
      summarizeQueue(api, def, {
        timeZone: f.timeZone,
        signal,
        maxPages: 1,
        background: isRefetch(queryClient, queueKey('approvals')),
      }) as Promise<QueueSummary<PendingChange>>,
    enabled: allowed,
    refetchInterval: WORK_REFRESH_MS,
    staleTime: 30_000,
  });
}

function MyWorkWidget() {
  const t = useT();
  const f = useFormat();
  const work = useWorkSummary();
  const approvals = useApprovalsList();
  const session = useSession();
  const decides = canCall('admin.four_eyes_list', session.data?.staff?.roles ?? []);
  const items = work.data?.items ?? [];
  const assigned = items.reduce((n, q) => n + (q.assigned_to_me ?? 0), 0);
  const atRisk = items.reduce((n, q) => n + (q.sla ? q.sla.warn + q.sla.breach : 0), 0);
  const fourEyes = items.find((q) => q.queue === 'four_eyes');
  const state = work.isError || approvals.isError ? 'error' : !work.data || (decides && !approvals.data) ? 'loading' : 'ready';
  return (
    <Widget
      id="my-work"
      title={t('admin.dash.myWork')}
      icon="user"
      state={state}
      error={(work.error ?? approvals.error) as ApiProblem | null}
      onRetry={() => {
        if (work.isError) void work.refetch();
        if (approvals.isError) void approvals.refetch();
      }}
    >
      <Figures
        rows={[
          ...(decides ? [{ label: t('admin.dash.waitingForYou'), value: f.number(fourEyes?.open ?? 0), testId: 'mine-approvals' }] : []),
          { label: t('admin.dash.assignedToYou'), value: f.number(assigned), testId: 'mine-assigned' },
          { label: t('admin.dash.atRisk'), value: f.number(atRisk), testId: 'mine-at-risk' },
        ]}
      />
      {decides && approvals.data ? (
        <section aria-labelledby="work-approvals" data-testid="work-approvals">
          <h3 id="work-approvals" className="adm-subtitle">
            {t('admin.work.approvals.title')}
          </h3>
          {approvals.data.count === 0 ? (
            <p>{t('admin.work.approvals.none')}</p>
          ) : (
            <ul className="adm-mine">
              {approvals.data.urgent.map(({ item }) => (
                <li key={item.change_id}>
                  <p>
                    <Link href={`/approvals?change=${encodeURIComponent(item.change_id)}`}>{opLabel(item.op_id, t)}</Link>
                    {' · '}
                    <Bidi>{item.requested_by_display}</Bidi>
                  </p>
                  <p>
                    <Bidi>{item.summary}</Bidi>
                  </p>
                  <p className="adm-muted">{t('admin.approvals.expiresIn', { when: f.relative(item.expires_at) })}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </Widget>
  );
}

function QueuesWidget() {
  const t = useT();
  const work = useWorkSummary();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const f = useFormat();
  const session = useSession();
  const roles = session.data?.staff?.roles ?? [];
  const recoveryDef = QUEUES.find((q) => q.id === 'recoveries')!;
  const [recoveries] = useQueries({
    queries: [
      {
        queryKey: queueKey('recoveries'),
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          summarizeQueue(api, recoveryDef, { timeZone: f.timeZone, signal, background: isRefetch(queryClient, queueKey('recoveries')) }),
        enabled: canCall(recoveryDef.opId, roles),
        refetchInterval: WORK_REFRESH_MS,
        staleTime: 30_000,
      },
    ],
  });
  const items = work.data?.items ?? [];
  const withRecoveries = canCall(recoveryDef.opId, roles);
  const state = work.isError ? 'error' : !work.data ? 'loading' : 'ready';
  return (
    <Widget
      id="queues"
      title={t('admin.work.queues')}
      icon="list"
      state={state}
      error={work.error}
      onRetry={() => void work.refetch()}
      wide
    >
      {items.length === 0 && !withRecoveries ? (
        <p>{t('admin.work.noQueues')}</p>
      ) : (
        <ul className="adm-work">
          {items.map((q) => (
            <li key={q.queue}>
              <ServerTile q={q} />
            </li>
          ))}
          {withRecoveries ? (
            <li>
              <RecoveryTile
                summary={recoveries?.data}
                error={(recoveries?.error as ApiProblem | null) ?? null}
                onRetry={() => void recoveries?.refetch()}
              />
            </li>
          ) : null}
        </ul>
      )}
    </Widget>
  );
}

function TileBody({
  id,
  name,
  count,
  oldest,
  sla,
  overdue,
  paused,
  mine,
}: {
  id: string;
  name: string;
  count: number;
  oldest: string | number | null;
  sla: ReturnType<typeof slaOf>;
  overdue: number;
  paused: number;
  mine: number | null;
}) {
  const t = useT();
  const f = useFormat();
  return (
    <>
      <span className="adm-work-name">
        <Icon name={(QUEUE_ICON as Record<string, IconName>)[id] ?? 'list'} size={20} />
        {name}
      </span>
      <span className="adm-work-count" aria-label={t('admin.work.countLabel', { n: f.number(count) })}>
        {f.number(count)}
      </span>
      {count > 0 && oldest !== null ? (
        <span className="adm-muted">{t('admin.work.oldest', { age: f.relative(oldest) })}</span>
      ) : (
        <span className="adm-muted">{t('admin.work.empty')}</span>
      )}
      {mine ? <span className="adm-muted">{t('admin.dash.mine', { n: f.number(mine) })}</span> : null}
      {paused ? <span className="adm-muted">{t('admin.dash.paused', { n: f.number(paused) })}</span> : null}
      {sla ? (
        <SlaBadge state={sla} text={overdue > 0 ? t('admin.work.overdue', { n: f.number(overdue) }) : t(`admin.kit.sla.${sla}`)} />
      ) : null}
    </>
  );
}

function ServerTile({ q }: { q: WorkQueueSummary }) {
  const t = useT();
  const def = workQueue(q.queue);
  const sla = slaOf(q.sla);
  const name = def ? t(`admin.work.queue.${def.id}` as MessageKey) : t('admin.kit.unknown', { value: q.queue });
  const body = (
    <TileBody
      id={def?.id ?? q.queue}
      name={name}
      count={q.open}
      oldest={q.oldest_at}
      sla={sla}
      overdue={q.sla?.breach ?? 0}
      paused={q.sla?.paused ?? 0}
      mine={q.assigned_to_me}
    />
  );
  const attrs = { className: 'adm-work-tile', 'data-queue': def?.id ?? q.queue, 'data-sla': sla ?? 'none', 'data-count': q.open };
  return def?.href ? (
    <Link href={def.href} {...attrs}>
      {body}
    </Link>
  ) : (
    <div {...attrs}>{body}</div>
  );
}

function RecoveryTile({ summary, error, onRetry }: { summary: QueueSummary | undefined; error: ApiProblem | null; onRetry: () => void }) {
  const t = useT();
  const name = t('admin.work.queue.recoveries');
  if (error)
    return (
      <div className="adm-work-tile" data-queue="recoveries" data-state="error">
        <p className="adm-work-name">
          <Icon name="lock" size={20} />
          {name}
        </p>
        <p>{t('admin.work.failed')}</p>
        <Button size="sm" icon="refresh" onClick={onRetry}>
          {t('admin.kit.table.retry')}
        </Button>
      </div>
    );
  return (
    <Link
      href="/recoveries"
      className="adm-work-tile"
      data-queue="recoveries"
      data-sla={summary?.state ?? 'none'}
      data-count={summary?.count ?? ''}
    >
      {summary ? (
        <TileBody
          id="recoveries"
          name={name}
          count={summary.count}
          oldest={summary.oldestStart}
          sla={summary.state}
          overdue={summary.overdue}
          paused={0}
          mine={null}
        />
      ) : (
        <span className="adm-work-name">
          <Icon name="lock" size={20} />
          {name}
        </span>
      )}
    </Link>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Row 2-4: Safety, Growth, Trust, AI, System

function SafetyWidget() {
  const t = useT();
  const f = useFormat();
  const work = useWorkSummary();
  const items = work.data?.items ?? [];
  const cases = items.find((q) => q.queue === 'cases');
  const reports = items.find((q) => q.queue === 'reports');
  // Shown to staff who read the moderation queues (the summary carries them only for those roles).
  if (work.data && !cases && !reports) return null;
  const state = work.isError ? 'error' : !work.data ? 'loading' : 'ready';
  return (
    <Widget
      id="safety"
      title={t('admin.dash.safety')}
      icon="alert"
      href="/content"
      state={state}
      error={work.error}
      onRetry={() => void work.refetch()}
    >
      <Figures
        rows={[
          ...(cases
            ? [
                {
                  label: t('admin.dash.unsafeCases'),
                  value: f.number(breakdownCount(cases, 'reason:unsafe_advice')),
                  testId: 'safety-unsafe',
                },
                {
                  label: t('admin.dash.criticalCases'),
                  value: f.number(breakdownCount(cases, 'severity:critical')),
                  testId: 'safety-critical',
                },
              ]
            : []),
          ...(reports ? [{ label: t('admin.dash.unsafeReports'), value: f.number(breakdownCount(reports, 'reason:unsafe_advice')) }] : []),
        ]}
      />
      <p className="adm-muted">{t('admin.dash.triageLater')}</p>
    </Widget>
  );
}

/** Several dashboards for one widget; the widget fails when one of them does (Retry reads the failed ones again). */
function useDashboards(keys: readonly DashboardKey[], range: DayRange) {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const results = useQueries({
    queries: keys.map((key) => ({
      queryKey: apiQueryKey('admin.analytics_dashboard', { path: { dashboard_key: key }, query: { from: range.from, to: range.to } }),
      queryFn: ({ signal, queryKey }: { signal: AbortSignal; queryKey: readonly unknown[] }) =>
        api.api('admin.analytics_dashboard', {
          path: { dashboard_key: key },
          query: { from: range.from, to: range.to },
          signal,
          background: isRefetch(queryClient, queryKey),
        }),
      refetchInterval: WORK_REFRESH_MS,
      staleTime: 30_000,
    })),
  });
  const failed = results.filter((r) => r.isError);
  const metric = (key: string) => {
    for (const r of results) {
      const m = r.data?.metrics.find((x) => x.metric_key === key);
      if (m) return m;
    }
    return undefined;
  };
  return {
    state: (failed.length ? 'error' : results.every((r) => r.data) ? 'ready' : 'loading') as 'error' | 'ready' | 'loading',
    error: (failed[0]?.error as ApiProblem | undefined) ?? null,
    retry: () => failed.forEach((r) => void r.refetch()),
    value: (key: string) => metricValue(metric(key)),
    metric,
  };
}

function GrowthWidget({ range }: { range: DayRange }) {
  const t = useT();
  const f = useFormat();
  const d = useDashboards(['growth', 'activation', 'provider_value', 'reviews'], range);
  const text = useRangeText(range);
  return (
    <Widget
      id="growth"
      title={t('admin.dash.growth')}
      icon="gauge"
      href="/analytics?dashboard=growth"
      linkText={t('admin.dash.toAnalytics')}
      state={d.state}
      error={d.error}
      onRetry={d.retry}
    >
      <p className="adm-muted">{text}</p>
      <Figures
        rows={[
          { label: t('admin.analytics.metric.userRegistered'), value: f.number(d.value('events.user.registered')), testId: 'growth-users' },
          { label: t('admin.analytics.metric.vehicleCreated'), value: f.number(d.value('events.vehicle.created')) },
          { label: t('admin.analytics.metric.providerPublished'), value: f.number(d.value('events.provider.profile.published')) },
          { label: t('admin.analytics.metric.appointmentRequested'), value: f.number(d.value('events.appointment.requested')) },
          { label: t('admin.analytics.metric.appointmentCompleted'), value: f.number(d.value('events.appointment.completed')) },
          { label: t('admin.analytics.metric.reviewPublished'), value: f.number(d.value('events.review.published')) },
        ]}
      />
      <p className="adm-muted">{t('admin.dash.orgsNote')}</p>
    </Widget>
  );
}

function TrustWidget({ range }: { range: DayRange }) {
  const t = useT();
  const f = useFormat();
  const d = useDashboards(['trust', 'reviews', 'moderation_load'], range);
  const pendingDay = d.metric('gauge.review_approvals_pending');
  return (
    <Widget id="trust" title={t('admin.dash.trust')} icon="star" href="/reviews" state={d.state} error={d.error} onRetry={d.retry}>
      <Figures
        rows={[
          { label: t('admin.analytics.metric.reviewPublished'), value: f.number(d.value('events.review.published')) },
          {
            label: t('admin.analytics.metric.reviewApprovalsPending'),
            value: pendingDay?.series?.length ? f.number(d.value('gauge.review_approvals_pending')) : '—',
          },
          { label: t('admin.analytics.metric.reviewApprovalRequested'), value: f.number(d.value('events.review.approval.requested')) },
          { label: t('admin.analytics.metric.disputeOpened'), value: f.number(d.value('events.dispute.opened')) },
          { label: t('admin.analytics.metric.moderationAction'), value: f.number(d.value('events.moderation.action.taken')) },
        ]}
      />
      <p className="adm-muted">{t('admin.dash.fraudLater')}</p>
    </Widget>
  );
}

function AiWidget({ range }: { range: DayRange }) {
  const t = useT();
  const f = useFormat();
  const q = useApiQuery(
    'admin.analytics_dashboard',
    { path: { dashboard_key: 'ai_quality' }, query: { from: range.from, to: range.to } },
    { refetchInterval: WORK_REFRESH_MS, staleTime: 30_000 },
  );
  const n = q.data ? aiNumbers(q.data.metrics) : null;
  const pct = (v: number | null) => (v === null ? '—' : `${f.number(Math.round(v * 1000) / 10)} %`);
  return (
    <Widget
      id="ai"
      title={t('admin.dash.ai')}
      icon="spark"
      href="/ai"
      state={q.isError ? 'error' : n ? 'ready' : 'loading'}
      error={q.error}
      onRetry={() => void q.refetch()}
    >
      <KillSwitchStatus compact />
      {n ? (
        <Figures
          rows={[
            { label: t('admin.ai.stat.generated'), value: f.number(n.generated) },
            { label: t('admin.ai.stat.acceptance'), value: pct(n.acceptance) },
            { label: t('admin.ai.stat.hallucinations'), value: n.hallucinations === null ? '—' : f.number(n.hallucinations) },
            { label: t('admin.ai.stat.pending'), value: n.pending === null ? '—' : f.number(n.pending) },
          ]}
        />
      ) : null}
    </Widget>
  );
}

function SystemWidget() {
  const t = useT();
  const f = useFormat();
  const q = useApiQuery('admin.system_health', undefined, { refetchInterval: WORK_REFRESH_MS, staleTime: 30_000 });
  const h = q.data;
  return (
    <Widget
      id="system"
      title={t('admin.dash.system')}
      icon="sliders"
      state={q.isError ? 'error' : h ? 'ready' : 'loading'}
      error={q.error}
      onRetry={() => void q.refetch()}
      wide
    >
      {h ? (
        <>
          <div className="adm-dash-table">
            <table>
              <caption className="sr-only">{t('admin.dash.failures')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('admin.dash.signal')}</th>
                  <th scope="col">{t('admin.dash.h24')}</th>
                  <th scope="col">{t('admin.dash.d7')}</th>
                  <th scope="col">{t('admin.dash.d30')}</th>
                  <th scope="col">{t('admin.dash.lastFailure')}</th>
                </tr>
              </thead>
              <tbody>
                {h.signals.map((s) => (
                  <tr key={s.key} data-signal={s.key} data-failing={s.last_24h > 0 ? 'true' : undefined}>
                    <th scope="row">
                      {['import_failures', 'notification_delivery_failures', 'media_scan_failures'].includes(s.key)
                        ? t(`admin.dash.signals.${s.key}` as MessageKey)
                        : t('admin.kit.unknown', { value: s.key })}
                    </th>
                    <td>{s.last_24h > 0 ? <Badge tone="danger">{f.number(s.last_24h)}</Badge> : f.number(s.last_24h)}</td>
                    <td>{f.number(s.last_7d)}</td>
                    <td>{f.number(s.last_30d)}</td>
                    <td>{s.last_failure_at ? f.relative(s.last_failure_at) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Figures
            rows={[
              {
                label: t('admin.dash.sms'),
                testId: 'system-sms',
                value: (
                  <>
                    <Bidi ltr>{h.sms_provider}</Bidi>{' '}
                    {h.sms_simulated ? (
                      <Badge tone="signal" icon="alert">
                        {t('admin.dash.smsSimulated')}
                      </Badge>
                    ) : null}
                  </>
                ),
              },
              {
                label: t('admin.dash.mail'),
                testId: 'system-mail',
                value:
                  h.mail_transport === 'smtp' ? (
                    t('admin.dash.mailSmtp')
                  ) : (
                    <Badge tone="signal" icon="alert">
                      {t('admin.dash.mailFile')}
                    </Badge>
                  ),
              },
              {
                label: t('admin.dash.geocoder'),
                value: (
                  <>
                    <Bidi ltr>{h.geocoder.provider}</Bidi>
                    {' · '}
                    {t('admin.dash.geoRequests', {
                      today: h.geocoder.requests_today === null ? '—' : f.number(h.geocoder.requests_today),
                      month: h.geocoder.requests_30d === null ? '—' : f.number(h.geocoder.requests_30d),
                    })}
                  </>
                ),
              },
            ]}
          />
          <p className="adm-muted">{t('admin.dash.generated', { when: f.date(h.generated_at, 'time') })}</p>
        </>
      ) : null}
    </Widget>
  );
}
