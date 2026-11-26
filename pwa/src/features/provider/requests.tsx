'use client';
// PW-REQ-01 Requests (provider plan PW3.T2; mirrors P-REQ-01): segments New · Proposed · Upcoming (the address keeps
// the segment, ?s=), request cards with vehicle, what it is about, urgency, the time that matters, age and the red
// safety mark (safety-critical first), pull to refresh, and 'My jobs'. New and Proposed come from one read of
// group=new (the same read as Today's counter); Upcoming from group=upcoming. 'My jobs' (PRV-GD-07) reads the
// participants of each loaded request only while it is on (PRV-BR-11 fallback). One page of 50: a full page says so
// and points to the Web UI.
import type { Appointment } from '@carpal/api-contracts';
import { RequestCard, StateBlock, appointmentTone, urgencyTone } from '@carpal/business-ui';
import { useQueries } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useRef, useState, type TouchEvent } from 'react';
import { Button, buttonClass } from '@/components/ds/button';
import { Chip } from '@/components/ds/chip';
import { SkeletonList } from '@/components/shell/skeleton';
import { apiQueryKey, useApiClient, useApiQuery } from '@/lib/api/query';
import { useSession } from '@/lib/api/session';
import { createFormatter } from '@/lib/format';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey, Translate } from '@/lib/i18n/keys';
import { useActiveBusiness } from './context';
import { isSafetyCritical, workshopPath } from './model';
import {
  SEGMENTS,
  cardTime,
  isMyJob,
  isSegment,
  requestSubject,
  segmentGroup,
  segmentItems,
  shopTimeZone,
  vehicleLine,
  type Segment,
} from './requests-model';
import { OpenInWebUi } from './shell';

const LIMIT = 50;
const PULL_PX = 72;

/** Pull down at the top of the page to refresh (touch only; the Refresh button does the same). */
function usePullToRefresh(refresh: () => Promise<unknown>) {
  const start = useRef<number | null>(null);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  return {
    busy: busy || armed,
    handlers: {
      onTouchStart: (e: TouchEvent) => {
        start.current = window.scrollY <= 0 ? (e.touches[0]?.clientY ?? null) : null;
      },
      onTouchMove: (e: TouchEvent) => {
        if (start.current !== null && (e.touches[0]?.clientY ?? 0) - start.current > PULL_PX) setArmed(true);
      },
      onTouchEnd: () => {
        start.current = null;
        if (!armed) return;
        setArmed(false);
        setBusy(true);
        void refresh().finally(() => setBusy(false));
      },
    },
  };
}

/** The ids of the loaded requests that are the signed-in member's jobs; null while unknown. */
function useMyJobs(orgId: string, items: readonly Appointment[], enabled: boolean, userId: string | null) {
  const api = useApiClient();
  const results = useQueries({
    queries: items.map((a) => {
      const args = { path: { org_id: orgId, appointment_id: a.id }, query: { limit: 50 } };
      return {
        queryKey: apiQueryKey('provider.participants_list', args),
        queryFn: () => api.api('provider.participants_list', args),
        enabled: enabled && userId !== null,
        staleTime: 60_000,
      };
    }),
  });
  if (!enabled || userId === null) return { mine: null, failed: false };
  if (results.some((r) => r.isPending)) return { mine: null, failed: false };
  const mine = new Set(items.filter((a, i) => isMyJob(results[i]?.data?.items ?? [], userId)).map((a) => a.id));
  return { mine, failed: results.some((r) => r.isError) };
}

export function cardWhen(a: Appointment, t: Translate, fmt: (iso: string) => string, time: (iso: string) => string, now: number) {
  const w = cardTime(a, now);
  if (!w) return t('provider.requests.card.anyTime');
  const at = w.end ? `${fmt(w.start)}–${time(w.end)}` : fmt(w.start);
  return t(`provider.requests.card.${w.kind}`, { time: at });
}

