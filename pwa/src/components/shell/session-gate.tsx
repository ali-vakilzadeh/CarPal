'use client';
// Signed-in tools (the (app) group) need a session. The server cannot always tell (a cross-site arrival carries no
// SameSite=Strict cookie, P2 notes), so it never redirects; this gate asks the session view. Signed in → the page.
// Guest → straight to the hosted sign-in with this page as the return URL; if the browser just came back from a
// failed or cancelled sign-in (?signin=<outcome>), it shows a "Log in to see this page" state instead of looping.
import { useEffect, type ReactNode } from 'react';
import { buttonClass } from '@/components/ds/button';
import { useSearchParams } from 'next/navigation';
import { useSession } from '@/lib/api/session';
import { goTo } from '@/lib/browser-nav';
import { useT } from '@/lib/i18n/client';
import { SkeletonList } from './skeleton';
import { StateView } from './states';
import { useLoginHref } from './use-login-href';

export function SessionGate({ children }: { children: ReactNode }) {
  const t = useT();
  const session = useSession();
  const search = useSearchParams();
  const loginHref = useLoginHref();
  const cameBack = search.has('signin');
  const guest = session.data !== undefined && !session.data.signed_in && !session.isFetching;

  useEffect(() => {
    if (guest && !cameBack) goTo(loginHref);
  }, [guest, cameBack, loginHref]);

  if (session.data?.signed_in) return <>{children}</>;
  if (guest && cameBack)
    return (
      <StateView
        kind="noAccess"
        t={t}
        title={t('shell.session.required')}
        text={t('shell.session.requiredText')}
        action={
          <a href={loginHref} className={buttonClass({ variant: 'primary' })}>
            <span className="cp-btn-label">{t('shell.header.logIn')}</span>
          </a>
        }
      />
    );
  return <SkeletonList count={2} label={t('shell.session.checking')} />;
}
