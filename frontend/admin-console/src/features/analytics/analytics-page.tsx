'use client';
// Analytics (AC13.T5, Docs/23 A-ANL-01, Docs/02 §16 MVP metrics): one view per dashboard key of the contract
// (admin.analytics_dashboard; ADM, MOD, SUP), chosen from the list on the page, for a period (today, 7, 30 or 90 days,
// or typed days). Each view leads with its numbers (a total per count, the latest reading per gauge) and then draws
// every metric day by day with the table behind it. Aggregates only, no personal data; cohorts are not split by city,
// language or platform because the backend stores no dimensions yet (DI-36). Export (Docs/23 "export CSV, logged") has
// no operation (DI-36).
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { DashboardKey } from '@carpal/api-contracts';
import { problemText } from '@/components/admin';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { DASHBOARD_KEYS, gaugeDay, isDashboardKey, metricKind, metricLabel, metricValue, type DayRange } from './analytics-logic';
import { MetricChart, StatTile } from './charts';
import { PeriodControl, useRangeText, useUrlPeriod } from './period';
import { useDashboard } from './use-dashboard';

export function AnalyticsPage() {
  const t = useT();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const asked = params.get('dashboard');
  const key: DashboardKey = isDashboardKey(asked) ? asked : 'activation';
  const period = useUrlPeriod('30');
  const hrefOf = (k: DashboardKey) => {
    const p = new URLSearchParams(params);
    p.set('dashboard', k);
    return `${pathname}?${p.toString()}`;
  };

  return (
    <div className="adm-page" data-testid="analytics-page">
      <h1 className="adm-page-title">{t('admin.analytics.title')}</h1>
      <p className="adm-measure">{t('admin.analytics.intro')}</p>
      <PeriodControl value={period.choice} onChange={period.setChoice} />
      <div className="adm-anl">
        <nav className="adm-anl-nav" aria-label={t('admin.analytics.navLabel')}>
          <ul>
            {DASHBOARD_KEYS.map((k) => (
              <li key={k}>
                <Link
                  href={hrefOf(k)}
                  aria-current={k === key ? 'page' : undefined}
                  data-dashboard={k}
                  onClick={(e) => {
                    e.preventDefault();
                    router.replace(hrefOf(k), { scroll: false });
                  }}
                >
                  {t(`admin.analytics.dash.${k}.name` as MessageKey)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <DashboardView key={key} dashboard={key} range={period.range} />
      </div>
    </div>
  );
}

export function DashboardView({ dashboard, range }: { dashboard: DashboardKey; range: DayRange }) {
  const t = useT();
  const f = useFormat();
  const q = useDashboard(dashboard, range);
  const rangeText = useRangeText(range);
  const data = q.data && q.data.key === dashboard ? q.data : undefined;
  const refreshing = q.isFetching && q.isPlaceholderData;
  return (
    <section
      className="adm-anl-view"
      aria-labelledby="anl-view-title"
      data-testid="dashboard-view"
      data-dashboard={dashboard}
      data-state={q.isError ? 'error' : data ? 'ready' : 'loading'}
    >
      <h2 id="anl-view-title" className="adm-section-title">
        {t(`admin.analytics.dash.${dashboard}.name` as MessageKey)}
      </h2>
      <p className="adm-measure">{t(`admin.analytics.dash.${dashboard}.about` as MessageKey)}</p>
      <p className="adm-muted">{rangeText}</p>
      {dashboard === 'ai_quality' ? (
        <p>
          <Link href="/ai">{t('admin.analytics.toAi')}</Link>
        </p>
      ) : null}
      {dashboard === 'search_and_map' ? (
        <p>
          <Link href="/taxonomy?section=terms">{t('admin.analytics.toTerms')}</Link>
        </p>
      ) : null}
      {q.isError && !data ? (
        <div className="adm-table-error">
          <Banner tone="danger" text={problemText(q.error, t)} />
          <Button size="sm" icon="refresh" onClick={() => void q.refetch()}>
            {t('admin.kit.table.retry')}
          </Button>
        </div>
      ) : !data ? (
        <p role="status">{t('admin.work.loading')}</p>
      ) : data.metrics.length === 0 ? (
        <p role="status">{t('admin.analytics.noMetrics')}</p>
      ) : (
        <>
          <div className="adm-stats" data-testid="dashboard-stats">
            {data.metrics.map((m) => {
              const day = metricKind(m.metric_key) === 'gauge' ? gaugeDay(m) : null;
              return (
                <StatTile
                  key={m.metric_key}
                  label={metricLabel(m.metric_key, t)}
                  value={metricKind(m.metric_key) === 'gauge' && !day ? '—' : f.number(metricValue(m))}
                  note={
                    metricKind(m.metric_key) === 'gauge'
                      ? day
                        ? t('admin.analytics.stat.asOf', { day: f.calendarDate(day, 'dateShort') })
                        : t('admin.analytics.chart.noReading')
                      : t('admin.analytics.stat.inPeriod')
                  }
                />
              );
            })}
          </div>
          {data.metrics.every((m) => (metricKind(m.metric_key) === 'gauge' ? !m.series?.length : metricValue(m) === 0)) ? (
            <Banner tone="info" text={t('admin.analytics.allEmpty')} />
          ) : null}
          <div className="adm-charts">
            {data.metrics.map((m) => (
              <MetricChart
                key={m.metric_key}
                metric={m}
                range={{ from: data.from, to: data.to }}
                title={metricLabel(m.metric_key, t)}
                refreshing={refreshing}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
