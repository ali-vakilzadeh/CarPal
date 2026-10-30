// Frame of the full-screen flows without the app shell — the hosted sign-in (W-AUTH-01), link-token pages and the
// web onboarding (W-ONB-01): the word mark, optional language links and an end slot (e.g. "Finish later") in a thin
// header, and the content in a centred card (480 px for forms, 720 px for the onboarding stepper, Docs/22), or the
// full width without a card for Help Me (W-HELP-01: the step and the case rail, P10).
import type { ReactNode } from 'react';
import { cx } from '@/components/ds/cx';
import type { Translate } from '@/lib/i18n/keys';
import type { Locale } from '@/lib/i18n/locales';

export interface FlowFrameProps {
  t: Translate;
  /** Where the word mark goes. */
  home: string;
  /** Language links (full page loads; the hosted sign-in keeps its interaction in the URL). */
  languages?: { locale: Locale; href: string; current: boolean }[];
  end?: ReactNode;
  wide?: boolean;
  /** No card: the page lays out its own columns (Help Me). */
  full?: boolean;
  children: ReactNode;
}

export function FlowFrame({ t, home, languages, end, wide, full, children }: FlowFrameProps) {
  return (
    <div className="pwa-flow">
      <header className="pwa-flow-head">
        <a href={home} className="pwa-system-logo" aria-label={t('shell.header.home')}>
          <span className="pwa-wordmark-sm" lang="en" dir="ltr" aria-hidden="true">
            CarPal
          </span>
        </a>
        <div className="pwa-flow-end">
          {languages?.length ? (
            <nav aria-label={t('common.language.label')} className="pwa-flow-langs">
              {languages.map((l) => (
                <a
                  key={l.locale}
                  href={l.href}
                  hrefLang={l.locale}
                  lang={l.locale}
                  aria-current={l.current ? 'true' : undefined}
                  className={cx('cp-chip', l.current && 'is-selected')}
                >
                  <span>{t(`common.language.${l.locale}`)}</span>
                </a>
              ))}
            </nav>
          ) : null}
          {end}
        </div>
      </header>
      <main id="main" tabIndex={-1} className="pwa-flow-main">
        <div className={cx('pwa-flow-card', wide && 'is-wide', full && 'is-full')}>{children}</div>
      </main>
    </div>
  );
}
