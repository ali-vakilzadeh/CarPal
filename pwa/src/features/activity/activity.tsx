'use client';
// W-ME-01 My Activity (mirrors C-PROF-06; P9.T5) at /<locale>/activity?tab=…, signed in: Reviews · Posts · Questions &
// answers · Inquiries · Reports & requests. What the contract lets a consumer read is listed with status and actions
// (a table from 768 px, stacked rows below): stock inquiries (inquiries.list → the thread at
// /<locale>/activity/inquiries/<id>) and data requests (dsr.list). There is no read of one's own questions, answers,
// comments or content reports (DI-50) and no consumer post operation (DI-02): those tabs say so and link to where the
// content lives. Reviews (P11.T5) are features/reviews ActivityReviews: invitations and the caller's reviews with
// their statuses; ?review=<id> highlights one (the review notifications open it).
import type { StockInquiry } from '@carpal/api-contracts';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Badge } from '@/components/ds/badge';
import { Button, buttonClass } from '@/components/ds/button';
import { SkeletonList } from '@/components/shell/skeleton';
import { StateView, stateFromProblem } from '@/components/shell/states';
import { ActivityReviews } from '@/features/reviews';
import { DsrStatus, DSR_TYPE } from '@/features/settings';
import { useApiInfiniteQuery, useApiQuery } from '@/lib/api/query';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { ACTIVITY_TABS, inquiryTone, isActivityTab, type ActivityTab } from './model';

const TAB_LABEL: Record<ActivityTab, MessageKey> = {
  reviews: 'activity.tabs.reviews',
  posts: 'activity.tabs.posts',
  questions: 'activity.tabs.questions',
  inquiries: 'activity.tabs.inquiries',
  reports: 'activity.tabs.reports',
};

export function InquiryStatusBadge({ inquiry }: { inquiry: Pick<StockInquiry, 'status'> }) {
  const t = useT();
  return <Badge tone={inquiryTone(inquiry.status)}>{t(`activity.inquiry.status.${inquiry.status}`)}</Badge>;
}

