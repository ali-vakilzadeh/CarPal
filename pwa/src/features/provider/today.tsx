'use client';
// PW-HOME-01 Today (PW1.T5; mirrors P-DASH-01, reduced): three counters — new requests (safety-critical count, oldest
// waiting, usual reply time), replies waiting (reviews without a reply; approval requests for P+), photos (completed
// jobs without a showcase, showcases waiting for the customer) —, today's jobs with safety-critical first, the
// 'Verification pending' line and the 'Finish your profile' card. Each part loads and fails on its own, so a refused
// P+ read never blanks the screen; staff do not ask for the P+ reads at all (PRV-GD-03: the server decides, the
// screen only avoids asking for what it would refuse). Lists have no totals: a full page shows "50+". PW2: a business
// that is not live yet (organization 'draft') says so; its owner gets 'Continue setting up' (the compact onboarding
// resumes the owner's unpublished business).
import type { Appointment } from '@carpal/api-contracts';
import { CounterTile, StateBlock, StatusChip, appointmentTone } from '@carpal/business-ui';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Banner } from '@/components/ds/banner';
import { Button, buttonClass } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { SkeletonList } from '@/components/shell/skeleton';
import { useApiQuery } from '@/lib/api/query';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey, Translate } from '@/lib/i18n/keys';
import { useActiveBusiness } from './context';
import {
  finishItems,
  isPlus,
  isSafetyCritical,
  jobsReadyForPhotos,
  oldestWaitingMinutes,
  pageCount,
  splitMinutes,
  verificationPending,
  waitingForCustomer,
  workshopPath,
} from './model';
import { floorJobs } from './job-model';
import { OpenInWebUi } from './shell';

const LIMIT = 50;

function duration(t: Translate, minutes: number): string {
  const { h, m } = splitMinutes(minutes);
  if (h === 0) return t('provider.today.time.m', { m });
  if (m === 0) return t('provider.today.time.h', { h });
  return t('provider.today.time.hm', { h, m });
}

function vehicleName(a: Appointment): string {
  return [a.vehicle.brand.text, a.vehicle.model.text, a.vehicle.series ? `(${a.vehicle.series.text})` : null].filter(Boolean).join(' ');
}

function NewRequestsTile({ orgId, responseMinutes }: { orgId: string; responseMinutes: number | null }) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const [now] = useState(() => Date.now());
  const q = useApiQuery('provider.appointments_list', { path: { org_id: orgId }, query: { group: 'new', limit: LIMIT } });
  const items = q.data?.items ?? [];
  const safety = items.filter(isSafetyCritical).length;
  const oldest = oldestWaitingMinutes(items, now);
  const caption = [
    oldest !== null ? t('provider.today.oldest', { time: duration(t, oldest) }) : null,
    responseMinutes !== null ? t('provider.today.usualReply', { time: duration(t, responseMinutes) }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <CounterTile
      label={t('provider.today.newRequests')}
      value={q.isError ? '–' : (pageCount(q.data, f.number) ?? '…')}
      alert={safety > 0 ? t('provider.today.safety', { count: safety }) : undefined}
      caption={q.isError ? t('provider.today.loadError') : caption || undefined}
      attention={items.length > 0}
      href={workshopPath(locale, 'requests')}
      linkAs={Link}
    />
  );
}

