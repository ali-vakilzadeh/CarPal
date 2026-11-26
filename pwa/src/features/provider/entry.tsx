'use client';
// The Workshop's own pages outside the tabs:
//   /<locale>/provider         PW-AUTH-01 (mockup 'Sign in to your workshop'): signed out, what the app does and Sign in
//                              (the hosted sign-in of the PWA, RF-01: no own code form here) with sign-up for new
//                              shops; signed in, straight to Today. It is the address the Web UI sign-in button and
//                              the Workshop manifest open (PP1.T6, PW8.T1).
//   /<locale>/provider/start   the compact onboarding (PW2, onboarding.tsx); Sign up here returns to it.
//   replies, photos            the tabs whose screens arrive in PW5 and PW7: a "coming soon" state with Open in
//                              Web UI, so a notification link never lands on a 404.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { StateBlock } from '@carpal/business-ui';
import { buttonClass } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { SkeletonList } from '@/components/shell/skeleton';
import { loginUrl, useSession } from '@/lib/api/session';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { workshopPath } from './model';
import { OpenInWebUi } from './shell';

export function WorkshopEntry() {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const session = useSession();
  const signedIn = session.data?.signed_in === true;
  const today = workshopPath(locale, 'today');

  useEffect(() => {
    if (signedIn) router.replace(today);
  }, [signedIn, router, today]);

  if (signedIn || session.data === undefined) return <SkeletonList count={2} label={t('provider.gate.checking')} />;
  return (
    <div className="pwa-ws-page pwa-ws-entry">
      <div className="pwa-ws-entry-mark" aria-hidden="true">
        <Icon name="wrench" size={40} />
      </div>
      <p className="pwa-text-caption m-0">{t('provider.entry.tagline')}</p>
      <h1 className="pwa-ws-title">{t('provider.entry.title')}</h1>
      <p className="m-0">{t('provider.entry.intro')}</p>
      <a href={loginUrl({ returnTo: today, locale })} className={buttonClass({ variant: 'primary', block: true })}>
        <span className="cp-btn-label">{t('provider.entry.signIn')}</span>
      </a>
      <p className="pwa-text-caption m-0">
        {t('provider.entry.newBusiness')}{' '}
        <a href={loginUrl({ returnTo: workshopPath(locale, 'start'), locale, screen: 'signup' })} className="pwa-link">
          {t('shell.header.signUp')}
        </a>
      </p>
      <Link href={`/${locale}`} className="pwa-link">
        {t('provider.entry.personal')}
      </Link>
    </div>
  );
}

const SOON: Record<'replies' | 'photos', { title: MessageKey; text: MessageKey; path: string }> = {
  replies: { title: 'provider.tabs.replies', text: 'provider.soon.replies', path: 'reviews' },
  photos: { title: 'provider.tabs.photos', text: 'provider.soon.photos', path: 'portfolio' },
};

/** A tab whose screens arrive in a later stage (PW5, PW7). */
export function WorkshopSoon({ tab }: { tab: keyof typeof SOON }) {
  const t = useT();
  const s = SOON[tab];
  return (
    <div className="pwa-ws-page">
      <h1 className="pwa-ws-title">{t(s.title)}</h1>
      <StateBlock
        kind="empty"
        title={t('provider.soon.title')}
        text={t(s.text)}
        action={
          <OpenInWebUi path={s.path} className={buttonClass({ variant: 'secondary' })}>
            <span className="cp-btn-label">{t('provider.menu.openWebUi')}</span>
          </OpenInWebUi>
        }
      />
    </div>
  );
}
