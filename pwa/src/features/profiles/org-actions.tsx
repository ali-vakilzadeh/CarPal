'use client';
// Follow / Save / Share on the public pages (Docs/22 W-PUB-02 interactions): signed-in users toggle at once with a
// toast and Undo; guests get the auth-intent modal and the action completes on return (GD-06; the intent handlers
// are registered by <OrgIntentHandlers> once per page). Whether the user already follows or saved the organization
// comes from follows.list / favorites.list (no per-organization read exists), paged up to RELATION_PAGES pages.
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { useCallback, useId, useState } from 'react';
import { Button } from '@/components/ds/button';
import { IconButton } from '@/components/ds/icon-button';
import { useGatedAction, useIntentHandler } from '@/components/shell/auth-intent';
import { useToast } from '@/components/shell/toast';
import { useApiClient } from '@/lib/api/query';
import { useSession } from '@/lib/api/session';
import { useBrowserValue } from '@/lib/browser-value';
import { useT } from '@/lib/i18n/client';

const RELATION_PAGES = 4;
const PAGE = 50;

type Relation = 'follows' | 'favorites';
const relationKey = (r: Relation) => ['profiles', 'relation', r] as const;

/** Ids of the organizations the signed-in user follows or saved. */
function useRelation(relation: Relation) {
  const api = useApiClient();
  const session = useSession();
  return useQuery({
    queryKey: relationKey(relation),
    enabled: session.data?.signed_in === true,
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      const ids = new Set<string>();
      let cursor: string | undefined;
      for (let i = 0; i < RELATION_PAGES; i++) {
        const page =
          relation === 'follows'
            ? await api.api('follows.list', { query: { limit: PAGE, ...(cursor ? { cursor } : {}) }, signal })
            : await api.api('favorites.list', { query: { limit: PAGE, ...(cursor ? { cursor } : {}) }, signal });
        for (const item of page.items) ids.add(item.organization.id);
        if (!page.next_cursor) break;
        cursor = page.next_cursor;
      }
      return ids;
    },
  });
}

/** The follow / favourite writes, keeping the cached relation in step. */
function useRelationWrite(relation: Relation) {
  const api = useApiClient();
  const queryClient = useQueryClient();
  return useCallback(
    async (orgId: string, on: boolean) => {
      if (relation === 'follows') {
        if (on) await api.api('follows.put', { path: { org_id: orgId }, body: { notification_preference: 'all' } });
        else await api.api('follows.delete', { path: { org_id: orgId } });
      } else if (on) await api.api('favorites.put', { path: { org_id: orgId } });
      else await api.api('favorites.delete', { path: { org_id: orgId } });
      queryClient.setQueryData<Set<string>>(relationKey(relation), (prev) => {
        const next = new Set(prev ?? []);
        if (on) next.add(orgId);
        else next.delete(orgId);
        return next;
      });
    },
    [api, queryClient, relation],
  );
}

/** Replays a Follow or Save that a guest started before signing in (once per page). */
export function OrgIntentHandlers({ orgId, name }: { orgId: string; name: string }) {
  const t = useT();
  const follow = useRelationWrite('follows');
  const save = useRelationWrite('favorites');
  useIntentHandler('follow', async (intent) => {
    if (intent.target !== orgId) return;
    await follow(orgId, true);
    return t('shell.intent.followed', { name });
  });
  useIntentHandler('favorite', async (intent) => {
    if (intent.target !== orgId) return;
    await save(orgId, true);
    return t('profiles.toast.saved', { name });
  });
  return null;
}

