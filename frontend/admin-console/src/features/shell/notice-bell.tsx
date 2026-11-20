'use client';
// The staff notice bell (AC14.T3, D-79; Docs/40 admin.notifications_list, _unread_count, _mark_read): the top bar shows
// the number of unread notices (read again every minute while the tab is visible) and opens the newest 20: the outcome
// of the caller's four-eyes requests, staff security notices, the AI kill switch, privacy deadlines and the exchange-rate
// reminder. Each is rendered from the console dictionary (src/lib/config/staff-notices.ts) and links to where it is
// handled; opening one marks it read, and "Mark all as read" marks everything up to the newest notice.
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import type { Notification } from '@carpal/api-contracts';
import { Button } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { useApiClient, useApiQuery } from '@/lib/api/query';
import { staffNotice } from '@/lib/config/staff-notices';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import type { Translate } from '@/lib/i18n/keys';

const LIST_LIMIT = 20;
const COUNT_KEY = ['admin.notifications_unread_count'] as const;
const LIST_KEY = ['admin.notifications_list'] as const;

/** A notice's text and link from the console dictionary; unknown templates are named, never dropped. */
export function noticeView(n: Pick<Notification, 'template_key' | 'template_params' | 'reference'>, t: Translate) {
  const def = staffNotice(n.template_key);
  if (!def) return { text: t('admin.notices.unknown', { key: n.template_key }), href: null };
  const raw = Object.fromEntries(Object.entries(n.template_params).map(([k, v]) => [k, String(v)]));
  return { text: t(def.text, def.params ? def.params(raw, t) : raw), href: def.href(n.reference) };
}

export function NoticeBell() {
  const t = useT();
  const f = useFormat();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const count = useApiQuery(
    'admin.notifications_unread_count',
    { background: true },
    { refetchInterval: 60_000, staleTime: 30_000, retry: false },
  );
  const list = useApiQuery('admin.notifications_list', { query: { limit: LIST_LIMIT } }, { enabled: open, staleTime: 0 });
  const unread = count.data?.count ?? 0;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    const onClick = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  const markRead = async (body: { ids: string[] } | { up_to: string }) => {
    try {
      await api.api('admin.notifications_mark_read', { body });
    } finally {
      void queryClient.invalidateQueries({ queryKey: COUNT_KEY });
      void queryClient.invalidateQueries({ queryKey: LIST_KEY });
    }
  };
  const items = list.data?.items ?? [];
  const newest = items[0]?.created_at ?? null;

  return (
    <div className="adm-account adm-bell" ref={root}>
      <button
        ref={button}
        type="button"
        className="adm-account-button"
        aria-expanded={open}
        aria-controls={panelId}
        data-testid="notice-bell"
        data-count={unread}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="bell" size={20} />
        {unread > 0 ? (
          <span className="adm-queue-count" aria-hidden="true">
            {f.number(unread)}
          </span>
        ) : null}
        <span className="sr-only">{unread > 0 ? t('admin.notices.bellUnread', { n: f.number(unread) }) : t('admin.notices.bell')}</span>
      </button>
      <div id={panelId} className="adm-account-panel adm-bell-panel" hidden={!open} data-testid="notice-panel">
        <h2 className="adm-account-heading">{t('admin.notices.title')}</h2>
        {list.isPending && open ? (
          <p role="status">{t('admin.work.loading')}</p>
        ) : list.isError ? (
          <p>{t('admin.notices.failed')}</p>
        ) : items.length === 0 ? (
          <p className="adm-muted">{t('admin.notices.empty')}</p>
        ) : (
          <ul className="adm-account-list adm-bell-list">
            {items.map((n) => {
              const v = noticeView(n, t);
              const unreadItem = n.read_at === null;
              const body = (
                <>
                  <span>{v.text}</span>
                  <span className="adm-muted">{f.date(n.created_at, 'dateTime')}</span>
                </>
              );
              return (
                <li key={n.id} data-testid="notice" data-template={n.template_key} data-unread={unreadItem ? 'true' : 'false'}>
                  {unreadItem ? <span className="sr-only">{t('admin.notices.unreadMark')}</span> : null}
                  {v.href ? (
                    <Link
                      href={v.href}
                      className="adm-bell-item"
                      onClick={() => {
                        setOpen(false);
                        if (unreadItem) void markRead({ ids: [n.id] });
                      }}
                    >
                      {body}
                    </Link>
                  ) : (
                    <div className="adm-bell-item">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {newest && unread > 0 ? (
          <Button size="sm" variant="secondary" onClick={() => void markRead({ up_to: newest })}>
            {t('admin.notices.markAll')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
