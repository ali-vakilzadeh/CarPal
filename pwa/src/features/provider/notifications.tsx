'use client';
// Business notifications in CarPal Workshop (PW1.T6): the bell counts the unread notifications of the active business
// (notifications.unread_count with organization_id) and opens /provider/notifications, the list of that business.
// The personal bell and list of the consumer shell stay personal (no organization_id). Rows open the Workshop page of
// the request or review; marking read goes by id, because mark_read's up_to has no organization filter and would
// also mark personal notifications (provider plan PRV-BR-13).
import type { Notification } from '@carpal/api-contracts';
import { StateBlock } from '@carpal/business-ui';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef } from 'react';
import { Button } from '@/components/ds/button';
import { cx } from '@/components/ds/cx';
import { Icon } from '@/components/ds/icon';
import { SkeletonList } from '@/components/shell/skeleton';
import { countFailures, templateVars, unreadBadge, unreadPollDelay } from '@/features/notifications';
import { useApiClient, useApiInfiniteQuery, useApiQuery } from '@/lib/api/query';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { useActiveBusiness } from './context';
import { isWorkshopTemplate, workshopDestination, workshopPath, type Business } from './model';

const UNREAD_POLL_KEY = 'notifications.unread_count /v1/me/notifications/unread-count';

function useBusinessUnread(orgId: string) {
  const api = useApiClient();
  const failures = useRef({ failures: 0, lastErrorAt: 0 });
  const q = useApiQuery(
    'notifications.unread_count',
    { query: { organization_id: orgId } },
    {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      refetchIntervalInBackground: false,
      refetchInterval: (query) => {
        failures.current = countFailures(failures.current, query.state);
        return unreadPollDelay({
          pollAfterMs: api.gate.pollWait(UNREAD_POLL_KEY) || null,
          failures: failures.current.failures,
          hidden: typeof document !== 'undefined' && document.visibilityState === 'hidden',
        });
      },
    },
  );
  return q.data?.count ?? 0;
}

export function WorkshopBell({ business }: { business: Business }) {
  const t = useT();
  const locale = useLocale();
  const f = useFormat();
  const count = useBusinessUnread(business.orgId);
  const label = t('provider.notifications.bellLabel', { name: business.name });
  return (
    <Link
      href={workshopPath(locale, 'notifications')}
      className={cx('cp-iconbtn', count > 0 && 'pwa-has-badge')}
      aria-label={count > 0 ? `${label} · ${t('shell.header.notificationsUnread', { count })}` : label}
    >
      <Icon name="bell" />
      {count > 0 ? (
        <span className="pwa-count" aria-hidden="true">
          {unreadBadge(count, f.number)}
        </span>
      ) : null}
    </Link>
  );
}

function renderWorkshopNotification(n: Notification, t: ReturnType<typeof useT>, f: ReturnType<typeof useFormat>) {
  if (!isWorkshopTemplate(n.template_key))
    return { title: t('provider.notifications.generic.title'), text: t('provider.notifications.generic.text') };
  const vars = templateVars(n.template_params, t, f);
  const base = `provider.notifications.templates.${n.template_key}`;
  return { title: t(`${base}.title` as MessageKey, vars), text: t(`${base}.text` as MessageKey, vars) };
}

/** /provider/notifications: the active business's notifications, newest first. */
export function WorkshopNotifications() {
  const business = useActiveBusiness();
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const api = useApiClient();
  const router = useRouter();
  const queryClient = useQueryClient();
  const list = useApiInfiniteQuery('notifications.list', { query: { limit: 30, organization_id: business.orgId } });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const unread = items.filter((n) => !n.read_at).map((n) => n.id);

  const markRead = async (ids: string[]) => {
    if (ids.length === 0) return;
    await api.api('notifications.mark_read', { body: { ids } });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['notifications.unread_count'] }),
      queryClient.invalidateQueries({ queryKey: ['notifications.list'] }),
    ]);
  };

  return (
    <div className="pwa-ws-page">
      <div className="pwa-ws-page-head">
        <h1 className="pwa-ws-title">{t('provider.notifications.title')}</h1>
        {unread.length > 0 ? (
          <Button size="sm" variant="ghost" onClick={() => void markRead(unread).catch(() => undefined)}>
            {t('provider.notifications.markAllRead')}
          </Button>
        ) : null}
      </div>
      {!list.data ? (
        list.isPending ? (
          <SkeletonList count={3} label={t('provider.notifications.title')} />
        ) : (
          <StateBlock
            kind="error"
            title={t('provider.today.loadError')}
            action={<Button onClick={() => void list.refetch()}>{t('common.actions.retry')}</Button>}
          />
        )
      ) : items.length === 0 ? (
        <StateBlock kind="empty" title={t('provider.notifications.empty')} />
      ) : (
        <ul className="pwa-ws-list" data-testid="workshop-notifications">
          {items.map((n) => {
            const { title, text } = renderWorkshopNotification(n, t, f);
            const href = workshopDestination(n, locale);
            const body = (
              <>
                <span className="pwa-notif-body">
                  <span className="pwa-notif-title" dir="auto">
                    {!n.read_at ? <span className="sr-only">{t('notifications.unread')} </span> : null}
                    {title}
                  </span>
                  <span className="pwa-notif-text" dir="auto">
                    {text}
                  </span>
                  <time className="pwa-text-caption" dateTime={n.created_at}>
                    {f.relative(n.created_at)}
                  </time>
                </span>
                {!n.read_at ? <span className="pwa-notif-dot" aria-hidden="true" /> : null}
              </>
            );
            return (
              <li key={n.id} className={cx('pwa-notif', !n.read_at && 'is-unread')}>
                {href ? (
                  <button
                    type="button"
                    className="pwa-notif-open"
                    onClick={() => {
                      if (!n.read_at) void markRead([n.id]).catch(() => undefined);
                      router.push(href);
                    }}
                  >
                    {body}
                  </button>
                ) : (
                  <div className="pwa-notif-open is-static">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {list.hasNextPage ? (
        <Button variant="secondary" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
          {t('common.actions.loadMore')}
        </Button>
      ) : null}
    </div>
  );
}
