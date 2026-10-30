'use client';
// W-NOTIF-01 Notifications (mirrors S-SHARED-04; P9.T1): the header bell with the unread count and a dropdown of the
// latest 10 (Mark all as read, See all, settings), and the page /<locale>/notifications with the tabs All ·
// Appointments · Reviews · Community · Reminders · System (?tab=). Items: category icon, title, one-line text, time,
// unread dot; opening one marks it read and goes to its destination (links.ts, the Docs/21 §6 table with web routes).
// The unread count polls every minute, never sooner than CarPal-Poll-After-Ms (SEC-RL-3), backs off after failures
// and pauses while the tab is hidden (TanStack does not run intervals in background tabs; focus refetches).
import type { Notification } from '@carpal/api-contracts';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ds/button';
import { cx } from '@/components/ds/cx';
import { Icon } from '@/components/ds/icon';
import { InfiniteList } from '@/components/shell/infinite-list';
import { SkeletonList } from '@/components/shell/skeleton';
import { StateView, stateFromProblem } from '@/components/shell/states';
import { useToast } from '@/components/shell/toast';
import { useApiClient, useApiInfiniteQuery, useApiQuery } from '@/lib/api/query';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { renderNotification } from './catalog';
import {
  categoryIcon,
  isNotificationTab,
  NOTIFICATION_TABS,
  notificationDestination,
  resolveReminderVehicle,
  tabQuery,
  type NotificationTab,
} from './links';
import { countFailures, unreadBadge, unreadPollDelay } from './polling';

/** The typed client's poll key of notifications.unread_count (operation + path, client.ts). */
const UNREAD_POLL_KEY = 'notifications.unread_count /v1/me/notifications/unread-count';

/** The unread count for the badge (personal notifications only). */
export function useUnreadCount() {
  const api = useApiClient();
  const failures = useRef({ failures: 0, lastErrorAt: 0 });
  const unread = useApiQuery('notifications.unread_count', undefined, {
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    refetchIntervalInBackground: false,
    refetchInterval: (query) => {
      failures.current = countFailures(failures.current, query.state);
      return unreadPollDelay({
        // The client's gate holds the server's CarPal-Poll-After-Ms for this operation (SEC-RL-3).
        pollAfterMs: api.gate.pollWait(UNREAD_POLL_KEY) || null,
        failures: failures.current.failures,
        hidden: typeof document !== 'undefined' && document.visibilityState === 'hidden',
      });
    },
  });
  return unread.data?.count ?? 0;
}

/** Marks read and refreshes the badge and the lists. */
function useMarkRead() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  return async (body: { ids: string[] } | { up_to: string }) => {
    await api.api('notifications.mark_read', { body });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['notifications.unread_count'] }),
      queryClient.invalidateQueries({ queryKey: ['notifications.list'] }),
    ]);
  };
}

/** Opening a notification: mark it read (best effort), then go to its destination. */
export function useOpenNotification() {
  const api = useApiClient();
  const router = useRouter();
  const locale = useLocale();
  const markRead = useMarkRead();
  return async (n: Notification) => {
    if (!n.read_at) void markRead({ ids: [n.id] }).catch(() => undefined);
    const d = notificationDestination(n, locale);
    if (!d) return;
    if (d.kind === 'href') return router.push(d.href);
    const vehicle = await resolveReminderVehicle(api, d.reminderId).catch(() => null);
    router.push(vehicle ? `/${locale}/garage/${encodeURIComponent(vehicle)}/reminders` : d.fallback);
  };
}

export function NotificationItem({ n, onOpen, compact }: { n: Notification; onOpen: (n: Notification) => void; compact?: boolean }) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const { title, text } = renderNotification(n, t, f);
  const opens = notificationDestination(n, locale) !== null;
  const unread = !n.read_at;
  const body = (
    <>
      <span className={cx('pwa-notif-icon', n.priority === 'critical' && 'is-critical')} aria-hidden="true">
        <Icon name={n.priority === 'critical' ? 'alert' : categoryIcon(n.category)} size={20} />
      </span>
      <span className="pwa-notif-body">
        <span className="pwa-notif-title" dir="auto">
          {unread ? <span className="sr-only">{t('notifications.unread')} </span> : null}
          {title}
        </span>
        <span className={cx('pwa-notif-text', compact && 'is-clamped')} dir="auto">
          {text}
        </span>
        <time className="pwa-text-caption" dateTime={n.created_at}>
          {f.relative(n.created_at)}
        </time>
      </span>
      {unread ? <span className="pwa-notif-dot" aria-hidden="true" /> : null}
    </>
  );
  return (
    <article className={cx('pwa-notif', unread && 'is-unread')} data-testid="notification">
      {opens ? (
        <button type="button" className="pwa-notif-open" onClick={() => onOpen(n)}>
          {body}
        </button>
      ) : (
        <div className="pwa-notif-open is-static">{body}</div>
      )}
    </article>
  );
}

