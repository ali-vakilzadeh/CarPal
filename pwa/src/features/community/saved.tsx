'use client';
// W-NET-01 Saved & Following (mirrors C-PROF-05; P8.T5) at /<locale>/saved, signed in: tabs Favourites (favorites.list;
// Book again → the request step of P10, Remove) and Following (follows.list; the notification bell per account — all
// posts, important only, none — through follows.put, Unfollow); Select for bulk Remove / Unfollow; every removal has
// Undo. Saved posts, Saved parts and Saved searches are not offered: the contract keeps organizations only (DI-06).
// The tab lives in the URL (?tab=following).
import type { Favorite, Follow, PublicOrgCard } from '@carpal/api-contracts';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Button, buttonClass } from '@/components/ds/button';
import { Check } from '@/components/ds/check';
import { InfiniteList } from '@/components/shell/infinite-list';
import { StateView } from '@/components/shell/states';
import { useToast } from '@/components/shell/toast';
import { OrgCard, requestHref } from '@/features/profiles';
import type { ApiClient } from '@/lib/api';
import { useApiClient, useApiInfiniteQuery } from '@/lib/api/query';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';

type Tab = 'favorites' | 'following';
type Bell = Follow['notification_preference'];
const PAGE = 50;

/** Saved state of a relation the profile buttons read (features/profiles org-actions). */
const RELATION_KEYS = [
  ['profiles', 'relation', 'follows'],
  ['profiles', 'relation', 'favorites'],
] as const;

async function setRelation(api: ApiClient, tab: Tab, orgId: string, on: boolean, bell: Bell = 'all') {
  if (tab === 'following') {
    if (on) await api.api('follows.put', { path: { org_id: orgId }, body: { notification_preference: bell } });
    else await api.api('follows.delete', { path: { org_id: orgId } });
  } else if (on) await api.api('favorites.put', { path: { org_id: orgId } });
  else await api.api('favorites.delete', { path: { org_id: orgId } });
}

function useRefresh() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['follows.list'] });
    void queryClient.invalidateQueries({ queryKey: ['favorites.list'] });
    for (const key of RELATION_KEYS) void queryClient.invalidateQueries({ queryKey: key });
  };
}

function BellSelect({ follow }: { follow: Follow }) {
  const t = useT();
  const api = useApiClient();
  const toast = useToast();
  const refresh = useRefresh();
  const [value, setValue] = useState<Bell>(follow.notification_preference);
  const id = `bell-${follow.organization.id}`;
  return (
    <div className="cp-field pwa-bell">
      <label className="cp-field-label" htmlFor={id}>
        {t('community.saved.bell', { name: follow.organization.name })}
      </label>
      <div className="cp-field-box pwa-select-box">
        <select
          id={id}
          className="cp-field-input pwa-select"
          value={value}
          onChange={async (e) => {
            const next = e.target.value as Bell;
            const before = value;
            setValue(next);
            try {
              await api.api('follows.put', { path: { org_id: follow.organization.id }, body: { notification_preference: next } });
              toast(t('community.saved.bellSaved'));
              refresh();
            } catch {
              setValue(before);
              toast(t('community.saved.failed'));
            }
          }}
        >
          <option value="all">{t('community.saved.bellAll')}</option>
          <option value="important_only">{t('community.saved.bellImportant')}</option>
          <option value="none">{t('community.saved.bellNone')}</option>
        </select>
      </div>
    </div>
  );
}

