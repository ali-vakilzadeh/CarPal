'use client';
// Language switch (keeps the current page, Docs/22 principle 8) and theme picker (automatic / Daylight / Sunlight /
// Night, P3.T3) used by the header, the account menu, the guest menu and the footer. Both are plain links, so they
// work before hydration and without JavaScript (the proxy stores ?theme=… and redirects); once hydrated, the theme
// links switch at once without a navigation.
import { usePathname, useSearchParams } from 'next/navigation';
import { buttonClass } from '@/components/ds/button';
import { cx } from '@/components/ds/cx';
import { Icon, type IconName } from '@/components/ds/icon';
import { useLocale, useT } from '@/lib/i18n/client';
import { LOCALES, type Locale } from '@/lib/i18n/locales';
import { THEME_CHOICES, type ThemeChoice } from '@/lib/theme';
import { switchLocalePath } from './nav-items';
import { useTheme } from './theme-controller';

export function LanguageSwitch({ className, variant = 'ghost' }: { className?: string; variant?: 'ghost' | 'secondary' }) {
  const locale = useLocale();
  const t = useT();
  const pathname = usePathname();
  const search = useSearchParams();
  const other: Locale = LOCALES.find((l) => l !== locale) ?? locale;
  return (
    // A full page load: the root layout (lang, dir, fonts, dictionaries) changes with the language.
    <a
      href={switchLocalePath(pathname, search.toString(), other)}
      hrefLang={other}
      lang={other}
      className={buttonClass({ variant, size: 'sm', className })}
      data-testid="language-switch"
    >
      <Icon name="globe" size={20} />
      <span className="cp-btn-label">{t(`common.language.${other}`)}</span>
    </a>
  );
}

const THEME_ICON: Record<ThemeChoice, IconName> = { auto: 'sliders', light: 'sun', sun: 'eye', dark: 'moon' };

/** The current page with ?theme=<choice> (the proxy's no-JavaScript switch). */
export function themeHref(pathname: string, search: string, choice: ThemeChoice): string {
  const params = new URLSearchParams(search);
  params.set('theme', choice);
  return `${pathname}?${params.toString()}`;
}

export function ThemePicker({ className }: { className?: string }) {
  const t = useT();
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const { choice, setChoice } = useTheme();
  return (
    <div role="group" aria-label={t('common.theme.label')} className={cx('pwa-theme-picker', className)}>
      <span className="pwa-menu-heading" aria-hidden="true">
        {t('common.theme.label')}
      </span>
      <div className="pwa-theme-options">
        {THEME_CHOICES.map((c) => {
          const selected = choice === c;
          return (
            <a
              key={c}
              href={themeHref(pathname, search, c)}
              className={cx('cp-chip', selected && 'is-selected')}
              aria-current={selected ? 'true' : undefined}
              onClick={(e) => {
                e.preventDefault();
                setChoice(c);
              }}
            >
              <Icon name={selected ? 'check' : THEME_ICON[c]} size={18} />
              <span>{t(c === 'auto' ? 'common.theme.auto' : `common.theme.${c}`)}</span>
            </a>
          );
        })}
      </div>
    </div>
  );
}
