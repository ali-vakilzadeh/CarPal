// W-SET-01 Settings — P9 builds the account settings; until then the GD-13 "not available yet" state. From P4 the
// "On this device" section holds the per-browser price display (OQ-11).
import type { Metadata } from 'next';
import { StateView } from '@/components/shell/states';
import { PriceDisplaySettings } from '@/features/settings';
import { typeClass } from '@/lib/design-system';
import { I18nNamespaces } from '@/lib/i18n/client';
import { isLocale, type Locale } from '@/lib/i18n/locales';
import { serverI18n } from '@/server/i18n';

type Props = { params: Promise<{ locale: string }> };

async function localeOf(params: Props['params']): Promise<Locale> {
  const { locale } = await params;
  return isLocale(locale) ? locale : 'fa';
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { t } = await serverI18n(await localeOf(params));
  return { title: t('shell.nav.settings'), robots: { index: false } };
}

export default async function Page({ params }: Props) {
  const locale = await localeOf(params);
  const i18n = await serverI18n(locale);
  const t = i18n.t;
  return (
    <div className="flex flex-col gap-6 py-6">
      <h1 className={`${typeClass(locale, 'title')} m-0`}>{t('shell.nav.settings')}</h1>
      <section className="flex flex-col gap-3" aria-labelledby="settings-local">
        <div className="flex flex-col gap-1">
          <h2 id="settings-local" className={`${typeClass(locale, 'headline')} m-0`}>
            {t('settings.local.title')}
          </h2>
          <p className="pwa-text-caption">{t('settings.local.text')}</p>
        </div>
        <I18nNamespaces resources={i18n.resources(['settings'])}>
          <PriceDisplaySettings />
        </I18nNamespaces>
      </section>
      <StateView kind="notAvailable" t={t} title={t('settings.comingSoon')} compact />
    </div>
  );
}
