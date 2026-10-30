// W-ME-01 Inquiry detail (P9.T5) at /<locale>/activity/inquiries/<id>, signed in (private); also the destination of
// "Stock inquiry answered" notifications (Docs/21 §6).
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { InquiryDetail } from '@/features/activity';
import { I18nNamespaces } from '@/lib/i18n/client';
import { isLocale, type Locale } from '@/lib/i18n/locales';
import { serverI18n } from '@/server/i18n';

type Props = { params: Promise<{ locale: string; id: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function localeOf(params: Props['params']): Promise<Locale> {
  const { locale } = await params;
  return isLocale(locale) ? locale : 'fa';
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { t } = await serverI18n(await localeOf(params));
  return { title: t('activity.inquiry.title'), robots: { index: false, follow: false } };
}

export default async function Page({ params }: Props) {
  const [locale, { id }] = await Promise.all([localeOf(params), params]);
  if (!UUID.test(id)) notFound();
  const i18n = await serverI18n(locale);
  return (
    <I18nNamespaces resources={i18n.resources(['activity', 'settings'])}>
      <InquiryDetail inquiryId={id.toLowerCase()} />
    </I18nNamespaces>
  );
}
