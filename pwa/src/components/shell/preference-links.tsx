// Language and theme links that work without JavaScript (P1). The proxy stores ?theme= in a cookie; the language
// link opens the same page in the other locale. P3.T4 replaces them with the header's language switch and
// Settings → Language & region.
import { Icon } from '@/components/ds/icon';
import { getTranslator } from '@/lib/i18n/dictionary';
import type { Locale } from '@/lib/i18n/locales';
import { THEMES, type Theme } from '@/lib/theme';

export function LanguageLink({ locale, path = '' }: { locale: Locale; path?: string }) {
  const other: Locale = locale === 'fa' ? 'en' : 'fa';
  const t = getTranslator(locale);
  return (
    <a href={`/${other}${path}`} hrefLang={other} lang={other} className="cp-btn cp-btn-ghost cp-btn-sm">
      <Icon name="globe" size={20} />
      <span className="cp-btn-label">{t(`common.language.${other}`)}</span>
    </a>
  );
}

export function ThemeLinks({ locale, current, path = '' }: { locale: Locale; current: Theme; path?: string }) {
  const t = getTranslator(locale);
  return (
    <nav aria-label={t('common.theme.label')} className="flex flex-wrap gap-2">
      {THEMES.map((theme) => {
        const selected = theme === current;
        return (
          <a
            key={theme}
            href={`/${locale}${path}?theme=${theme}`}
            className={selected ? 'cp-chip is-selected' : 'cp-chip'}
            aria-current={selected ? 'true' : undefined}
          >
            {selected ? <Icon name="check" size={18} /> : null}
            <span>{t(`common.theme.${theme}`)}</span>
          </a>
        );
      })}
    </nav>
  );
}
