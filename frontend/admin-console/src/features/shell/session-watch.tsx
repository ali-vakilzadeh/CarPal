'use client';
// The signed-in session in the shell (AC4.T4): the idle warning 5 minutes before the end ("Stay signed in" makes an
// API call, admin.staff_me, which is activity for the BFF; "Sign out now"), the sign-out at the end, and the move to
// the signed-out page when the BFF reports the session gone (an API call answered SESSION_ENDED, or the session view
// says signed out). Every way out clears the query cache first (GD-12: useLogout, or the provider on SESSION_ENDED).
// The avatar menu's "Sign out" goes through the same exit (useSignOut), so the watch does not mistake it for a session
// the server ended.
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ds/button';
import { Dialog } from '@/components/shell/dialog';
import { SESSION_ENDED_EVENT, useApiClient, useLogout, useSession } from '@/lib/api/query';
import { currentPath, SESSION_QUERY_KEY } from '@/lib/api/session';
import { goTo } from '@/lib/browser';
import { clock } from '@/lib/format/clock';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import { DeadlineClock, endsAbsolutely, idlePhase, signedOutUrl, type IdlePhase } from './idle';

const TICK_MS = 1000;

type Exit = (reason: 'idle' | 'ended' | 'logout', signOut: boolean) => void;
const ExitContext = createContext<Exit | null>(null);

/** Signs the staff member out and shows the signed-out page (one way out for the whole shell). */
export function useSignOut(): () => void {
  const exit = useContext(ExitContext);
  if (!exit) throw new Error('useSignOut outside <SessionWatch>');
  return useCallback(() => exit('logout', true), [exit]);
}

export function SessionWatch({ children }: { children?: ReactNode }) {
  const t = useT();
  const f = useFormat();
  const session = useSession();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const logout = useLogout();
  const [deadlines] = useState(() => new DeadlineClock());
  const [phase, setPhase] = useState<IdlePhase>({ phase: 'active' });
  const [staying, setStaying] = useState(false);
  const leaving = useRef(false);
  const view = session.data;

  const leave = (reason: 'idle' | 'ended' | 'logout', signOut: boolean) => {
    if (leaving.current) return;
    leaving.current = true;
    const returnTo = currentPath();
    void (signOut ? logout() : Promise.resolve()).finally(() => goTo(signedOutUrl(reason, reason === 'logout' ? undefined : returnTo)));
  };
  const leaveRef = useRef(leave);
  useEffect(() => {
    leaveRef.current = leave;
  });

  // The clock: once a second, from the deadline the server last reported.
  useEffect(() => {
    if (!view?.signed_in) return;
    const tick = () => {
      const now = Date.now();
      const next = idlePhase(deadlines.deadline(view, now), now);
      if (next.phase === 'ended') leaveRef.current('idle', true);
      setPhase(next);
    };
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, TICK_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [view, deadlines]);

  // The BFF ended the session (idle on the server, 8 hours, revoked): the cache is already cleared by the provider.
  useEffect(() => {
    const onEnded = () => leaveRef.current('ended', false);
    window.addEventListener(SESSION_ENDED_EVENT, onEnded);
    return () => window.removeEventListener(SESSION_ENDED_EVENT, onEnded);
  }, []);
  useEffect(() => {
    if (view && !view.signed_in) leaveRef.current('ended', true);
  }, [view]);

  const stay = async () => {
    setStaying(true);
    try {
      await api.api('admin.staff_me');
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      deadlines.reset();
    } catch {
      // A failed call that ended the session moves on through SESSION_ENDED; anything else leaves the warning up.
    } finally {
      setStaying(false);
    }
  };

  const exit = useCallback<Exit>((reason, signOut) => leaveRef.current(reason, signOut), []);
  const absolute = endsAbsolutely(view);
  const left = phase.phase === 'warning' ? clock(phase.leftMs / 1000, f.digits) : '';
  return (
    <ExitContext.Provider value={exit}>
      {children}
      <Dialog
        open={phase.phase === 'warning'}
        onClose={() => undefined}
        dismissible={false}
        role="alertdialog"
        title={t('admin.shell.idle.title')}
        name="idle-warning"
        footer={
          <>
            {absolute ? null : (
              <Button variant="primary" loading={staying} onClick={() => void stay()}>
                {t('admin.shell.idle.stay')}
              </Button>
            )}
            <Button variant={absolute ? 'primary' : 'secondary'} disabled={staying} onClick={() => leave('logout', true)}>
              {t('admin.shell.idle.signOut')}
            </Button>
          </>
        }
      >
        <p data-testid="idle-left">{t(absolute ? 'admin.shell.idle.endText' : 'admin.shell.idle.text', { time: left })}</p>
      </Dialog>
    </ExitContext.Provider>
  );
}
