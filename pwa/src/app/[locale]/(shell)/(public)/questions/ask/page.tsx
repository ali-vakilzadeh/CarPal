// W-QA-02 Ask a question (mirrors C-COMM-04; P8.T4) at /<locale>/questions/ask: the form (AskForm) for everyone —
// guests write first and sign in at Post (GD-06). Never indexed.
import type { Metadata } from 'next';
import { AskForm } from '@/features/community';
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
  return { title: t('community.ask.heading'), robots: { index: false, follow: false } };
}

export default async function AskPage({ params }: Props) {
  const i18n = await serverI18n(await localeOf(params));
  return (
    <I18nNamespaces resources={i18n.resources(['community', 'media'])}>
      <AskForm />
    </I18nNamespaces>
  );
}
