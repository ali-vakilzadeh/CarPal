// What the staff sign-in page needs from the server (AC4.T1), adapted from pwa/src/server/hosted-signin.ts: where to
// go on completion (the authorize request that started this interaction, from the /id proxy's resume cookie), where
// "Start again" goes when it expired (keeps the return path), and whether the request was a step-up (prompt=login).
import 'server-only';
import { headers } from 'next/headers';
import { readResumeCookie, restartUrl, resumeUrl } from './bff';
import { bffConfig } from './bff-runtime';

const INTERACTION_ID = /^[A-Za-z0-9_-]{1,100}$/;

export interface SigninContext {
  interactionId: string | null;
  resumeUrl: string | null;
  restartUrl: string;
  stepUp: boolean;
}

export async function signinContext(rawInteractionId: unknown): Promise<SigninContext> {
  const interactionId = typeof rawInteractionId === 'string' && INTERACTION_ID.test(rawInteractionId) ? rawInteractionId : null;
  const info = readResumeCookie((await headers()).get('cookie'), interactionId);
  return {
    interactionId,
    resumeUrl: info ? resumeUrl(info) : null,
    restartUrl: restartUrl(info, bffConfig()),
    stepUp: info?.query.get('prompt') === 'login',
  };
}
