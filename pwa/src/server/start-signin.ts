// /<locale>/login and /<locale>/signup (W-AUTH-01 full-page entry points, Docs/22): start the hosted sign-in and come
// back to ?next=<path> (default: home) through the onboarding check. A visitor already signed in goes straight on.
import 'server-only';
import { redirect } from 'next/navigation';
import { buildLoginUrl, safeNextPath } from '@/lib/api/login-url';
import { isLocale } from '@/lib/i18n/locales';
import { serverSession } from './session';

export interface SigninPageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function startSignin({ params, searchParams }: SigninPageProps, screen?: 'signup'): Promise<never> {
  const [{ locale }, sp, session] = await Promise.all([params, searchParams, serverSession()]);
  const lang = isLocale(locale) ? locale : 'fa';
  const next = safeNextPath(typeof sp.next === 'string' ? sp.next : null) ?? `/${lang}/home`;
  if (session.view.signed_in) redirect(next);
  redirect(buildLoginUrl({ returnTo: next, locale: lang, ...(screen ? { screen } : {}) }));
}
