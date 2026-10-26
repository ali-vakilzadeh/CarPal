// /bff/login URLs (P2.T7, P4). Shared by client components and server pages (/login, /signup), so no 'use client'.
//
// After sign-up or sign-in the browser first passes /<locale>/onboarding?next=<page> (P4.T7): it runs the web
// onboarding when the account has not finished it, then goes on to the page, where a pending intent replays (GD-06).
// A step-up comes straight back to the page (the account is onboarded already).
import { DEFAULT_LOCALE, isLocale } from '@/lib/i18n/locales';

export interface LoginUrlOptions {
  /** Where to come back to (a same-origin path). */
  returnTo: string;
  /** Re-authenticate at this level (prompt=login, BA-11). */
  stepUp?: 'aal2' | 'aal3';
  /** UI language of the hosted sign-in when the return path has none. */
  locale?: string;
  /** Open the hosted sign-in on account creation. */
  screen?: 'signup';
  /** The saved gated action (its label is the hosted sign-in's context line). */
  intent?: string;
  /** "Switch account": ask for credentials even when the auth host remembers a sign-in (prompt=login). */
  switchAccount?: boolean;
}

/** A same-origin path that is not a BFF, API or auth-host endpoint; anything else is null. */
export function safeNextPath(value: string | null | undefined): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
  if ([...value].some((c) => c < ' ' || c === '\x7f')) return null;
  if (/^\/(bff|api|id)(\/|$)/.test(value)) return null;
  return value;
}

function localeOfPath(path: string, fallback?: string): string {
  const first = path.split('/')[1]?.split(/[?#]/)[0];
  if (isLocale(first)) return first;
  return isLocale(fallback) ? fallback : DEFAULT_LOCALE;
}

/** The page after sign-in: the onboarding check first, unless this is a step-up or the page is the onboarding itself. */
export function afterSigninPath(returnTo: string, locale?: string): string {
  const lang = localeOfPath(returnTo, locale);
  if (returnTo.split(/[?#]/)[0] === `/${lang}/onboarding`) return returnTo;
  return `/${lang}/onboarding?${new URLSearchParams({ next: returnTo }).toString()}`;
}

export function buildLoginUrl(o: LoginUrlOptions): string {
  const returnTo = safeNextPath(o.returnTo) ?? `/${localeOfPath('', o.locale)}`;
  const p = new URLSearchParams({ return_to: o.stepUp ? returnTo : afterSigninPath(returnTo, o.locale) });
  if (o.stepUp) p.set('step_up', o.stepUp);
  if (o.locale) p.set('locale', o.locale);
  if (o.screen) p.set('screen', o.screen);
  if (o.intent) p.set('intent', o.intent);
  if (o.switchAccount) p.set('prompt', 'login');
  return `/bff/login?${p.toString()}`;
}
