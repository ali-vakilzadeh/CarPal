// W-SRCH-01 Search results — placeholder until P6 (P3 shell destination; GD-13 "not available yet").
import type { Metadata } from 'next';
import { ComingSoon } from '@/components/shell/coming-soon';
import { isLocale, type Locale } from '@/lib/i18n/locales';
import { serverI18n } from '@/server/i18n';

type Props = { params: Promise<{ locale: string }> };

async function localeOf(params: Props['params']): Promise<Locale> {
  const { locale } = await params;
  return isLocale(locale) ? locale : 'fa';
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { t } = await serverI18n(await localeOf(params));
  return { title: t('shell.nav.discover'), robots: { index: false } };
}

export default async function Page({ params }: Props) {
  const locale = await localeOf(params);
  const { t } = await serverI18n(locale);
  return <ComingSoon locale={locale} t={t} title="shell.nav.discover" />;
}
