// W-PUB-01 Landing Page — P1 placeholder (the real landing page is P5.T2). Mirrors the mobile welcome screen
// (mobile/preview S-AUTH-01): hero mark, word mark, promise and the three trust points, plus language and theme links.
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { Icon, type IconName } from '@/components/ds/icon';
import { LanguageLink, ThemeLinks } from '@/components/shell/preference-links';
import { typeClass } from '@/lib/design-system';
import { getTranslator, type MessageKey } from '@/lib/i18n/dictionary';
import { LOCALES, isLocale, type Locale } from '@/lib/i18n/locales';
import { THEME_COOKIE, themeOrDefault } from '@/lib/theme';

type Props = { params: Promise<{ locale: string }> };

const VALUES: { icon: IconName; key: MessageKey }[] = [
  { icon: 'wrench', key: 'common.home.valueRanked' },
  { icon: 'shield', key: 'common.home.valueReviews' },
  { icon: 'doc', key: 'common.home.valueHistory' },
];

async function localeOf(params: Props['params']): Promise<Locale> {
  const { locale } = await params;
  return isLocale(locale) ? locale : 'fa';
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const locale = await localeOf(params);
  const t = getTranslator(locale);
  return {
    title: { absolute: t('common.home.metaTitle') },
    description: t('common.home.metaDescription'),
    alternates: {
      canonical: `/${locale}`,
      languages: { ...Object.fromEntries(LOCALES.map((l) => [l, `/${l}`])), 'x-default': '/fa' },
    },
  };
}

export default async function HomePage({ params }: Props) {
  const locale = await localeOf(params);
  const t = getTranslator(locale);
  const theme = themeOrDefault((await cookies()).get(THEME_COOKIE)?.value);

  return (
    <div className="mx-auto flex min-h-dvh max-w-measure flex-col gap-8 px-4 py-6">
      <header className="flex items-center justify-between gap-4">
        <span className="pwa-wordmark" lang="en" dir="ltr">
          CarPal
        </span>
        <LanguageLink locale={locale} />
      </header>

      <main id="main" className="flex flex-col gap-8">
        <section className="flex flex-col items-center gap-4 py-8 text-center">
          <span className="pwa-hero-mark" aria-hidden="true">
            <Icon name="car" size={48} />
          </span>
          <h1 className={`${typeClass(locale, 'headline')} m-0`}>{t('common.home.headline')}</h1>
        </section>

        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {VALUES.map(({ icon, key }) => (
            <li key={key} className="flex items-center gap-3">
              <span className="pwa-tile">
                <Icon name={icon} size={20} />
              </span>
              <span className={typeClass(locale, 'body')}>{t(key)}</span>
            </li>
          ))}
        </ul>

        <p className={`${typeClass(locale, 'body')} text-ink-muted m-0`}>{t('common.home.comingSoon')}</p>
      </main>

      <footer className="mt-auto">
        <ThemeLinks locale={locale} current={theme} />
      </footer>
    </div>
  );
}
