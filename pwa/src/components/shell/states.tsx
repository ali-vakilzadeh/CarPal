// Defined UI states (GD-13, Docs/21 §1 "honest empty states"): every screen maps a failure or a missing feature to
// one of these instead of crashing or looping. stateFromProblem() turns an API error into its state: 501 → not
// available yet, 503 AI_UNAVAILABLE → AI off (the expected pilot state), FEATURE_DISABLED → feature off, 404 → not
// found (never "forbidden", SEC-AZ-2), 410 → removed, network → offline, long rate limits → wait.
import type { ReactNode } from 'react';
import { cx } from '@/components/ds/cx';
import { Icon, type IconName } from '@/components/ds/icon';
import type { MessageKey, Translate } from '@/lib/i18n/keys';
import { ApiProblem } from '@/lib/api/problem';

export type StateKind =
  | 'notAvailable'
  | 'featureOff'
  | 'aiOff'
  | 'noAccess'
  | 'removed'
  | 'beingReviewed'
  | 'notFound'
  | 'error'
  | 'offline'
  | 'rateLimited'
  | 'empty';

const STATE: Record<StateKind, { icon: IconName; tone?: 'danger'; title: MessageKey; text?: MessageKey }> = {
  notAvailable: { icon: 'clock', title: 'states.notAvailable.title', text: 'states.notAvailable.text' },
  featureOff: { icon: 'info', title: 'states.featureOff.title', text: 'states.featureOff.text' },
  aiOff: { icon: 'spark', title: 'states.aiOff.title', text: 'states.aiOff.text' },
  noAccess: { icon: 'lock', title: 'states.noAccess.title', text: 'states.noAccess.text' },
  removed: { icon: 'trash', title: 'states.removed.title', text: 'states.removed.text' },
  beingReviewed: { icon: 'eye', title: 'states.beingReviewed.title', text: 'states.beingReviewed.text' },
  notFound: { icon: 'search', title: 'states.notFound.title', text: 'states.notFound.text' },
  error: { icon: 'alert', tone: 'danger', title: 'states.error.title', text: 'states.error.text' },
  offline: { icon: 'offline', title: 'states.offline.title', text: 'states.offline.text' },
  rateLimited: { icon: 'clock', title: 'states.rateLimited.title', text: 'states.rateLimited.text' },
  empty: { icon: 'info', title: 'states.empty.title' },
};

export function stateFromProblem(err: unknown): StateKind {
  if (!(err instanceof ApiProblem)) return 'error';
  if (err.code === 'AI_UNAVAILABLE') return 'aiOff';
  if (err.code === 'FEATURE_DISABLED') return 'featureOff';
  if (err.status === 501) return 'notAvailable';
  if (err.status === 410 || err.code === 'LINK_EXPIRED' || err.code === 'LINK_USED') return 'removed';
  if (err.status === 404) return 'notFound';
  if (err.code === 'NETWORK') return 'offline';
  if (err.status === 429 || err.code === 'RATE_LIMITED' || err.code === 'PAUSED') return 'rateLimited';
  return 'error';
}

export interface StateViewProps {
  kind: StateKind;
  t: Translate;
  /** Overrides the default heading / text (e.g. a screen-specific empty state). */
  title?: string;
  text?: string;
  /** For rateLimited: the wait, already formatted ("2 minutes"). */
  wait?: string;
  /** One clear next step (Docs/21 principle 10), e.g. a Retry button. */
  action?: ReactNode;
  /** Compact = inline in a card or list instead of a full section. */
  compact?: boolean;
  headingLevel?: 2 | 3;
  className?: string;
}

/** Takes `t` as a prop so it renders in server and client components alike. */
export function StateView({ kind, t, title, text, wait, action, compact, headingLevel = 2, className }: StateViewProps) {
  const s = STATE[kind];
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const body = text ?? (s.text ? t(s.text, wait ? { time: wait } : undefined) : undefined);
  return (
    <section
      className={cx('pwa-state', compact && 'is-compact', className)}
      data-state={kind}
      aria-live={kind === 'error' ? 'polite' : undefined}
    >
      <span className={cx('pwa-state-mark', s.tone && `is-${s.tone}`)} aria-hidden="true">
        <Icon name={s.icon} size={compact ? 24 : 40} />
      </span>
      <Heading className="pwa-state-title">{title ?? t(s.title)}</Heading>
      {body ? <p className="pwa-state-text">{body}</p> : null}
      {action ? <div className="pwa-state-action">{action}</div> : null}
    </section>
  );
}
