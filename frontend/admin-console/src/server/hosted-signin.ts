// What the staff sign-in page needs from the server (AC4.T1), adapted from pwa/src/server/hosted-signin.ts: where to
// go on completion (the authorize request that started this interaction, from the /id proxy's resume cookie), where
// "Start again" goes when it expired (keeps the return path), and whether the request was a step-up (prompt=login).
import 'server-only';
import { headers } from 'next/headers';
import { RECOVERY_COOKIE, readResumeCookie, restartUrl, resumeUrl } from './bff';
import { bffConfig } from './bff-runtime';

const INTERACTION_ID = /^[A-Za-z0-9_-]{1,100}$/;

export interface SigninContext {
  interactionId: string | null;
  resumeUrl: string | null;
  restartUrl: string;
  stepUp: boolean;
  /** A staff account recovery was started in this browser and may be waiting or approved (AC10b): offer to continue. */
  recoveryPending: boolean;
}

export async function signinContext(rawInteractionId: unknown): Promise<SigninContext> {
  const interactionId = typeof rawInteractionId === 'string' && INTERACTION_ID.test(rawInteractionId) ? rawInteractionId : null;
  const cookie = (await headers()).get('cookie');
  const info = readResumeCookie(cookie, interactionId);
  const stepUp = info?.query.get('prompt') === 'login';
  return {
    interactionId,
    resumeUrl: info ? resumeUrl(info) : null,
    restartUrl: restartUrl(info, bffConfig()),
    stepUp,
    // Presence only: the handle stays in the BFF; a step-up is never a recovery.
    recoveryPending:
      !stepUp &&
      (cookie ?? '')
        .split(';')
        .some((c) => /^[A-Za-z0-9_-]{43}$/.test(c.trim().slice(RECOVERY_COOKIE.length + 1)) && c.trim().startsWith(`${RECOVERY_COOKIE}=`)),
  };
}