/** The header bell: unread count and the dropdown panel with the latest 10. */
export function NotificationsBell() {
  const t = useT();
  const locale = useLocale();
  const f = useFormat();
  const toast = useToast();
  const count = useUnreadCount();
  const open = useOpenNotification();
  const markRead = useMarkRead();
  const [shown, setShown] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const latest = useApiQuery('notifications.list', { query: { limit: 10 } }, { enabled: shown, staleTime: 15_000 });

  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShown(false);
        button.current?.focus();
      }
    };
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setShown(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [shown]);

  const items = latest.data?.items ?? [];
  return (
    <div className="pwa-menu" ref={root}>
      <button
        ref={button}
        type="button"
        className={cx('cp-iconbtn', count > 0 && 'pwa-has-badge')}
        aria-expanded={shown}
        aria-controls={panelId}
        aria-label={count > 0 ? t('shell.header.notificationsUnread', { count }) : t('shell.header.notifications')}
        onClick={() => setShown((v) => !v)}
      >
        <Icon name="bell" />
        {count > 0 ? (
          <span className="pwa-count" aria-hidden="true">
            {unreadBadge(count, f.number)}
          </span>
        ) : null}
      </button>
      <div id={panelId} className={cx('pwa-menu-panel pwa-notif-panel', !shown && 'is-hidden')}>
        <div className="pwa-notif-panel-head">
          <h2 className="pwa-menu-heading">{t('shell.nav.notifications')}</h2>
          <Link
            href={`/${locale}/settings/notifications`}
            className="cp-iconbtn"
            aria-label={t('notifications.settings')}
            onClick={() => setShown(false)}
          >
            <Icon name="sliders" size={20} />
          </Link>
        </div>
        {shown ? (
          latest.status === 'pending' ? (
            <SkeletonList count={3} label={t('shell.nav.notifications')} />
          ) : latest.status === 'error' ? (
            <StateView kind={stateFromProblem(latest.error)} t={t} compact />
          ) : items.length === 0 ? (
            <p className="pwa-text-caption">{t('notifications.empty')}</p>
          ) : (
            <div className="pwa-notif-list" role="list">
              {items.map((n) => (
                <div role="listitem" key={n.id}>
                  <NotificationItem
                    n={n}
                    compact
                    onOpen={(x) => {
                      setShown(false);
                      void open(x);
                    }}
                  />
                </div>
              ))}
            </div>
          )
        ) : null}
        <div className="pwa-notif-panel-actions">
          {count > 0 ? (
            <Button
              size="sm"
              variant="ghost"
              icon="check"
              onClick={() => void markRead({ up_to: new Date().toISOString() }).catch(() => toast(t('notifications.failed')))}
            >
              {t('notifications.markAllRead')}
            </Button>
          ) : null}
          <Link href={`/${locale}/notifications`} className="pwa-menu-item pwa-notif-see-all" onClick={() => setShown(false)}>
            <span>{t('notifications.seeAll')}</span>
            <Icon name="next" size={20} />
          </Link>
        </div>
      </div>
    </div>
  );
}

const TAB_LABEL: Record<NotificationTab, MessageKey> = {
  all: 'notifications.tabs.all',
  appointments: 'notifications.tabs.appointments',
  reviews: 'notifications.tabs.reviews',
  community: 'notifications.tabs.community',
  reminders: 'notifications.tabs.reminders',
  system: 'notifications.tabs.system',
};

/** /<locale>/notifications */
export function NotificationsScreen() {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const tabParam = search.get('tab');
  const tab: NotificationTab = isNotificationTab(tabParam) ? tabParam : 'all';
  const q = tabQuery(tab);
  const list = useApiInfiniteQuery('notifications.list', { query: { limit: 30, ...(q.category ? { category: q.category } : {}) } });
  const count = useUnreadCount();
  const open = useOpenNotification();
  const markRead = useMarkRead();
  const all = list.data?.pages.flatMap((p) => p.items) ?? [];
  const items = q.clientFilter ? all.filter((n) => q.clientFilter!.includes(n.category)) : all;

  return (
    <div className="pwa-notifications">
      <div className="pwa-page-head">
        <h1 className="pwa-text-title m-0">{t('shell.nav.notifications')}</h1>
        <div className="pwa-inline-buttons">
          {count > 0 ? (
            <Button
              size="sm"
              icon="check"
              onClick={() =>
                void markRead({ up_to: new Date().toISOString() })
                  .then(() => toast(t('notifications.allRead')))
                  .catch(() => toast(t('notifications.failed')))
              }
            >
              {t('notifications.markAllRead')}
            </Button>
          ) : null}
          <Link href={`/${locale}/settings/notifications`} className="cp-iconbtn" aria-label={t('notifications.settings')}>
            <Icon name="sliders" />
          </Link>
        </div>
      </div>
      <div className="pwa-tabs" role="tablist" aria-label={t('notifications.tabs.label')}>
        {NOTIFICATION_TABS.map((x) => (
          <button
            key={x}
            type="button"
            role="tab"
            id={`notif-tab-${x}`}
            aria-selected={tab === x}
            aria-controls="notif-panel"
            className={tab === x ? 'pwa-tab is-selected' : 'pwa-tab'}
            onClick={() => router.replace(x === 'all' ? pathname : `${pathname}?tab=${x}`, { scroll: false })}
          >
            {t(TAB_LABEL[x])}
          </button>
        ))}
      </div>
      <div id="notif-panel" role="tabpanel" aria-labelledby={`notif-tab-${tab}`} className="pwa-stack">
        <InfiniteList
          items={items}
          getKey={(n) => n.id}
          renderItem={(n) => <NotificationItem n={n} onOpen={(x) => void open(x)} />}
          status={list.status}
          error={list.error}
          hasNextPage={list.hasNextPage}
          isFetchingNextPage={list.isFetchingNextPage}
          fetchNextPage={() => list.fetchNextPage()}
          refetch={() => list.refetch()}
          label={t(TAB_LABEL[tab])}
          restoreKey={`notifications:${tab}`}
          empty={<StateView kind="empty" t={t} title={t('notifications.emptyTitle')} text={t('notifications.emptyText')} compact />}
        />
      </div>
    </div>
  );
}
