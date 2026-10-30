'use client';
// The app shell frame (Docs/22 §2): header; then the left navigation (signed in, ≥ 768 px), the main column and the
// right rail (≥ 1200 px); the footer; the bottom tab bar (signed in, < 768 px); the vehicle selector, the cookie
// banner and the report modal (W-RPT-01, P8). Guest vs signed-in follows the BFF session (server-seeded, confirmed by
// the browser — a cross-site arrival carries no SameSite=Strict cookie, so the server may render the guest variant
// first, P2 notes).
import type { ReactNode } from 'react';
import { cx } from '@/components/ds/cx';
import { useSession } from '@/lib/api/session';
import { useLocale, useT } from '@/lib/i18n/client';
import { COOKIE_MODAL, CookieConsent } from './cookie-consent';
import { BottomTabs, LeftNav } from './navigation';
import { LanguageSwitch, ThemePicker } from './preferences';
import { ReportHost } from './report';
import { useUrlModal } from './url-modal';
import { VehicleSelectModal } from './vehicle-context';
import { SiteHeader } from './site-header';

function SiteFooter() {
  const t = useT();
  const locale = useLocale();
  const cookies = useUrlModal(COOKIE_MODAL);
  return (
    <footer className="pwa-footer">
      <nav aria-label={t('shell.footer.label')} className="pwa-footer-nav">
        <a className="pwa-link" href={`/${locale}/how-ranking-works`}>
          {t('shell.footer.ranking')}
        </a>
        <button type="button" className="pwa-link" onClick={() => cookies.open()}>
          {t('shell.footer.cookies')}
        </button>
        <LanguageSwitch />
      </nav>
      <div className="pwa-footer-nav">
        <ThemePicker className="pwa-footer-theme" />
      </div>
    </footer>
  );
}

export function ShellFrame({ children, rail }: { children: ReactNode; rail?: ReactNode }) {
  const session = useSession();
  const signedIn = session.data?.signed_in === true;
  return (
    <div className={cx('pwa-shell', signedIn ? 'is-signed-in' : 'is-guest')}>
      <SiteHeader />
      <div className="pwa-columns">
        {signedIn ? <LeftNav /> : null}
        <main id="main" tabIndex={-1} className="pwa-main">
          {children}
        </main>
        {rail}
      </div>
      <SiteFooter />
      {signedIn ? (
        <>
          <BottomTabs />
          <VehicleSelectModal />
        </>
      ) : null}
      <CookieConsent />
      <ReportHost />
    </div>
  );
}
