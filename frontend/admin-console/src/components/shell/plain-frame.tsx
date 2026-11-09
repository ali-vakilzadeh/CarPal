'use client';
// The frame of pages outside the console shell (AC4): the sign-in pages (/id/…), the signed-out page and the system
// pages that render in the root layout. Wordmark, the always-visible environment badge (GD-06), optional language
// links, and the main area. Client component so the error boundary can use it too.
import type { ReactNode } from 'react';
import { useT } from '@/lib/i18n/client';
import type { Locale } from '@/lib/i18n/locales';
import { EnvBadge } from './env-badge';
import { useAdminEnv } from './providers';

export interface LanguageLink {
  locale: Locale;
  href: string;
  current: boolean;
}

export function PlainFrame({ children, languages, narrow }: { children: ReactNode; languages?: LanguageLink[]; narrow?: boolean }) {
  const t = useT();
  const env = useAdminEnv();
  return (
    <>
      <header className="adm-frame-bar">
        <span className="adm-wordmark">{t('admin.console.name')}</span>
        <div className="adm-frame-end">
          {languages ? (
            <nav aria-label={t('common.language.label')}>
              <ul className="adm-frame-langs">
                {languages.map((l) => (
                  <li key={l.locale}>
                    <a href={l.href} lang={l.locale} aria-current={l.current ? 'true' : undefined}>
                      {t(`common.language.${l.locale}`)}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}
          <EnvBadge env={env} t={t} />
        </div>
      </header>
      <main id="main" className={narrow ? 'adm-frame-main adm-frame-narrow' : 'adm-frame-main'} tabIndex={-1}>
        {children}
      </main>
    </>
  );
}
