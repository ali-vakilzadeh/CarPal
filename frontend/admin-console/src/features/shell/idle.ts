// Idle handling (AC4.T4, SEC-ADM-2, Docs/23 A-AUTH-01): the BFF ends a staff session after 30 minutes without an API
// call (D-20) and after 8 hours in any case; the shell warns 5 minutes before (at 25 minutes) and signs out at the end.
// The deadline is measured on the browser's clock from the time left that the server reported (idle_expires_at −
// server_time), so a staff PC whose clock is off still warns in time. It is anchored to the first view that reported
// a deadline: re-reading the session every minute does not move it (reads are not activity), only a new deadline from
// the server does (an API call, "Stay signed in", a step-up).
import type { SessionView } from '@/lib/api/session';

export const IDLE_WARNING_MS = 5 * 60_000;

export class DeadlineClock {
  #anchor: { key: string; deadline: number } | null = null;

  /** The browser time at which the session ends without activity; null when signed out. */
  deadline(view: Pick<SessionView, 'idle_expires_at' | 'server_time'> | undefined, now: number): number | null {
    if (!view?.idle_expires_at) {
      this.#anchor = null;
      return null;
    }
    const key = view.idle_expires_at;
    if (this.#anchor?.key !== key) {
      const left = Date.parse(view.idle_expires_at) - Date.parse(view.server_time);
      this.#anchor = { key, deadline: now + (Number.isFinite(left) ? left : 0) };
    }
    return this.#anchor.deadline;
  }

  /**
   * Forget the anchor: the next view sets the deadline again. After "Stay signed in" the server confirmed activity,
   * but it writes activity back at most once a minute (TOUCH_INTERVAL_MS), so the reported deadline may be unchanged.
   */
  reset(): void {
    this.#anchor = null;
  }
}

export type IdlePhase = { phase: 'active' } | { phase: 'warning'; leftMs: number } | { phase: 'ended' };

export function idlePhase(deadline: number | null, now: number): IdlePhase {
  if (deadline === null) return { phase: 'active' };
  const left = deadline - now;
  if (left <= 0) return { phase: 'ended' };
  if (left <= IDLE_WARNING_MS) return { phase: 'warning', leftMs: left };
  return { phase: 'active' };
}

/** True when the end is the 8-hour limit, which "Stay signed in" cannot move. */
export function endsAbsolutely(view: Pick<SessionView, 'idle_expires_at' | 'expires_at'> | undefined): boolean {
  return !!view?.idle_expires_at && view.idle_expires_at === view.expires_at;
}

/** Where a signed-out browser goes: the signed-out page, which offers a sign-in back to `returnTo`. */
export function signedOutUrl(reason: 'idle' | 'ended' | 'logout' | string, returnTo?: string): string {
  const q = new URLSearchParams({ reason });
  if (returnTo && returnTo !== '/') q.set('return_to', returnTo);
  return `/id/signed-out?${q.toString()}`;
}
