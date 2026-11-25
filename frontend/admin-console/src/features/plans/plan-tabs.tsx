'use client';
// A-PLAN-01 Assignments and Plan requests (AC14-2, backend S21, BR-24/BR-26). Assignments: every subscription
// (admin.subscriptions_list: organization or individual by public name, plan, status, trial end, expiry, overrides,
// who assigned it), filtered by plan, status, kind of subscriber and trials ending within 7 days; choosing a row fills
// the assign form below with that subscriber. Plan requests: the organizations' requests (admin.subscription_change_
// requests_list, oldest first, open by default); "Assign this plan" opens the assign form prefilled with the
// organization and the requested plan, and assigning closes the request (backend: subscription_assign).
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { StaffSubscriptionRow, SubscriptionChangeRequestView } from '@carpal/api-contracts';
import { DataTable, useCursorPaging, useUrlFilters, type Column, type FilterDef } from '@/components/admin';
import { Badge } from '@/components/ds/badge';
import type { AdminQuery } from '@/lib/api/generated';
import { useApiQuery } from '@/lib/api/query';
import { PLAN_KEYS, planLabel } from '@/lib/config/plans';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import { enumLabel } from '@/features/moderation';
import { AssignForm } from './assign-form';
import type { Plan } from '@carpal/api-contracts';

const PAGE = 50;
const SUB_STATUSES = ['trial', 'active', 'expired', 'cancelled'] as const;
const REQUEST_STATUSES = ['open', 'assigned', 'declined', 'withdrawn'] as const;
/** "Trials ending soon": status trial with trial_ends_before now + 7 days. */
export const TRIAL_SOON_DAYS = 7;

/** now + days, rounded up to the hour, so the query key stays the same while the page is open. */
export function trialEndsBefore(days: number, now = Date.now()): string {
  const hour = 3_600_000;
  return new Date(Math.ceil(now / hour) * hour + days * 86_400_000).toISOString();
}

/** The subscriber's link in the console: an organization page; a user needs a work item, so no link. */
function SubscriberLink({ s }: { s: { type: 'user' | 'organization'; id: string; display: string } }) {
  const t = useT();
  return s.type === 'organization' ? (
    <Link href={`/orgs/${s.id}`} aria-label={t('admin.plans.subs.openOrg', { name: s.display })}>
      {t('admin.plans.subs.openShort')}
    </Link>
  ) : (
    <>—</>
  );
}

export function overridesText(o: StaffSubscriptionRow['overrides'], t: ReturnType<typeof useT>, n: (x: number) => string): string {
  const parts: string[] = [];
  if (o.vehicle_limit != null) parts.push(t('admin.plans.subs.vehicleLimit', { n: n(o.vehicle_limit) }));
  if (o.user_limit != null) parts.push(t('admin.plans.subs.userLimit', { n: n(o.user_limit) }));
  if (o.entitlements.length) parts.push(t('admin.plans.subs.entOverrides', { count: o.entitlements.length, n: n(o.entitlements.length) }));
  return parts.length ? parts.join(' · ') : '—';
}

