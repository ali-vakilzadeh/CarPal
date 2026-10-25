// W-PUB-01 Landing Page — P1 placeholder inside the P3 shell (the real landing page is P5.T2). Mirrors the mobile
// welcome screen (mobile/preview S-AUTH-01): hero mark, promise and the three trust points.
import type { Metadata } from 'next';
import { Icon, type IconName } from '@/components/ds/icon';
import { typeClass } from '@/lib/design-system';
import type { MessageKey } from '@/lib/i18n/keys';
import { LOCALES, isLocale, type Locale } from '@/lib/i18n/locales';
import { serverI18n } from '@/server/i18n';

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
  const { t } = await serverI18n(locale);
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
  const { t } = await serverI18n(locale);

  return (
    <div className="mx-auto flex max-w-measure flex-col gap-8 py-6">
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
    </div>
  );
}
