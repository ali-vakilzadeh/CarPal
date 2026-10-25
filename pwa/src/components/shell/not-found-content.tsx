// W-SYS-01 System pages — the 404 body, shared by app/global-not-found.tsx (unmatched URLs, server-rendered)
// and [locale]/not-found.tsx (notFound() from a page). P3.T8 adds 410, suspended, no access and maintenance.
import { typeClass } from '@/lib/design-system';
import { getTranslator } from '@/lib/i18n/dictionary';
import type { Locale } from '@/lib/i18n/locales';

export function NotFoundContent({ locale }: { locale: Locale }) {
  const t = getTranslator(locale);
  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-measure flex-col justify-center gap-4 px-4 py-6">
      <h1 className={`${typeClass(locale, 'title')} m-0`}>{t('common.notFound.title')}</h1>
      <p className={`${typeClass(locale, 'body')} m-0`}>{t('common.notFound.text')}</p>
      <div>
        <a href={`/${locale}`} className="cp-btn cp-btn-primary">
          <span className="cp-btn-label">{t('common.notFound.home')}</span>
        </a>
      </div>
    </main>
  );
}
