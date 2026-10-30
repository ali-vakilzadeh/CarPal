// Unread-count polling rules (P9.T1, Docs/40 SEC-RL-3): once a minute, never before the server's CarPal-Poll-After-Ms,
// doubled per consecutive failure up to 15 minutes, and not while the tab is hidden.
export const UNREAD_POLL_MS = 60_000;
/** The longest wait between unread-count polls after repeated failures. */
export const MAX_UNREAD_POLL_MS = 15 * 60_000;

export function unreadPollDelay(o: { pollAfterMs: number | null; failures: number; hidden: boolean }): number | false {
  if (o.hidden) return false;
  const base = Math.max(UNREAD_POLL_MS, o.pollAfterMs ?? 0);
  if (o.failures <= 0) return base;
  return Math.min(base * 2 ** Math.min(o.failures, 10), Math.max(MAX_UNREAD_POLL_MS, base));
}

/** Consecutive failed polls, counted once per failure (the interval callback also runs on re-renders). */
export function countFailures(prev: { failures: number; lastErrorAt: number }, s: { errorUpdatedAt: number; dataUpdatedAt: number }) {
  if (s.errorUpdatedAt > s.dataUpdatedAt) {
    return s.errorUpdatedAt === prev.lastErrorAt ? prev : { failures: prev.failures + 1, lastErrorAt: s.errorUpdatedAt };
  }
  return { failures: 0, lastErrorAt: prev.lastErrorAt };
}

export function unreadBadge(count: number, number: (n: number) => string): string | undefined {
  if (count <= 0) return undefined;
  return count > 99 ? `${number(99)}+` : number(count);
}
