'use client';
// Reactions (Docs/22 §7, Docs/56 §9; P8.T2): one per user, target and type. A click updates the button at once
// (optimistic) and sends reactions.put / reactions.delete; the server's count replaces the guess, a failure puts the
// earlier state back and says so. Whether the user already reacted is remembered per browser (memory.ts, DI-50);
// put is idempotent on the server, so a reaction given on another device is never counted twice. Guests get the
// auth-intent modal and the reaction is given after sign-in (GD-06) by <ReactionIntentHandlers>, mounted once per
// page (the intent registry keeps one handler per type). Reactions bump the version of posts and answers (BA-15):
// callers that edit those items re-read them before writing.
import { useEffect, useState } from 'react';
import { Button } from '@/components/ds/button';
import { useGatedAction, useIntentHandler } from '@/components/shell/auth-intent';
import { useToast } from '@/components/shell/toast';
import type { ApiClient } from '@/lib/api';
import { useApiClient } from '@/lib/api/query';
import { useSession } from '@/lib/api/session';
import { useBrowserValue } from '@/lib/browser-value';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import { reactedHere, rememberReaction } from './memory';
import { reactionsFor, toggled, type ReactionState, type ReactionTargetType, type ReactionType } from './model';

export interface ReactionTarget {
  type: ReactionTargetType;
  id: string;
}

const targetKey = (type: ReactionType, t: ReactionTarget) => `${type}:${t.type}:${t.id}`;

/** Mounted buttons by target, so a reaction replayed after sign-in shows on its button. */
const listeners = new Map<string, Set<(s: ReactionState) => void>>();

/** Sends one reaction change; returns the server's count. */
export async function sendReaction(api: ApiClient, target: ReactionTarget, type: ReactionType, on: boolean): Promise<number> {
  const body = { target, reaction_type: type };
  const r = on ? await api.api('reactions.put', { body }) : await api.api('reactions.delete', { body });
  return r.count;
}

/**
 * The state machine of one reaction button: optimistic toggle, server count on success, rollback on failure.
 * Until the user acts, the button shows the server's count and what this browser remembers; a new count from the
 * server (initialCount) resets it. `send` is injectable for tests.
 */
export function useReaction(
  target: ReactionTarget,
  type: ReactionType,
  initialCount: number,
  o: { send?: (on: boolean) => Promise<number>; onError?: () => void } = {},
) {
  const api = useApiClient();
  const session = useSession();
  const userId = session.data?.user?.id ?? null;
  // What this browser remembers (the server render and hydration say "not reacted").
  const remembered = useBrowserValue(() => (userId ? reactedHere(userId, type, target.type, target.id) : false), false);
  const [local, setLocal] = useState<(ReactionState & { base: number }) | null>(null);
  const [busy, setBusy] = useState(false);
  const state: ReactionState =
    local && local.base === initialCount ? { on: local.on, count: local.count } : { on: remembered, count: initialCount };
  const key = targetKey(type, target);

  useEffect(() => {
    const set = listeners.get(key) ?? new Set();
    listeners.set(key, set);
    const listener = (s: ReactionState) => setLocal({ ...s, base: initialCount });
    set.add(listener);
    return () => void set.delete(listener);
  }, [key, initialCount]);

  const set = async (on: boolean) => {
    if (state.on === on || busy) return;
    const before = state;
    setLocal({ ...toggled(before), base: initialCount });
    setBusy(true);
    try {
      const count = await (o.send ?? ((v: boolean) => sendReaction(api, target, type, v)))(on);
      setLocal({ on, count, base: initialCount });
      if (userId) rememberReaction(userId, type, target.type, target.id, on);
    } catch {
      setLocal({ ...before, base: initialCount });
      o.onError?.();
    } finally {
      setBusy(false);
    }
  };

  return { ...state, busy, set, toggle: () => set(!state.on) };
}

/** Gives the reactions guests asked for before signing in (mount once per page that shows reactions). */
export function ReactionIntentHandlers() {
  const api = useApiClient();
  const session = useSession();
  const userId = session.data?.user?.id ?? null;
  const handle = (type: ReactionType) => async (intent: { target: string | null }) => {
    const [targetType, id] = (intent.target ?? '').split(':');
    if (!targetType || !id) return;
    const target = { type: targetType as ReactionTargetType, id };
    const count = await sendReaction(api, target, type, true);
    if (userId) rememberReaction(userId, type, target.type, target.id, true);
    for (const l of listeners.get(targetKey(type, target)) ?? []) l({ on: true, count });
  };
  useIntentHandler('react.helpful', handle('helpful'));
  useIntentHandler('react.like', handle('like'));
  return null;
}

function ReactionButton({
  target,
  type,
  label,
  icon,
  count,
}: {
  target: ReactionTarget;
  type: ReactionType;
  label: string;
  icon: 'thumb' | 'star' | 'heart';
  count: number;
}) {
  const t = useT();
  const f = useFormat();
  const toast = useToast();
  const gate = useGatedAction();
  const r = useReaction(target, type, count, { onError: () => toast(t('community.reaction.failed')) });
  return (
    <Button
      size="sm"
      variant="ghost"
      icon={icon}
      aria-pressed={r.on}
      disabled={r.busy}
      className={r.on ? 'pwa-reaction is-on' : 'pwa-reaction'}
      onClick={() =>
        gate({
          type: `react.${type}`,
          target: `${target.type}:${target.id}`,
          title: t('community.reaction.intent', { reaction: label }),
          run: () => r.toggle(),
        })
      }
    >
      {label}
      {r.count > 0 ? <span className="pwa-reaction-count">{f.number(r.count)}</span> : null}
    </Button>
  );
}

/** The reaction buttons a target allows (helpful and/or like), with their counts. */
export function Reactions({ target, counts }: { target: ReactionTarget; counts: Partial<Record<ReactionType, number>> }) {
  const t = useT();
  return (
    <div className="pwa-reactions" role="group" aria-label={t('community.reaction.group')}>
      {reactionsFor(target.type).map((r) => (
        <ReactionButton key={r.type} target={target} type={r.type} label={t(r.label)} icon={r.icon} count={counts[r.type] ?? 0} />
      ))}
    </div>
  );
}