export function AssignmentsTab({ plans }: { plans: readonly Plan[] | undefined }) {
  const t = useT();
  const f = useFormat();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const filters: FilterDef[] = [
    {
      key: 'plan_key',
      label: t('admin.plans.subs.filter.plan'),
      allowAll: true,
      options: PLAN_KEYS.map((k) => ({ value: k, label: planLabel(k, t) })),
    },
    {
      key: 'sub_status',
      label: t('admin.plans.subs.filter.status'),
      allowAll: true,
      options: [
        ...SUB_STATUSES.map((s) => ({ value: s, label: t(`admin.plans.subStatus.${s}`) })),
        { value: 'trial_soon', label: t('admin.plans.subs.trialSoon', { n: f.number(TRIAL_SOON_DAYS) }) },
      ],
    },
    {
      key: 'subscriber_type',
      label: t('admin.plans.subs.filter.type'),
      allowAll: true,
      options: (['organization', 'user'] as const).map((x) => ({ value: x, label: t(`admin.plans.assign.types.${x}`) })),
    },
  ];
  const { values, setFilter, applyView } = useUrlFilters(filters);
  const paging = useCursorPaging(JSON.stringify(values));
  const query: AdminQuery<'admin.subscriptions_list'> = {
    limit: PAGE,
    ...(values.plan_key ? { plan_key: values.plan_key as StaffSubscriptionRow['plan_key'] } : {}),
    ...(values.sub_status === 'trial_soon'
      ? { status: 'trial' as const, trial_ends_before: trialEndsBefore(TRIAL_SOON_DAYS) }
      : values.sub_status
        ? { status: values.sub_status as StaffSubscriptionRow['status'] }
        : {}),
    ...(values.subscriber_type ? { subscriber_type: values.subscriber_type as 'user' | 'organization' } : {}),
    ...(paging.cursor ? { cursor: paging.cursor } : {}),
  };
  const q = useApiQuery('admin.subscriptions_list', { query }, { staleTime: 60_000 });
  const chosen = params.get('subscriber');
  const choose = (s: StaffSubscriptionRow) => {
    const p = new URLSearchParams(params);
    p.set('subscriber', `${s.subscriber.type}:${s.subscriber.id}`);
    p.delete('plan_key');
    router.replace(`${pathname}?${p.toString()}#assign`, { scroll: false });
    document.getElementById('assign')?.scrollIntoView?.({ block: 'start' });
  };
  const n = (x: number) => f.number(x);
  const columns: Column<StaffSubscriptionRow>[] = [
    // The pinned cell is the row's button (it fills the assign form), so the organization link has its own column.
    { id: 'subscriber', header: t('admin.plans.subs.col.subscriber'), pinned: true, cell: (s) => <Bidi>{s.subscriber.display}</Bidi> },
    { id: 'open', header: t('admin.plans.subs.col.open'), cell: (s) => <SubscriberLink s={s.subscriber} /> },
    { id: 'type', header: t('admin.plans.subs.col.type'), cell: (s) => t(`admin.plans.assign.types.${s.subscriber.type}`) },
    { id: 'plan', header: t('admin.plans.col.plan'), cell: (s) => planLabel(s.plan_key, t) },
    {
      id: 'status',
      header: t('admin.plans.subs.col.status'),
      cell: (s) => (
        <Badge tone={s.status === 'active' ? 'success' : s.status === 'trial' ? 'signal' : 'neutral'}>
          {enumLabel(SUB_STATUSES, 'admin.plans.subStatus', s.status, t)}
        </Badge>
      ),
    },
    {
      id: 'trial',
      header: t('admin.plans.subs.col.trialEnds'),
      align: 'end',
      cell: (s) => (s.trial_ends_at ? f.date(s.trial_ends_at, 'dateShort') : '—'),
    },
    {
      id: 'expires',
      header: t('admin.plans.subs.col.expires'),
      align: 'end',
      cell: (s) => (s.expires_at ? f.date(s.expires_at, 'dateShort') : '—'),
    },
    { id: 'overrides', header: t('admin.plans.subs.col.overrides'), cell: (s) => overridesText(s.overrides, t, n) },
    {
      id: 'by',
      header: t('admin.plans.subs.col.assignedBy'),
      cell: (s) => (s.assigned_by_display ? <Bidi>{s.assigned_by_display}</Bidi> : t('admin.plans.subs.bySystem')),
    },
    {
      id: 'started',
      header: t('admin.plans.subs.col.started'),
      align: 'end',
      defaultHidden: true,
      cell: (s) => f.date(s.started_at, 'dateShort'),
    },
  ];
  return (
    <>
      <p className="adm-muted">{t('admin.plans.subs.intro')}</p>
      <DataTable
        id="plan-assignments"
        caption={t('admin.plans.subs.listLabel')}
        columns={columns}
        rows={q.data?.items}
        rowKey={(s) => s.id}
        loading={q.isPending}
        error={q.error}
        onRetry={() => void q.refetch()}
        emptyText={t('admin.plans.subs.empty')}
        filters={filters}
        filterValues={values}
        onFilterChange={setFilter}
        onApplyView={applyView}
        selectedKey={q.data?.items.find((s) => `${s.subscriber.type}:${s.subscriber.id}` === chosen)?.id ?? null}
        onSelect={choose}
        paging={{
          page: paging.page,
          hasPrev: paging.page > 1,
          hasNext: !!q.data?.next_cursor,
          onPrev: paging.prev,
          onNext: () => q.data?.next_cursor && paging.next(q.data.next_cursor),
        }}
      />
      <h2 className="adm-section-title" id="assign">
        {t('admin.plans.assign.title')}
      </h2>
      {/* A new subscriber or plan in the URL starts the form again with them. */}
      <AssignForm key={`${chosen ?? ''}|${params.get('plan_key') ?? ''}`} plans={plans} />
    </>
  );
}