function OrgRow({
  org,
  tab,
  follow,
  selecting,
  selected,
  onSelect,
  onRemove,
}: {
  org: PublicOrgCard;
  tab: Tab;
  follow?: Follow;
  selecting: boolean;
  selected: boolean;
  onSelect: (on: boolean) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  return (
    <article className="pwa-saved-row">
      {selecting ? (
        <Check checked={selected} onChange={(e) => onSelect(e.target.checked)}>
          <span className="sr-only">{t('community.saved.select', { name: org.name })}</span>
        </Check>
      ) : null}
      <OrgCard org={org} locale={locale} t={t} f={f} headingLevel={2} />
      <div className="pwa-saved-actions">
        {tab === 'favorites' && org.roles.includes('provider') ? (
          <Link href={requestHref(locale, org.id, null)} className={buttonClass({ variant: 'secondary', size: 'sm' })}>
            <span className="cp-btn-label">{t('community.saved.bookAgain')}</span>
          </Link>
        ) : null}
        {follow ? <BellSelect follow={follow} /> : null}
        <Button size="sm" variant="ghost" icon={tab === 'following' ? 'close' : 'trash'} onClick={onRemove}>
          {tab === 'following' ? t('community.saved.unfollow') : t('community.saved.remove')}
        </Button>
      </div>
    </article>
  );
}

export function SavedScreen() {
  const t = useT();
  const api = useApiClient();
  const toast = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const refresh = useRefresh();
  const tab: Tab = search.get('tab') === 'following' ? 'following' : 'favorites';
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const favorites = useApiInfiniteQuery('favorites.list', { query: { limit: PAGE } }, { enabled: tab === 'favorites' });
  const follows = useApiInfiniteQuery('follows.list', { query: { limit: PAGE } }, { enabled: tab === 'following' });
  const list = tab === 'favorites' ? favorites : follows;
  const items: (Favorite | Follow)[] = list.data?.pages.flatMap((p) => p.items as (Favorite | Follow)[]) ?? [];

  const switchTab = (next: Tab) => {
    setSelecting(false);
    setSelected(new Set());
    router.replace(next === 'following' ? `${pathname}?tab=following` : pathname, { scroll: false });
  };

  /** Removes the organizations, with one Undo that restores them all (and their bells). */
  const remove = async (entries: (Favorite | Follow)[]) => {
    const done: (Favorite | Follow)[] = [];
    for (const e of entries) {
      try {
        await setRelation(api, tab, e.organization.id, false);
        done.push(e);
      } catch {
        /* reported below */
      }
    }
    refresh();
    setSelected(new Set());
    setSelecting(false);
    if (done.length < entries.length) toast(t('community.saved.failed'));
    if (!done.length) return;
    const text =
      done.length === 1
        ? tab === 'following'
          ? t('community.saved.unfollowed', { name: done[0]!.organization.name })
          : t('community.saved.removed', { name: done[0]!.organization.name })
        : t(tab === 'following' ? 'community.saved.unfollowedMany' : 'community.saved.removedMany', { count: done.length });
    toast(text, {
      undo: () =>
        void Promise.all(
          done.map((e) =>
            setRelation(api, tab, e.organization.id, true, 'notification_preference' in e ? e.notification_preference : 'all'),
          ),
        )
          .then(refresh)
          .catch(() => toast(t('community.saved.failed'))),
    });
  };

  const tabs: { id: Tab; label: string }[] = [
    { id: 'favorites', label: t('community.saved.favorites') },
    { id: 'following', label: t('community.saved.following') },
  ];
  const chosen = items.filter((e) => selected.has(e.organization.id));

  return (
    <div className="pwa-saved">
      <h1 className="pwa-text-title m-0">{t('shell.nav.saved')}</h1>
      <div className="pwa-tabs" role="tablist" aria-label={t('community.saved.tabs')}>
        {tabs.map((x) => (
          <button
            key={x.id}
            type="button"
            role="tab"
            id={`saved-tab-${x.id}`}
            aria-selected={tab === x.id}
            aria-controls="saved-panel"
            className={tab === x.id ? 'pwa-tab is-selected' : 'pwa-tab'}
            onClick={() => switchTab(x.id)}
          >
            {x.label}
          </button>
        ))}
      </div>
      <div id="saved-panel" role="tabpanel" aria-labelledby={`saved-tab-${tab}`} className="pwa-stack">
        {items.length ? (
          <div className="pwa-saved-bulk">
            <Button
              size="sm"
              variant="ghost"
              icon="check"
              aria-pressed={selecting}
              onClick={() => (setSelecting(!selecting), setSelected(new Set()))}
            >
              {selecting ? t('common.actions.cancel') : t('community.saved.selectMode')}
            </Button>
            {selecting ? (
              <Button size="sm" variant="danger" disabled={!chosen.length} onClick={() => void remove(chosen)}>
                {t(tab === 'following' ? 'community.saved.unfollowSelected' : 'community.saved.removeSelected', { count: chosen.length })}
              </Button>
            ) : null}
          </div>
        ) : null}
        <InfiniteList
          items={items}
          getKey={(e) => e.organization.id}
          renderItem={(e) => (
            <OrgRow
              org={e.organization}
              tab={tab}
              follow={'notification_preference' in e ? e : undefined}
              selecting={selecting}
              selected={selected.has(e.organization.id)}
              onSelect={(on) =>
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (on) next.add(e.organization.id);
                  else next.delete(e.organization.id);
                  return next;
                })
              }
              onRemove={() => void remove([e])}
            />
          )}
          status={list.status}
          error={list.error}
          hasNextPage={list.hasNextPage}
          isFetchingNextPage={list.isFetchingNextPage}
          fetchNextPage={() => list.fetchNextPage()}
          refetch={() => list.refetch()}
          label={tab === 'favorites' ? t('community.saved.favorites') : t('community.saved.following')}
          restoreKey={`saved:${tab}`}
          empty={
            <StateView
              kind="empty"
              t={t}
              title={tab === 'favorites' ? t('community.saved.emptyFavorites') : t('community.saved.emptyFollowing')}
              text={t('community.saved.emptyText')}
              compact
            />
          }
        />
      </div>
    </div>
  );
}
