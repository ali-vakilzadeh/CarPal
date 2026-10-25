'use client';
// "Intent survives sign-in" (Docs/22 principle 2, GD-06, DI-01). A gated action by a guest opens a small context
// modal ("Sign in to follow Reza Auto Suspension") with Log in / Sign up. The action (type, target, return URL,
// optional form draft) is saved in the BFF pre-session (POST /bff/intents, 30 min, ≤ 8 KiB), the browser goes
// through the hosted sign-in, and back on the same page the replayer consumes the intent exactly once (POST
// /bff/intents/<id>/consume) and hands it to the handler the page registered for that type, which repeats the
// action and returns the toast text. Signed-in users run the action directly.
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ds/button';
import { consumeIntent, currentPath, loginUrl, saveIntent, SESSION_QUERY_KEY, useSession, type PendingIntent } from '@/lib/api/session';
import { goTo } from '@/lib/browser-nav';
import { useLocale, useT } from '@/lib/i18n/client';
import { Dialog } from './dialog';
import { useToast } from './toast';

export interface GatedAction<Draft = unknown> {
  /** Intent type, e.g. "follow" (a-z, digits, '_' or '.'). */
  type: string;
  /** What the action is about (an id), ≤ 200 characters. */
  target?: string;
  /** Form content to restore after sign-in (≤ 8 KiB with the rest). */
  draft?: Draft;
  /** Heading of the context modal, e.g. t('shell.intent.follow', { name }). */
  title?: string;
  /** Runs the action now (signed-in users). */
  run: () => void | Promise<void>;
}

/** Repeats a replayed action; returns the toast text (or nothing). */
export type IntentHandler<Draft = unknown> = (intent: PendingIntent<Draft>) => Promise<string | void> | string | void;

interface IntentContextValue {
  gate: <Draft>(action: GatedAction<Draft>) => void;
  register: (type: string, handler: IntentHandler) => () => void;
}

const IntentContext = createContext<IntentContextValue | null>(null);

/** Same page = same path (the query may change, e.g. a ?signin outcome or an open modal). */
export function isSamePage(returnTo: string, here: { pathname: string; origin: string }): boolean {
  try {
    return new URL(returnTo, here.origin).pathname === here.pathname;
  } catch {
    return false;
  }
}

export function IntentProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const queryClient = useQueryClient();
  const session = useSession();
  const handlers = useRef(new Map<string, IntentHandler>());
  const [handlerVersion, setHandlerVersion] = useState(0);
  const [pending, setPending] = useState<GatedAction | null>(null);
  const [busy, setBusy] = useState<'login' | 'signup' | null>(null);
  const replayed = useRef(new Set<string>());

  const gate = useCallback(
    <Draft,>(action: GatedAction<Draft>) => {
      if (session.data?.signed_in) void action.run();
      else setPending(action as GatedAction);
    },
    [session.data?.signed_in],
  );

  const register = useCallback((type: string, handler: IntentHandler) => {
    handlers.current.set(type, handler);
    setHandlerVersion((v) => v + 1);
    return () => {
      if (handlers.current.get(type) === handler) handlers.current.delete(type);
    };
  }, []);

  // Replay: once signed in, take each intent saved for this page whose handler is mounted.
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
          if (!intent) continue;
          const message = await handlers.current.get(intent.type)?.(intent);
          if (message) toast(message);
        } catch {
          toast(t('shell.intent.failed'));
        }
      }
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
    })();
  }, [session.data, handlerVersion, toast, t, queryClient]);

  const signIn = async (mode: 'login' | 'signup') => {
    if (!pending) return;
    setBusy(mode);
    const returnTo = currentPath();
    try {
      await saveIntent({ type: pending.type, target: pending.target, draft: pending.draft, returnTo });
    } catch {
      setBusy(null);
      toast(t('shell.intent.failed'));
      return;
    }
    goTo(loginUrl({ returnTo, locale, ...(mode === 'signup' ? { screen: 'signup' } : {}) }));
  };

  const value = useMemo(() => ({ gate, register }), [gate, register]);
  return (
    <IntentContext.Provider value={value}>
      {children}
      <Dialog
        name="auth-intent"
        open={pending !== null}
        onClose={() => {
          setPending(null);
          setBusy(null);
        }}
        title={pending?.title ?? t('shell.intent.title')}
        footer={
          <>
            <Button variant="primary" loading={busy === 'login'} disabled={busy !== null} onClick={() => void signIn('login')}>
              {t('shell.header.logIn')}
            </Button>
            <Button loading={busy === 'signup'} disabled={busy !== null} onClick={() => void signIn('signup')}>
              {t('shell.header.signUp')}
            </Button>
          </>
        }
      >
        <p className="pwa-text-body">{t('shell.intent.text')}</p>
      </Dialog>
    </IntentContext.Provider>
  );
}

function useIntentContext(): IntentContextValue {
  const value = useContext(IntentContext);
  if (!value) throw new Error('auth intent hooks outside <IntentProvider>');
  return value;
}

/** gate(action): runs it for a signed-in user, otherwise asks the guest to sign in and replays it afterwards. */
export function useGatedAction() {
  return useIntentContext().gate;
}

/** Registers how this page repeats a replayed action of `type` (keep the handler stable or memoised). */
export function useIntentHandler<Draft = unknown>(type: string, handler: IntentHandler<Draft>) {
  const { register } = useIntentContext();
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => register(type, (intent) => latest.current(intent as PendingIntent<Draft>)), [register, type]);
}
