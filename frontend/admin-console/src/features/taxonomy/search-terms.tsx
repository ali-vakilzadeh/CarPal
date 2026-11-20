'use client';
// Zero-result searches (AC12.T6, Docs/23 A-TAX-01 tools, Docs/02 §3.5): how often search found nothing, from the
// search_and_map dashboard (admin.analytics_dashboard; aggregates only, no personal data), for a chosen period: the
// searches, the searches without a result, their share and the day-by-day numbers. The dashboard carries counts, not
// the terms people typed (DI-35, BR-40), so there is no "add as synonym" shortcut from a term: staff add synonyms on
// the node (Synonyms tab) from what they learn elsewhere (support tickets, reports).
import { useMemo, useState } from 'react';
import { Banner } from '@/components/ds/banner';
import { useApiQuery } from '@/lib/api/query';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import { zeroResultRate } from './taxonomy-logic';

export const PERIODS = [7, 30, 90] as const;
const STARTED = 'search.started';
const ZERO = 'search.zero_result';

/** yyyy-mm-dd of a day `daysAgo` before `now` in UTC (the dashboard takes Date). */
export function isoDay(now: number, daysAgo: number): string {
  return new Date(now - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

export function SearchTerms() {
  const t = useT();
  const f = useFormat();
  const [days, setDays] = useState<(typeof PERIODS)[number]>(30);
  // The period is fixed when it is chosen (not on every render).
  const [now] = useState(() => Date.now());
  const range = useMemo(() => ({ from: isoDay(now, days), to: isoDay(now, 0) }), [now, days]);
  const dash = useApiQuery('admin.analytics_dashboard', { path: { dashboard_key: 'search_and_map' }, query: range });
  const metric = (key: string) => dash.data?.metrics.find((m) => m.metric_key === key);
  const started = Number(metric(STARTED)?.value ?? 0);
  const zero = Number(metric(ZERO)?.value ?? 0);
  const rate = zeroResultRate(started, zero);
  const series = useMemo(() => {
    const byDay = new Map<string, { started: number; zero: number }>();
    for (const p of metric(STARTED)?.series ?? []) byDay.set(p.date, { started: Number(p.value), zero: 0 });
    for (const p of metric(ZERO)?.series ?? []) byDay.set(p.date, { started: byDay.get(p.date)?.started ?? 0, zero: Number(p.value) });
    return [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0]));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the dashboard answer is the input
  }, [dash.data]);

  return (
    <section className="adm-tax-terms" data-testid="search-terms" aria-labelledby="tax-terms-title">
      <h2 id="tax-terms-title" className="adm-section-title">
        {t('admin.taxonomy.terms.title')}
      </h2>
      <p className="adm-measure">{t('admin.taxonomy.terms.intro')}</p>
      <label className="cp-field adm-tax-filter">
        <span className="cp-field-label">{t('admin.taxonomy.terms.period')}</span>
        <span className="cp-field-box">
          <select
            aria-label={t('admin.taxonomy.terms.period')}
            className="cp-field-input adm-select"
            value={days}
            onChange={(e) => setDays(Number(e.target.value) as (typeof PERIODS)[number])}
          >
            {PERIODS.map((d) => (
              <option key={d} value={d}>
                {t('admin.taxonomy.terms.lastDays', { n: f.number(d) })}
              </option>
            ))}
          </select>
        </span>
      </label>
      {dash.isError ? (
        <Banner tone="danger" text={t('admin.taxonomy.loadFailed')} />
      ) : !dash.data ? (
        <p role="status">{t('admin.work.loading')}</p>
      ) : (
        <>
          <dl className="adm-facts adm-tax-stats" data-testid="terms-stats" data-started={started} data-zero={zero}>
            <div>
              <dt>{t('admin.taxonomy.terms.searches')}</dt>
              <dd>{f.number(started)}</dd>
            </div>
            <div>
              <dt>{t('admin.taxonomy.terms.zero')}</dt>
              <dd>{f.number(zero)}</dd>
            </div>
            <div>
              <dt>{t('admin.taxonomy.terms.rate')}</dt>
              <dd>{rate === null ? t('admin.taxonomy.terms.noSearches') : `${f.number(Math.round(rate * 1000) / 10)} %`}</dd>
            </div>
          </dl>
          {series.length ? (
            <table className="adm-tax-table">
              <caption>{t('admin.taxonomy.terms.byDay')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('admin.taxonomy.terms.day')}</th>
                  <th scope="col">{t('admin.taxonomy.terms.searches')}</th>
                  <th scope="col">{t('admin.taxonomy.terms.zero')}</th>
                </tr>
              </thead>
              <tbody>
                {series.map(([day, v]) => (
                  <tr key={day}>
                    <td>{f.date(`${day}T12:00:00Z`, 'date')}</td>
                    <td>{f.number(v.started)}</td>
                    <td>{f.number(v.zero)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </>
      )}
      <Banner tone="info" text={t('admin.taxonomy.terms.noTerms')} />
    </section>
  );
}
