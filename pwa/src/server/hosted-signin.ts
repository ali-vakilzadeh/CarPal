// What the hosted sign-in page needs from the server (P4.T1): where to go on completion (the authorize request that
// started this interaction, from the /id proxy's resume cookie), where "Start again" goes when it expired, and what
// /bff/login asked to show (screen=signup, the gated action's label). The hosted sign-in shares the origin and the
// session store with the BFF in the GD-05 topology; a separate id host (OQ-03) would need these carried otherwise.
import 'server-only';
import { headers } from 'next/headers';
import { loginHint, readResumeCookie, restartUrl, resumeUrl } from './bff';
import { bff, bffConfig } from './bff-runtime';

const INTERACTION_ID = /^[A-Za-z0-9_-]{1,100}$/;

export interface HostedSigninContext {
  interactionId: string | null;
  resumeUrl: string | null;
  restartUrl: string;
  screen: 'signin' | 'signup';
  context: string | null;
}

export async function hostedSigninContext(rawInteractionId: unknown): Promise<HostedSigninContext> {
  const interactionId = typeof rawInteractionId === 'string' && INTERACTION_ID.test(rawInteractionId) ? rawInteractionId : null;
  const cookie = (await headers()).get('cookie');
  const info = readResumeCookie(cookie, interactionId);
  let hint: { screen: 'signin' | 'signup'; context: string | null } = { screen: 'signin', context: null };
  const state = info?.query.get('state');
  if (state) {
    try {
      const session = await bff().sessions.load(new Request('http://bff.internal/', { headers: { cookie: cookie ?? '' } }));
      hint = loginHint(session, state, Date.now());
    } catch (err) {
      console.warn('hosted sign-in: session lookup failed', err);
    }
  }
  return {
    interactionId,
    resumeUrl: info ? resumeUrl(info) : null,
    restartUrl: restartUrl(info, bffConfig()),
    ...hint,
  };
}