function RepliesTile({ orgId, plus }: { orgId: string; plus: boolean }) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const reviews = useApiQuery('reviews.org_list', {
    path: { org_id: orgId },
    query: { status: 'published', has_response: false, limit: LIMIT },
  });
  const approvals = useApiQuery('review_approvals.list', { path: { org_id: orgId }, query: { limit: LIMIT } }, { enabled: plus });
  const nReviews = reviews.data?.items.length ?? 0;
  const nApprovals = plus ? (approvals.data?.items.length ?? 0) : 0;
  const more = !!reviews.data?.next_cursor || (plus && !!approvals.data?.next_cursor);
  const loading = reviews.isPending || (plus && approvals.isPending);
  const failed = reviews.isError || (plus && approvals.isError);
  const parts = [
    nReviews > 0 ? t('provider.today.reviews', { count: nReviews }) : null,
    nApprovals > 0 ? t('provider.today.approvals', { count: nApprovals }) : null,
  ].filter(Boolean);
  const total = nReviews + nApprovals;
  return (
    <CounterTile
      label={t('provider.today.replies')}
      value={failed && total === 0 ? '–' : loading ? '…' : `${f.number(total)}${more ? '+' : ''}`}
      caption={failed ? t('provider.today.loadError') : parts.join(' · ') || t('provider.today.nothingWaiting')}
      attention={total > 0}
      href={workshopPath(locale, 'replies')}
      linkAs={Link}
    />
  );
}

function PhotosTile({ orgId }: { orgId: string }) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const portfolio = useApiQuery('provider.portfolio_list', { path: { org_id: orgId }, query: { limit: LIMIT } });
  const closed = useApiQuery('provider.appointments_list', { path: { org_id: orgId }, query: { group: 'closed', limit: LIMIT } });
  const ready = closed.data && portfolio.data ? jobsReadyForPhotos(closed.data.items, portfolio.data.items).length : 0;
  const waiting = portfolio.data?.items.filter(waitingForCustomer).length ?? 0;
  const failed = portfolio.isError || closed.isError;
  const loading = portfolio.isPending || closed.isPending;
  const parts = [
    ready > 0 ? t('provider.today.jobsReady', { count: ready }) : null,
    waiting > 0 ? t('provider.today.waiting', { count: waiting }) : null,
  ].filter(Boolean);
  return (
    <CounterTile
      label={t('provider.today.photos')}
      value={failed ? '–' : loading ? '…' : f.number(ready + waiting)}
      caption={failed ? t('provider.today.loadError') : parts.join(' · ') || t('provider.today.nothingWaiting')}
      attention={ready > 0}
      href={workshopPath(locale, 'photos')}
      linkAs={Link}
    />
  );
}

/**
 * Today's jobs (PW4): the visits booked for today (group=today, keyed on the start day) and the jobs still in the
 * workshop from earlier days (group=in_progress, e.g. a job awaiting parts since yesterday); each opens its job page.
 */
