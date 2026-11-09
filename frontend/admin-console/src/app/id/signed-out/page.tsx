// After a staff session ends (AC4.T4): ?reason=idle (30 minutes without activity), ended (8 hours, revoked, ended on
// the server), logout (the staff member signed out), or a sign-in outcome of /bff/oauth/callback (?reason=not_staff …)
// when nobody is signed in. "Sign in again" starts a new aal3 sign-in back to ?return_to (a same-origin console path).
// No session needed and no data shown.
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { buttonClass } from '@/components/ds/button';
import { PlainFrame } from '@/components/shell/plain-frame';
import { isSigninOutcome, outcomeMessage } from '@/features/auth/problems';
import { loginUrl, safeNextPath } from '@/lib/api/session';
import { getTranslator } from '@/lib/i18n/dictionary';
import type { MessageKey } from '@/lib/i18n/keys';
import { LOCALES } from '@/lib/i18n/locales';
import { prefHref } from '@/lib/prefs';
import { requestLocale } from '@/server/request-locale';
import { currentSession, requestPath } from '@/server/staff-session';

export async function generateMetadata(): Promise<Metadata> {
  return { title: getTranslator(await requestLocale())('admin.signedOut.metaTitle') };
}

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

function texts(reason: string): { title: MessageKey; text: MessageKey } {
  if (reason === 'idle') return { title: 'admin.signedOut.idleTitle', text: 'admin.signedOut.idleText' };
  if (reason === 'logout') return { title: 'admin.signedOut.logoutTitle', text: 'admin.signedOut.logoutText' };
  if (isSigninOutcome(reason)) return { title: 'admin.signedOut.signinTitle', text: outcomeMessage(reason) };
  return { title: 'admin.signedOut.endedTitle', text: 'admin.signedOut.endedText' };
}

export default async function SignedOutPage({ searchParams }: Props) {
  const [sp, locale, path, session] = await Promise.all([searchParams, requestLocale(), requestPath(), currentSession()]);
  const returnTo = safeNextPath(typeof sp.return_to === 'string' ? sp.return_to : null) ?? '/';
  // Signed in again in another tab: nothing to say here.
  if (session.signed_in) redirect(returnTo);
  const t = getTranslator(locale);
  const { title, text } = texts(typeof sp.reason === 'string' ? sp.reason : 'ended');
  const languages = LOCALES.map((l) => ({ locale: l, href: prefHref(path, 'lang', l), current: l === locale }));
  return (
    <PlainFrame languages={languages} narrow>
      <div className="adm-auth-step" data-testid="signed-out">
        <h1 className="adm-auth-title">{t(title)}</h1>
        <p className="adm-auth-text">{t(text)}</p>
        <a className={buttonClass({ variant: 'primary', block: true })} href={loginUrl(returnTo)}>
          <span className="cp-btn-label">{t('admin.signedOut.signIn')}</span>
        </a>
      </div>
    </PlainFrame>
  );
}
