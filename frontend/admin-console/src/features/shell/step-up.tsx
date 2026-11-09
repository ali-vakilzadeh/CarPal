'use client';
// Step-up (AC4.T5, GD-11, SEC-ADM-2 "sensitive operations need re-authentication within 5 min"): an action that the
// server answers with 401 STEP_UP_REQUIRED (an AAL3-tagged operation whose sign-in is not fresh enough) opens a short
// explanation; "Confirm with security key" saves the action in the BFF session (POST /bff/intents: type, target and a
// draft without secrets, 30 min, never in browser storage, GD-12) and goes through /bff/reauth (prompt=login, the
// same staff member, a fresh aal3 sign-in). Back on the same page, the replayer takes the saved action exactly once
// (POST /bff/intents/<id>/consume) and hands it to the handler the page registered for its type, which repeats it.
// Adapted from pwa/src/components/shell/step-up.tsx and auth-intent.tsx.
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ds/button';
import { Dialog } from '@/components/shell/dialog';
import { ApiProblem } from '@/lib/api/problem';
import { useSession } from '@/lib/api/query';
import { consumeIntent, currentPath, reauthUrl, saveIntent, SESSION_QUERY_KEY, type PendingIntent } from '@/lib/api/session';
import { goTo } from '@/lib/browser';
import { useT } from '@/lib/i18n/client';

export interface StepUpAction<T, Draft = unknown> {
  /** Intent type for the replay, e.g. "case.action" (a-z, digits, '_' or '.'). */
  type: string;
  /** What the action is about (an id), ≤ 200 characters. */
  target?: string;
  /** Plain values needed to repeat the action (the reason note, the chosen option); never secrets. ≤ 8 KiB. */
  draft?: Draft;
  run: () => Promise<T>;
}

export type StepUpResult<T> = { steppingUp: false; value: T } | { steppingUp: true };

/** Repeats a replayed action (the page decides whether it asks again or sends at once). */
export type IntentHandler<Draft = unknown> = (intent: PendingIntent<Draft>) => void | Promise<void>;

/** True when the server asked for a fresh security-key sign-in (RFC 9470 challenge, GD-11). */
export function needsStepUp(err: unknown): err is ApiProblem {
  return err instanceof ApiProblem && err.stepUp !== null;
}

/** Same page = same path (the query may differ, e.g. a ?signin outcome). */
export function isSamePage(returnTo: string, here: { pathname: string; origin: string }): boolean {
  try {
    return new URL(returnTo, here.origin).pathname === here.pathname;
  } catch {
    return false;
  }
}

interface StepUpContextValue {
  run: <T, Draft = unknown>(action: StepUpAction<T, Draft>) => Promise<StepUpResult<T>>;
  register: (type: string, handler: IntentHandler) => () => void;
}

const StepUpContext = createContext<StepUpContextValue | null>(null);

export function StepUpProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const session = useSession();
  const queryClient = useQueryClient();
  const handlers = useRef(new Map<string, IntentHandler>());
  const [handlerVersion, setHandlerVersion] = useState(0);
  const [pending, setPending] = useState<{ type: string; target?: string; draft?: unknown } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const replayed = useRef(new Set<string>());

  const run = useCallback(async <T, Draft = unknown>(action: StepUpAction<T, Draft>): Promise<StepUpResult<T>> => {
    try {
      return { steppingUp: false, value: await action.run() };
    } catch (err) {
      if (!needsStepUp(err)) throw err;
      setFailed(false);
      setPending({
        type: action.type,
        ...(action.target ? { target: action.target } : {}),
        ...(action.draft !== undefined ? { draft: action.draft } : {}),
      });
      return { steppingUp: true };
    }
  }, []);

  const register = useCallback((type: string, handler: IntentHandler) => {
    handlers.current.set(type, handler);
    setHandlerVersion((v) => v + 1);
    return () => {
      if (handlers.current.get(type) === handler) handlers.current.delete(type);
    };
  }, []);

  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    setFailed(false);
    const returnTo = currentPath();
    try {
      const intent = await saveIntent({ ...pending, returnTo });
      goTo(reauthUrl({ returnTo, intent }));
    } catch {
      setBusy(false);
      setFailed(true);
    }
  };

  // Replay: once back and signed in, take each action saved for this page whose handler is mounted, once.
  useEffect(() => {
    const view = session.data;
    if (!view?.signed_in || view.pending_intents.length === 0) return;
    const here = { pathname: location.pathname, origin: location.origin };
    const due = view.pending_intents.filter(
      (i) => isSamePage(i.return_to, here) && handlers.current.has(i.type) && !replayed.current.has(i.id),
    );
    if (due.length === 0) return;
    for (const i of due) replayed.current.add(i.id);
    void (async () => {
      for (const i of due) {
        try {
          const intent = await consumeIntent(i.id);
          if (intent) await handlers.current.get(intent.type)?.(intent);
        } catch {
          // The page's own error handling shows what went wrong when it repeats the action.
        }
      }
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
    })();
  }, [session.data, handlerVersion, queryClient]);

  const value = useMemo(() => ({ run, register }), [run, register]);
  return (
    <StepUpContext.Provider value={value}>
      {children}
      <Dialog
        open={pending !== null}
        onClose={() => {
          setPending(null);
          setBusy(false);
        }}
        title={t('admin.shell.stepUp.title')}
        name="step-up"
        footer={
          <>
            <Button variant="primary" icon="lock" loading={busy} onClick={() => void confirm()}>
              {t('admin.shell.stepUp.continue')}
            </Button>
            <Button disabled={busy} onClick={() => setPending(null)}>
              {t('common.actions.cancel')}
            </Button>
          </>
        }
      >
        <p>{t('admin.shell.stepUp.text')}</p>
        {failed ? (
          <p className="adm-auth-error" role="alert">
            {t('admin.shell.stepUp.failed')}
          </p>
        ) : null}
      </Dialog>
    </StepUpContext.Provider>
  );
}

function useStepUpContext(): StepUpContextValue {
  const value = useContext(StepUpContext);
  if (!value) throw new Error('step-up hooks outside <StepUpProvider>');
  return value;
}

/** Runs an action; on STEP_UP_REQUIRED asks to confirm with the security key and resolves to { steppingUp: true }. */
export function useStepUp() {
  return useStepUpContext().run;
}

/** Registers how this page repeats a replayed action of `type` after the step-up. */
export function useIntentHandler<Draft = unknown>(type: string, handler: IntentHandler<Draft>): void {
  const { register } = useStepUpContext();
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => register(type, (intent) => latest.current(intent as PendingIntent<Draft>)), [register, type]);
}
