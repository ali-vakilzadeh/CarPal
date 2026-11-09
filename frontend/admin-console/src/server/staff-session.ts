// The signed-in staff member for server components (AC4.T3/T6): the BFF session view of this request's cookie, read
// straight from the session store (the same view /bff/session returns: never tokens). Reading it is not activity
// (D-20). Memoised per request, so the console layout, the page and the no-permission page share one read.
import 'server-only';
import { headers } from 'next/headers';
import { cache } from 'react';
import { PATH_HEADER } from '@/lib/i18n/locales';
import { sessionView, type SessionView } from './bff';
import { bff } from './bff-runtime';

export const currentSession = cache(async (): Promise<SessionView> => {
  const cookie = (await headers()).get('cookie') ?? '';
  const b = bff();
  const record = await b.sessions.load(new Request('http://bff.internal/', { headers: { cookie } }));
  return sessionView(record, b.sessions, Date.now());
});

/**
 * The page's path and query as the proxy saw them; null when the proxy did not run, i.e. a file-like path its matcher
 * skips (/favicon.ico, /robots.txt …), which is never a console page.
 */
export async function proxiedPath(): Promise<string | null> {
  const value = (await headers()).get(PATH_HEADER);
  return value && value.startsWith('/') ? value : null;
}

/** The page's path and query ('/' when the proxy did not run). */
export async function requestPath(): Promise<string> {
  return (await proxiedPath()) ?? '/';
}