function TodaysJobs({ orgId }: { orgId: string }) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const today = useApiQuery('provider.appointments_list', { path: { org_id: orgId }, query: { group: 'today', limit: LIMIT } });
  const floor = useApiQuery('provider.appointments_list', { path: { org_id: orgId }, query: { group: 'in_progress', limit: LIMIT } });
  const failed = today.isError || floor.isError;
  const data = today.data && floor.data ? today.data : undefined;
  const jobs = useMemo(() => (today.data && floor.data ? floorJobs(today.data.items, floor.data.items) : []), [today.data, floor.data]);
  const retry = () => {
    void today.refetch();
    void floor.refetch();
  };
  return (
    <section className="pwa-stack-sm" aria-labelledby="ws-lifts">
      <h2 id="ws-lifts" className="pwa-ws-section-title">
        {t('provider.today.lifts')}
      </h2>
      {!data ? (
        !failed ? (
          <SkeletonList count={2} label={t('provider.today.lifts')} />
        ) : (
          <StateBlock
            kind="error"
            title={t('provider.today.loadError')}
            action={<Button onClick={retry}>{t('common.actions.retry')}</Button>}
          />
        )
      ) : jobs.length === 0 ? (
        <p className="pwa-text-caption m-0">{t('provider.today.noJobs')}</p>
      ) : (
        <ul className="pwa-ws-list" data-testid="todays-jobs">
          {jobs.map((a) => {
            const start = a.confirmed_start_at ?? a.proposed_start_at;
            const work = a.service_task?.text ?? a.service_system?.text ?? a.symptom?.text ?? null;
            const earlier = !!start && f.date(start, 'dateShort') !== f.date(new Date().toISOString(), 'dateShort');
            return (
              <li key={a.id}>
                <Link href={workshopPath(locale, `jobs/${encodeURIComponent(a.id)}`)} className="pwa-card pwa-ws-job pwa-ws-job-link">
                  <span className="pwa-ws-job-time">{start ? f.date(start, earlier ? 'dateShort' : 'time') : '—'}</span>
                  <span className="pwa-stack-xs pwa-ws-job-body">
                    <span className="pwa-text-label">
                      <bdi>{vehicleName(a)}</bdi>
                    </span>
                    <span className="pwa-text-caption">
                      {work ? <bdi>{work}</bdi> : null}
                      {work && a.estimated_duration_minutes ? ' · ' : null}
                      {a.estimated_duration_minutes ? duration(t, a.estimated_duration_minutes) : null}
                    </span>
                    {isSafetyCritical(a) ? (
                      <span className="pwa-ws-safety">
                        <Icon name="alert" size={16} /> {t('provider.today.safetyMark')}
                      </span>
                    ) : null}
                  </span>
                  <StatusChip label={t(`provider.status.${a.status}` as MessageKey)} tone={appointmentTone(a.status)} />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function FinishProfile({ gaps }: { gaps: readonly string[] }) {
  const t = useT();
  const locale = useLocale();
  const items = finishItems(gaps);
  if (items.length === 0) return null;
  return (
    <section className="pwa-card pwa-ws-finish" aria-labelledby="ws-finish">
      <h2 id="ws-finish" className="pwa-ws-section-title">
        {t('provider.today.finishTitle')}
      </h2>
      <p className="pwa-text-caption m-0">{t('provider.today.finishText')}</p>
      <ul className="pwa-ws-finish-list">
        {items.map((i) => (
          <li key={i.gap}>
            {i.where === 'photos' ? (
              <Link href={workshopPath(locale, 'photos')} className="pwa-link">
                {t(`provider.today.finish.${i.gap}` as MessageKey)}
              </Link>
            ) : (
              <OpenInWebUi path="profile" className="pwa-link">
                {t(`provider.today.finish.${i.gap}` as MessageKey)}
                <span className="pwa-text-caption"> · {t('provider.today.finishWeb')}</span>
              </OpenInWebUi>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function WorkshopToday() {
  const t = useT();
  const locale = useLocale();
  const business = useActiveBusiness();
  const orgId = business.orgId;
  // P* read: response time and completeness come from the profile, not from insights_get (P+), so staff see them too.
  const profile = useApiQuery('provider.profile_get', { path: { org_id: orgId } }, { staleTime: 60_000 });
  return (
    <div className="pwa-ws-page">
      <h1 className="pwa-ws-title">{t('provider.today.title')}</h1>
      {business.orgStatus === 'draft' ? (
        <Banner tone="warn" icon="alert" title={t('provider.today.draftTitle')} text={t('provider.today.draftText')}>
          {business.role === 'provider_owner' ? (
            <div className="pwa-banner-actions">
              <Link href={workshopPath(locale, 'start')} className={buttonClass({ size: 'sm', variant: 'primary' })}>
                <span className="cp-btn-label">{t('provider.today.draftAction')}</span>
              </Link>
            </div>
          ) : null}
        </Banner>
      ) : null}
      {verificationPending(business) ? <Banner tone="info" text={t('provider.today.verificationPending')} /> : null}
      <div className="pwa-ws-counters">
        <NewRequestsTile orgId={orgId} responseMinutes={profile.data?.measured_response_time_minutes ?? null} />
        <RepliesTile orgId={orgId} plus={isPlus(business)} />
        <PhotosTile orgId={orgId} />
      </div>
      <TodaysJobs orgId={orgId} />
      {profile.data ? <FinishProfile gaps={profile.data.completeness_gaps} /> : null}
    </div>
  );
}
