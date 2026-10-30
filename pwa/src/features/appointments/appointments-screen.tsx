'use client';
// W-APP-01 Appointments (Docs/22 W-APP-01, Docs/21 C-APP-01; P10.T4) at /<locale>/appointments[/<id>]?seg=…:
// master–detail. The list has the segments Upcoming · Requested · Past · Cancelled (appointments.list group, in the
// URL) and, above them, "Needs your action": proposed times to answer, drafts not sent and visits to check in to.
// The detail is AppointmentDetail. From 1024 px both columns show; below, the detail replaces the list and has a
// way back.
import type { Appointment } from '@carpal/api-contracts';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { buttonClass } from '@/components/ds/button';
import { cx } from '@/components/ds/cx';
import { Icon } from '@/components/ds/icon';
import { InfiniteList } from '@/components/shell/infinite-list';
import { StateView } from '@/components/shell/states';
import { useApiInfiniteQuery, useApiQuery } from '@/lib/api/query';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { AppointmentDetail, subjectOf } from './appointment-detail';
import { actionNeeded, isSegment, segmentOf, SEGMENTS, visitTime, type ActionNeeded, type Segment } from './model';
import { AppointmentStatusBadge } from './status';

const SEGMENT_LABEL: Record<Segment, MessageKey> = {
  upcoming: 'appointments.segments.upcoming',
  requested: 'appointments.segments.requested',
  past: 'appointments.segments.past',
  cancelled: 'appointments.segments.cancelled',
};

const ACTION_LABEL: Record<ActionNeeded, MessageKey> = {
  proposed: 'appointments.needs.proposed',
  draft: 'appointments.needs.draft',
  checkIn: 'appointments.needs.checkIn',
};

function AppointmentCard({ a, href, selected, need }: { a: Appointment; href: string; selected: boolean; need?: ActionNeeded | null }) {
  const t = useT();
  const f = useFormat();
  const when = visitTime(a);
  return (
    <Link
      href={href}
      className={cx('pwa-appt-card', selected && 'is-selected', need && 'is-action')}
      aria-current={selected ? 'page' : undefined}
    >
      <span className="pwa-text-label" dir="auto">
        <bdi>{a.provider.name}</bdi>
      </span>
      <span className="pwa-text-caption" dir="auto">
        <bdi>{a.vehicle.nickname ?? `${a.vehicle.brand.text} ${a.vehicle.model.text}`}</bdi> · {subjectOf(a)}
      </span>
      <span className="pwa-text-body">
        <Icon name="calendar" size={16} />{' '}
        {when ? t(`appointments.detail.when.${when.kind}`, { time: f.date(when.start, 'dateTime') }) : t('appointments.list.noTime')}
      </span>
      <span className="pwa-badges">
        <AppointmentStatusBadge a={a} t={t} />
        {need ? <span className="pwa-text-caption pwa-appt-need">{t(ACTION_LABEL[need])}</span> : null}
      </span>
    </Link>
  );
}

function NeedsAction({ selectedId, hrefOf }: { selectedId: string | null; hrefOf: (a: Appointment) => string }) {
  const t = useT();
  const requested = useApiQuery('appointments.list', { query: { group: 'requested', limit: 50 } }, { staleTime: 30_000 });
  const upcoming = useApiQuery('appointments.list', { query: { group: 'upcoming', limit: 50 } }, { staleTime: 30_000 });
  const items = [...(requested.data?.items ?? []), ...(upcoming.data?.items ?? [])]
    .map((a) => ({ a, need: actionNeeded(a) }))
    .filter((x): x is { a: Appointment; need: ActionNeeded } => x.need !== null);
  if (!items.length) return null;
  return (
    <section className="pwa-stack-sm" aria-labelledby="appts-needs">
      <h2 id="appts-needs" className="pwa-text-label m-0">
        <span className="pwa-needs-dot" aria-hidden="true" /> {t('appointments.needs.title')}
      </h2>
      <ul className="pwa-plain-list pwa-stack-sm">
        {items.map(({ a, need }) => (
          <li key={a.id}>
            <AppointmentCard a={a} href={hrefOf(a)} selected={a.id === selectedId} need={need} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function SegmentList({ seg, selectedId, hrefOf }: { seg: Segment; selectedId: string | null; hrefOf: (a: Appointment) => string }) {
  const t = useT();
  const locale = useLocale();
  const list = useApiInfiniteQuery('appointments.list', { query: { group: seg, limit: 20 } }, { staleTime: 30_000 });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <InfiniteList
      items={items}
      getKey={(a) => a.id}
      renderItem={(a) => <AppointmentCard a={a} href={hrefOf(a)} selected={a.id === selectedId} />}
      status={list.status}
      error={list.error}
      hasNextPage={list.hasNextPage}
      isFetchingNextPage={list.isFetchingNextPage}
      fetchNextPage={() => list.fetchNextPage()}
      refetch={() => list.refetch()}
      label={t(SEGMENT_LABEL[seg])}
      restoreKey={`appointments:${seg}`}
      empty={
        <StateView
          kind="empty"
          t={t}
          compact
          title={t(`appointments.empty.${seg}`)}
          text={t('appointments.empty.text')}
          action={
            <div className="pwa-inline-buttons">
              <Link href={`/${locale}/help`} className={buttonClass({ variant: 'primary', size: 'sm' })}>
                <span className="cp-btn-label">{t('appointments.empty.help')}</span>
              </Link>
              <Link href={`/${locale}/search`} className={buttonClass({ size: 'sm' })}>
                <span className="cp-btn-label">{t('appointments.empty.find')}</span>
              </Link>
            </div>
          }
        />
      }
    />
  );
}

export function AppointmentsScreen({ selectedId }: { selectedId: string | null }) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const asked = search.get('seg');
  const seg: Segment = isSegment(asked) ? asked : 'upcoming';
  const hrefOf = (a: Appointment) =>
    `/${locale}/appointments/${encodeURIComponent(a.id)}?seg=${isSegment(asked) ? asked : segmentOf(a.status)}`;

  return (
    <div className={cx('pwa-appts', selectedId && 'has-detail')}>
      <section className="pwa-appts-master" aria-labelledby="appts-title">
        <h1 id="appts-title" className="pwa-garage-title">
          {t('shell.nav.appointments')}
        </h1>
        <NeedsAction selectedId={selectedId} hrefOf={hrefOf} />
        <div className="pwa-tabs" role="tablist" aria-label={t('appointments.segments.label')}>
          {SEGMENTS.map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              id={`appts-tab-${s}`}
              aria-selected={seg === s}
              aria-controls="appts-panel"
              className={seg === s ? 'pwa-tab is-selected' : 'pwa-tab'}
              onClick={() => router.replace(`${pathname}?seg=${s}`, { scroll: false })}
            >
              {t(SEGMENT_LABEL[s])}
            </button>
          ))}
        </div>
        <div id="appts-panel" role="tabpanel" aria-labelledby={`appts-tab-${seg}`}>
          <SegmentList key={seg} seg={seg} selectedId={selectedId} hrefOf={hrefOf} />
        </div>
      </section>
      <section className="pwa-appts-detail" aria-label={t('appointments.detail.label')}>
        {selectedId ? (
          <AppointmentDetail key={selectedId} appointmentId={selectedId} backHref={`/${locale}/appointments?seg=${seg}`} />
        ) : (
          <StateView kind="empty" t={t} compact title={t('appointments.detail.choose')} text={t('appointments.detail.chooseText')} />
        )}
      </section>
    </div>
  );
}