export function RequestsTab() {
  const t = useT();
  const f = useFormat();
  const filters: FilterDef[] = [
    {
      key: 'request_status',
      label: t('admin.plans.requests.filter.status'),
      defaultValue: 'open',
      allowAll: true,
      options: REQUEST_STATUSES.map((s) => ({ value: s, label: t(`admin.plans.requests.status.${s}`) })),
    },
  ];
  const { values, setFilter, applyView } = useUrlFilters(filters);
  const paging = useCursorPaging(values.request_status ?? '');
  const q = useApiQuery('admin.subscription_change_requests_list', {
    query: {
      limit: PAGE,
      ...(values.request_status ? { status: values.request_status as SubscriptionChangeRequestView['status'] } : {}),
      ...(paging.cursor ? { cursor: paging.cursor } : {}),
    },
  });
  const columns: Column<SubscriptionChangeRequestView>[] = [
    {
      id: 'organization',
      header: t('admin.plans.requests.col.organization'),
      pinned: true,
      cell: (r) => (
        <Link href={`/orgs/${r.organization.id}`}>
          <Bidi>{r.organization.name}</Bidi>
        </Link>
      ),
    },
    {
      id: 'change',
      header: t('admin.plans.requests.col.change'),
      cell: (r) =>
        t('admin.plans.requests.changeLine', {
          from: r.current_plan_key ? planLabel(r.current_plan_key, t) : '—',
          to: planLabel(r.requested_plan_key, t),
        }),
    },
    { id: 'note', header: t('admin.plans.requests.col.note'), cell: (r) => (r.note ? <Bidi>{r.note}</Bidi> : '—') },
    { id: 'by', header: t('admin.plans.requests.col.by'), cell: (r) => <Bidi>{r.requested_by_display}</Bidi> },
    { id: 'asked', header: t('admin.plans.requests.col.asked'), align: 'end', cell: (r) => f.date(r.created_at, 'dateShort') },
    {
      id: 'status',
      header: t('admin.plans.requests.col.status'),
      cell: (r) =>
        r.status === 'open' ? (
          <Link
            className="cp-btn cp-btn-secondary cp-btn-sm"
            href={`/plans?tab=assignments&subscriber=organization:${r.organization.id}&plan_key=${r.requested_plan_key}#assign`}
            data-testid="request-assign"
          >
            {t('admin.plans.requests.assign')}
          </Link>
        ) : (
          <>
            {enumLabel(REQUEST_STATUSES, 'admin.plans.requests.status', r.status, t)}
            {r.handled_by_display ? (
              <>
                {' '}
                <span className="adm-muted">
                  {t('admin.plans.requests.handled', {
                    who: r.handled_by_display,
                    when: r.handled_at ? f.date(r.handled_at, 'dateShort') : '—',
                  })}
                </span>
              </>
            ) : null}
          </>
        ),
    },
  ];
  return (
    <>
      <p className="adm-muted">{t('admin.plans.requests.intro')}</p>
      <DataTable
        id="plan-requests"
        caption={t('admin.plans.requests.listLabel')}
        columns={columns}
        rows={q.data?.items}
        rowKey={(r) => r.id}
        loading={q.isPending}
        error={q.error}
        onRetry={() => void q.refetch()}
        emptyText={t('admin.plans.requests.empty')}
        filters={filters}
        filterValues={values}
        onFilterChange={setFilter}
        onApplyView={applyView}
        paging={{
          page: paging.page,
          hasPrev: paging.page > 1,
          hasNext: !!q.data?.next_cursor,
          onPrev: paging.prev,
          onNext: () => q.data?.next_cursor && paging.next(q.data.next_cursor),
        }}
      />
    </>
  );
}
