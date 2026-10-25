// The BFF session as seen by server rendering (P3.T4): read from the session store with the request's cookie, never
// creating a session (like /bff/session). `confirmed` is false when the request carried no session cookie — on a
// cross-site arrival SameSite=Strict withholds it even from a signed-in user, so the browser re-checks (P2 notes).
import 'server-only';
import { headers } from 'next/headers';
import type { SessionView } from '@/lib/api/session';
import { SESSION_COOKIE, sessionView } from './bff';
import { bff } from './bff-runtime';

export const GUEST_SESSION: SessionView = { signed_in: false, user: null, locale: null, pending_intents: [] };

export async function serverSession(): Promise<{ view: SessionView; confirmed: boolean }> {
  const cookie = (await headers()).get('cookie') ?? '';
  if (!cookie.split(';').some((c) => c.trim().startsWith(`${SESSION_COOKIE}=`))) return { view: GUEST_SESSION, confirmed: false };
  try {
    const record = await bff().sessions.load(new Request('http://bff.internal/', { headers: { cookie } }));
    return { view: sessionView(record, Date.now()) as SessionView, confirmed: true };
  } catch (err) {
    console.warn('session lookup failed during rendering', err);
    return { view: GUEST_SESSION, confirmed: false };
  }
}
