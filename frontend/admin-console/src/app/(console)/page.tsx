// Placeholder console home (AC1.T5). Checks the foundation only: language and direction, the three themes, the
// environment badge and the generated admin contract. AC4 puts the sign-in gate and the shell in front of it; AC5
// replaces it with "My work".
import type { Metadata } from 'next';
import { ADMIN_CONTRACT, STAFF_ROLES } from '@/lib/api/generated';
import { formatNumber } from '@/lib/format';
import { getTranslator } from '@/lib/i18n/dictionary';
import { LOCALES, type Locale } from '@/lib/i18n/locales';
import { THEME_CHOICES } from '@/lib/theme';
import { requestLocale, requestTheme } from '@/server/request-locale';

export async function generateMetadata(): Promise<Metadata> {
  return { title: getTranslator(await requestLocale())('admin.console.placeholderTitle') };
}

const LANGUAGE_TAG: Record<Locale, string> = { fa: 'fa', en: 'en' };

export default async function ConsoleHome() {
  const [locale, theme] = await Promise.all([requestLocale(), requestTheme()]);
  const t = getTranslator(locale);
  const operations = ADMIN_CONTRACT.adminOperationCount + ADMIN_CONTRACT.apiReadCount;

  return (
    <div className="adm-placeholder">
      <h1 className="adm-page-title">{t('admin.console.placeholderTitle')}</h1>
      <p className="adm-measure">{t('admin.console.placeholderText')}</p>
      <ul className="adm-facts">
        <li data-testid="contract-line">
          {t('admin.console.contractLine', { version: ADMIN_CONTRACT.version, n: formatNumber(operations, locale) })}
        </li>
        {/* Role codes and contract versions stay in Latin letters (GD-05: IDs and codes may use Latin digits). */}
        <li>{t('admin.console.rolesLine', { roles: Object.keys(STAFF_ROLES).join(' · ') })}</li>
      </ul>

      <nav className="adm-prefs" aria-label={t('admin.prefs.language')}>
        <h2 className="adm-prefs-title">{t('admin.prefs.language')}</h2>
        <ul>
          {LOCALES.map((l) => (
            <li key={l}>
              <a href={`?lang=${l}`} lang={LANGUAGE_TAG[l]} aria-current={l === locale ? 'true' : undefined}>
                {t(`common.language.${l}`)}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <nav className="adm-prefs" aria-label={t('admin.prefs.theme')}>
        <h2 className="adm-prefs-title">{t('admin.prefs.theme')}</h2>
        <ul>
          {THEME_CHOICES.map((c) => (
            <li key={c}>
              <a href={`?theme=${c}`} aria-current={c === theme.choice ? 'true' : undefined}>
                {t(`common.theme.${c}`)}
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