function useToggle(relation: Relation, orgId: string, name: string) {
  const t = useT();
  const toast = useToast();
  const gate = useGatedAction();
  const state = useRelation(relation);
  const write = useRelationWrite(relation);
  const [busy, setBusy] = useState(false);
  const on = state.data?.has(orgId) ?? false;
  const labels =
    relation === 'follows'
      ? {
          on: t('shell.intent.followed', { name }),
          off: t('profiles.toast.unfollowed', { name }),
          intent: t('shell.intent.follow', { name }),
        }
      : {
          on: t('profiles.toast.saved', { name }),
          off: t('profiles.toast.unsaved', { name }),
          intent: t('profiles.intent.save', { name }),
        };

  const set = useCallback(
    async (value: boolean, undoable: boolean) => {
      setBusy(true);
      try {
        await write(orgId, value);
        toast(
          value ? labels.on : labels.off,
          undoable ? { undo: () => void write(orgId, !value).catch(() => toast(t('profiles.toast.failed'))) } : undefined,
        );
      } catch {
        toast(t('profiles.toast.failed'));
      } finally {
        setBusy(false);
      }
    },
    [write, orgId, toast, labels.on, labels.off, t],
  );

  const toggle = () =>
    on
      ? void set(false, true)
      : gate({ type: relation === 'follows' ? 'follow' : 'favorite', target: orgId, title: labels.intent, run: () => set(true, true) });
  return { on, busy, toggle };
}

export function FollowButton({ orgId, name, size }: { orgId: string; name: string; size?: 'sm' | 'md' }) {
  const t = useT();
  const f = useToggle('follows', orgId, name);
  return (
    <Button icon={f.on ? 'check' : 'plus'} aria-pressed={f.on} loading={f.busy} onClick={f.toggle} size={size}>
      {f.on ? t('profiles.actions.following') : t('profiles.actions.follow')}
    </Button>
  );
}

export function SaveButton({ orgId, name }: { orgId: string; name: string }) {
  const t = useT();
  const s = useToggle('favorites', orgId, name);
  return (
    <IconButton
      icon="heart"
      filled={s.on}
      pressed={s.on}
      iconClassName={s.on ? 'cp-star' : undefined}
      label={s.on ? t('profiles.actions.saved') : t('profiles.actions.save')}
      disabled={s.busy}
      onClick={s.toggle}
    />
  );
}

/** Share: the device's share sheet where there is one, otherwise a menu with Copy link, WhatsApp and Telegram. */
export function ShareButton({ path, title }: { path: string; title: string }) {
  const t = useT();
  const toast = useToast();
  const id = useId().replace(/:/g, '');
  const origin = useBrowserValue(() => window.location.origin, '');
  const url = origin ? new URL(path, origin).toString() : path;
  // The device share sheet on touch devices that have one; a menu everywhere else.
  const canShare = useBrowserValue(() => typeof navigator.share === 'function' && window.matchMedia('(pointer: coarse)').matches, false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast(t('profiles.actions.linkCopied'));
    } catch {
      toast(t('profiles.actions.copyFailed'));
    }
  };
  const text = encodeURIComponent(`${title} ${url}`);

  if (canShare)
    return (
      <IconButton
        icon="share"
        label={t('profiles.actions.share')}
        onClick={() => void navigator.share({ title, url }).catch(() => undefined)}
      />
    );
  return (
    <>
      <IconButton icon="share" label={t('profiles.actions.share')} popoverTarget={`share-${id}`} aria-haspopup="dialog" />
      <div
        id={`share-${id}`}
        popover="auto"
        className="pwa-popover pwa-popover-menu"
        role="dialog"
        aria-label={t('profiles.actions.shareTitle')}
      >
        <button
          type="button"
          className="pwa-menu-item"
          onClick={() => void copy()}
          popoverTarget={`share-${id}`}
          popoverTargetAction="hide"
        >
          {t('profiles.actions.copyLink')}
        </button>
        <a className="pwa-menu-item" href={`https://wa.me/?text=${text}`} target="_blank" rel="noopener noreferrer">
          {t('profiles.actions.whatsapp')}
        </a>
        <a
          className="pwa-menu-item"
          href={`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(title)}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          {t('profiles.actions.telegram')}
        </a>
      </div>
    </>
  );
}

/** The header actions of a profile: Follow, Save and Share. */
export function OrgActions({ orgId, name, path, save = true }: { orgId: string; name: string; path: string; save?: boolean }) {
  return (
    <div className="pwa-org-actions">
      <FollowButton orgId={orgId} name={name} />
      {save ? <SaveButton orgId={orgId} name={name} /> : null}
      <ShareButton path={path} title={name} />
    </div>
  );
}
