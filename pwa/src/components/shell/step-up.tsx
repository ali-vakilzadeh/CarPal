'use client';
// Step-up for AAL2 operations (P9.T2, BA-11, Docs/40 SEC-AU-10): the API answers 401 STEP_UP_REQUIRED (acr_values,
// max_age=600) when the session is not fresh or strong enough. withStepUp() runs the action; on that answer it saves
// the action as an intent in the BFF session (GD-06; a draft without secrets) and re-authenticates through
// /bff/login?step_up=aal2 (prompt=login), which comes straight back to this page. The page's intent handler for the
// same type then repeats the action once (useIntentHandler). Actions that need a fresh user gesture (a passkey
// ceremony) or a secret the user typed (a password) save no draft: their handler reopens the form instead.
import { useCallback } from 'react';
import { ApiProblem } from '@/lib/api/problem';
import { loginUrl, saveIntent } from '@/lib/api/session';
import { goTo } from '@/lib/browser-nav';
import { useLocale } from '@/lib/i18n/client';

export interface StepUpAction<T, Draft = unknown> {
  /** Intent type for the replay, e.g. "settings.sessions_revoke_all". */
  type: string;
  target?: string;
  /** Plain values needed to repeat the action (never passwords or codes). */
  draft?: Draft;
  /** Hosted sign-in context line ("Confirm it's you to sign out other devices"). */
  label?: string;
  run: () => Promise<T>;
}

/** True when the API asked for a stronger or fresher sign-in. */
export function needsStepUp(err: unknown): err is ApiProblem {
  return err instanceof ApiProblem && err.stepUp !== null;
}

/** Runs an AAL2 action; on STEP_UP_REQUIRED leaves for the step-up sign-in and resolves to { steppingUp: true }. */
export function useStepUp() {
  const locale = useLocale();
  return useCallback(
    async <T, Draft = unknown>(a: StepUpAction<T, Draft>): Promise<{ steppingUp: false; value: T } | { steppingUp: true }> => {
      try {
        return { steppingUp: false, value: await a.run() };
      } catch (err) {
        if (!needsStepUp(err)) throw err;
        const intent = await saveIntent({ type: a.type, target: a.target, draft: a.draft, label: a.label });
        goTo(loginUrl({ stepUp: err.stepUp!.acrValues, locale, intent }));
        return { steppingUp: true };
      }
    },
    [locale],
  );
}
