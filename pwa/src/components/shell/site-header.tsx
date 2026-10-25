'use client';
// Global header (Docs/22 §2.2): logo, search box with the '/' shortcut, Help Me, and — guest — language switch with
// Log in / Sign up, or — signed in — the notifications bell and the avatar menu (language lives there). On phones
// the search box moves to a second row; guests get a menu button, signed-in users the bottom tab bar instead.
import Link from 'next/link';
import { buttonClass } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { useSession } from '@/lib/api/session';
import { useLocale, useT } from '@/lib/i18n/client';
import { AccountMenu, NotificationsBell } from './header-menus';
import { GuestMenu } from './navigation';
import { LanguageSwitch } from './preferences';
import { SearchBox } from './search-box';
import { useLoginHref } from './use-login-href';
import { VehicleChip } from './vehicle-context';

export function SiteHeader() {
  const t = useT();
  const locale = useLocale();
  const session = useSession();
  const user = session.data?.signed_in ? session.data.user : null;
  const loginHref = useLoginHref();
  const signupHref = useLoginHref('signup');

  return (
    <header className="pwa-header">
      <div className="pwa-header-row">
        <Link href={user ? `/${locale}/home` : `/${locale}`} className="pwa-header-logo" aria-label={t('shell.header.home')}>
          <span className="pwa-wordmark-sm" lang="en" dir="ltr" aria-hidden="true">
            CarPal
          </span>
        </Link>
        <SearchBox className="pwa-header-search" vehicleChip={user ? <VehicleChip /> : null} />
        <div className="pwa-header-actions">
          <Link
            href={`/${locale}/help`}
            className={buttonClass({ variant: user ? 'primary' : 'secondary', size: 'sm', className: 'pwa-help-button' })}
          >
            <Icon name="wrench" size={20} />
            <span className="cp-btn-label">{t('shell.header.helpMe')}</span>
          </Link>
          {user ? (
            <>
              <NotificationsBell />
              <AccountMenu user={user} />
            </>
          ) : (
            <>
              <LanguageSwitch className="pwa-wide-only" />
              <a href={loginHref} className={buttonClass({ variant: 'ghost', size: 'sm', className: 'pwa-wide-only' })}>
                <span className="cp-btn-label">{t('shell.header.logIn')}</span>
              </a>
              <a href={signupHref} className={buttonClass({ size: 'sm', className: 'pwa-wide-only' })}>
                <span className="cp-btn-label">{t('shell.header.signUp')}</span>
              </a>
              <GuestMenu />
            </>
          )}
        </div>
      </div>
    </header>
  );
}