export function WorkshopRequests() {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const session = useSession();
  const userId = session.data?.user?.id ?? null;
  const business = useActiveBusiness();
  const orgId = business.orgId;
  const s = search.get('s');
  const segment: Segment = isSegment(s) ? s : 'new';
  const [mineOnly, setMineOnly] = useState(false);
  const [now] = useState(() => Date.now());
  const q = useApiQuery(
    'provider.appointments_list',
    { path: { org_id: orgId }, query: { group: segmentGroup(segment), limit: LIMIT } },
    { refetchOnWindowFocus: true, staleTime: 15_000 },
  );
  const all = q.data?.items ?? [];
  const items = segmentItems(segment, all);
  const my = useMyJobs(orgId, items, mineOnly, userId);
  const shown = mineOnly && my.mine ? items.filter((a) => my.mine!.has(a.id)) : items;
  const pull = usePullToRefresh(() => q.refetch());

  const go = (next: Segment) => {
    const rest = new URLSearchParams(search.toString());
    if (next === 'new') rest.delete('s');
    else rest.set('s', next);
    const qs = rest.toString();
    router.replace(`${pathname}${qs ? `?${qs}` : ''}`);
  };
  // The New and Proposed counts come from the same page (group=new); Upcoming has its own read.
  const count = (seg: Segment) => (segmentGroup(seg) === segmentGroup(segment) && q.data ? segmentItems(seg, all).length : null);

  return (
    <div className="pwa-ws-page" {...pull.handlers}>
      <div className="pwa-ws-page-head">
        <h1 className="pwa-ws-title">{t('provider.requests.title')}</h1>
        <Button size="sm" variant="ghost" icon="refresh" loading={pull.busy || q.isRefetching} onClick={() => void q.refetch()}>
          {t('provider.requests.refresh')}
        </Button>
      </div>
      <nav className="pwa-ws-segments" aria-label={t('provider.requests.segmentsLabel')}>
        {SEGMENTS.map((seg) => {
          const n = count(seg);
          return (
            <button
              key={seg}
              type="button"
              className="pwa-ws-segment"
              aria-pressed={seg === segment}
              onClick={() => go(seg)}
              data-segment={seg}
            >
              {t(`provider.requests.segments.${seg}`)}
              {n !== null && n > 0 ? <span className="pwa-ws-segment-count">{f.number(n)}</span> : null}
            </button>
          );
        })}
      </nav>
      <div className="pwa-inline-buttons">
        <Chip selected={mineOnly} onClick={() => setMineOnly((v) => !v)}>
          {t('provider.requests.myJobs')}
        </Chip>
      </div>
      {mineOnly && my.failed ? <p className="pwa-text-caption m-0">{t('provider.requests.myJobsPartial')}</p> : null}
      {!q.data ? (
        q.isPending ? (
          <SkeletonList count={3} label={t('provider.requests.title')} />
        ) : (
          <StateBlock
            kind="error"
            title={t('provider.requests.loadError')}
            action={<Button onClick={() => void q.refetch()}>{t('common.actions.retry')}</Button>}
          />
        )
      ) : mineOnly && !my.mine ? (
        <SkeletonList count={2} label={t('provider.requests.myJobs')} />
      ) : shown.length === 0 ? (
        <StateBlock
          kind="empty"
          title={t(mineOnly ? 'provider.requests.emptyMine' : (`provider.requests.empty.${segment}` as MessageKey))}
        />
      ) : (
        <ul className="pwa-ws-list" data-testid="request-list">
          {shown.map((a) => (
            <li key={a.id}>
              <RequestItem a={a} now={now} fallbackZone={f.timeZone} />
            </li>
          ))}
        </ul>
      )}
      {q.data?.next_cursor ? (
        <p className="pwa-text-caption m-0">
          {t('provider.requests.more')}{' '}
          <OpenInWebUi path="requests" className="pwa-link">
            {t('provider.menu.openWebUi')}
          </OpenInWebUi>
        </p>
      ) : null}
      {segment === 'upcoming' && q.data && shown.length > 0 ? (
        <Link href={workshopPath(locale, 'today')} className={buttonClass({ variant: 'ghost', size: 'sm' })}>
          <span className="cp-btn-label">{t('provider.requests.todayLink')}</span>
        </Link>
      ) : null}
    </div>
  );
}

function RequestItem({ a, now, fallbackZone }: { a: Appointment; now: number; fallbackZone: string }) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  // Times at the shop (its location's time zone), not the phone's.
  const shop = createFormatter(f.locale, t, shopTimeZone(a, fallbackZone));
  return (
    <RequestCard
      href={workshopPath(locale, `requests/${encodeURIComponent(a.id)}`)}
      linkAs={Link}
      vehicle={vehicleLine(a.vehicle, f.digits)}
      subject={requestSubject(a)}
      lang={a.content_locale}
      requester={a.requester_display}
      status={{ label: t(`provider.status.${a.status}` as MessageKey), tone: appointmentTone(a.status) }}
      urgency={
        a.urgency_level === 'low'
          ? undefined
          : { label: t(`provider.requests.urgency.${a.urgency_level}`), tone: urgencyTone(a.urgency_level) }
      }
      safety={isSafetyCritical(a) ? t('provider.today.safetyMark') : undefined}
      when={cardWhen(
        a,
        t,
        (iso) => shop.date(iso, 'dateTime'),
        (iso) => shop.date(iso, 'time'),
        now,
      )}
      age={f.relative(a.created_at, now)}
    />
  );
}