function Inquiries() {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const list = useApiInfiniteQuery('inquiries.list', { query: { limit: 30 } });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  if (list.status === 'pending') return <SkeletonList count={3} label={t('activity.tabs.inquiries')} />;
  if (list.status === 'error')
    return (
      <StateView
        kind={stateFromProblem(list.error)}
        t={t}
        compact
        action={
          <Button size="sm" onClick={() => void list.refetch()}>
            {t('common.actions.retry')}
          </Button>
        }
      />
    );
  if (items.length === 0)
    return (
      <StateView
        kind="empty"
        t={t}
        compact
        title={t('activity.inquiries.emptyTitle')}
        text={t('activity.inquiries.emptyText')}
        action={
          <Link href={`/${locale}/search`} className={buttonClass({ size: 'sm' })}>
            <span className="cp-btn-label">{t('activity.inquiries.findParts')}</span>
          </Link>
        }
      />
    );
  return (
    <div className="pwa-table-wrap">
      <table className="pwa-table pwa-table-stack" data-testid="inquiries-table">
        <caption className="sr-only">{t('activity.tabs.inquiries')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('activity.inquiries.colItem')}</th>
            <th scope="col">{t('activity.inquiries.colStatus')}</th>
            <th scope="col">{t('activity.inquiries.colUpdated')}</th>
            <th scope="col">
              <span className="sr-only">{t('activity.inquiries.colActions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.id} data-testid="inquiry-row">
              <td data-label={t('activity.inquiries.colItem')}>
                <span className="block pwa-text-label" dir="auto">
                  {i.inventory_item.name.text}
                </span>
                <span className="block pwa-text-caption" dir="auto">
                  {i.vendor.name}
                </span>
              </td>
              <td data-label={t('activity.inquiries.colStatus')}>
                <InquiryStatusBadge inquiry={i} />
                {i.status === 'reserved' && i.reserved_until ? (
                  <span className="block pwa-text-caption">{t('activity.inquiry.reservedUntil', { date: f.date(i.reserved_until) })}</span>
                ) : null}
              </td>
              <td data-label={t('activity.inquiries.colUpdated')}>{f.relative(i.last_message_at ?? i.updated_at)}</td>
              <td>
                <Link
                  href={`/${locale}/activity/inquiries/${encodeURIComponent(i.id)}`}
                  className={buttonClass({ size: 'sm', variant: 'ghost' })}
                >
                  <span className="cp-btn-label">{t('activity.inquiries.open')}</span>
                  <span className="sr-only"> {i.inventory_item.name.text}</span>
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.hasNextPage ? (
        <Button size="sm" variant="ghost" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
          {t('common.actions.loadMore')}
        </Button>
      ) : null}
    </div>
  );
}

function Requests() {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const dsr = useApiQuery('dsr.list', { query: { limit: 50 } });
  const items = dsr.data?.items ?? [];
  return (
    <div className="pwa-stack">
      <section className="pwa-stack-sm" aria-labelledby="activity-requests">
        <h2 id="activity-requests" className="pwa-section-title">
          {t('activity.reports.requestsTitle')}
        </h2>
        {dsr.status === 'error' ? <StateView kind="error" t={t} compact /> : null}
        {dsr.status === 'success' && items.length === 0 ? <p className="pwa-text-body m-0">{t('activity.reports.noRequests')}</p> : null}
        {items.length ? (
          <div className="pwa-table-wrap">
            <table className="pwa-table pwa-table-stack" data-testid="activity-dsr">
              <caption className="sr-only">{t('activity.reports.requestsTitle')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('settings.data.colType')}</th>
                  <th scope="col">{t('settings.data.colRequested')}</th>
                  <th scope="col">{t('settings.data.colStatus')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id}>
                    <td data-label={t('settings.data.colType')}>{t(DSR_TYPE[r.request_type])}</td>
                    <td data-label={t('settings.data.colRequested')}>{f.date(r.requested_at)}</td>
                    <td data-label={t('settings.data.colStatus')}>
                      <DsrStatus r={r} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <Link href={`/${locale}/settings/data`} className="pwa-link">
          {t('activity.reports.manage')}
        </Link>
      </section>
      <section className="pwa-stack-sm" aria-labelledby="activity-reports">
        <h2 id="activity-reports" className="pwa-section-title">
          {t('activity.reports.reportsTitle')}
        </h2>
        <p className="pwa-text-body m-0">{t('activity.reports.reportsText')}</p>
      </section>
    </div>
  );
}

function Placeholder({ tab }: { tab: 'posts' | 'questions' }) {
  const t = useT();
  const locale = useLocale();
  if (tab === 'posts') return <StateView kind="empty" t={t} compact title={t('activity.posts.title')} text={t('activity.posts.text')} />;
  return (
    <StateView
      kind="empty"
      t={t}
      compact
      title={t('activity.questions.title')}
      text={t('activity.questions.text')}
      action={
        <Link href={`/${locale}/questions`} className={buttonClass({ size: 'sm' })}>
          <span className="cp-btn-label">{t('activity.questions.open')}</span>
        </Link>
      }
    />
  );
}

export function ActivityScreen() {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const param = search.get('tab');
  const tab: ActivityTab = isActivityTab(param) ? param : 'reviews';
  return (
    <div className="pwa-activity">
      <h1 className="pwa-text-title m-0">{t('shell.menu.activity')}</h1>
      <div className="pwa-tabs" role="tablist" aria-label={t('activity.tabs.label')}>
        {ACTIVITY_TABS.map((x) => (
          <button
            key={x}
            type="button"
            role="tab"
            id={`activity-tab-${x}`}
            aria-selected={tab === x}
            aria-controls="activity-panel"
            className={tab === x ? 'pwa-tab is-selected' : 'pwa-tab'}
            onClick={() => router.replace(`${pathname}?tab=${x}`, { scroll: false })}
          >
            {t(TAB_LABEL[x])}
          </button>
        ))}
      </div>
      <div id="activity-panel" role="tabpanel" aria-labelledby={`activity-tab-${tab}`} className="pwa-stack">
        {tab === 'inquiries' ? <Inquiries /> : null}
        {tab === 'reports' ? <Requests /> : null}
        {tab === 'reviews' ? <ActivityReviews highlight={search.get('review')} /> : null}
        {tab === 'posts' || tab === 'questions' ? <Placeholder tab={tab} /> : null}
      </div>
    </div>
  );
}
