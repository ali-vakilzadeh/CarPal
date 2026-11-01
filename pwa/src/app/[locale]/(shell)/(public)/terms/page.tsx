// /<locale>/terms: the CarPal User Agreement (P13.T7, OQ-15) from Docs/ (tools/sync-legal.mjs). Indexable, static per locale.
import type { Metadata } from 'next';
import { LegalPage, legalPath } from '@/features/legal/legal-page';
import { isLocale, type Locale } from '@/lib/i18n/locales';
import { serverEnv } from '@/server/env';
import { pageContext } from '@/server/ssr/page-context';
import { pageMetadata } from '@/server/ssr/seo/metadata';

type Props = { params: Promise<{ locale: string }> };

async function localeOf(params: Props['params']): Promise<Locale> {
  const { locale } = await params;
  return isLocale(locale) ? locale : 'fa';
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const locale = await localeOf(params);
  const ctx = await pageContext(locale);
  return pageMetadata({
    locale,
    path: legalPath(locale, 'terms'),
    title: ctx.t('shell.legal.terms'),
    description: ctx.t('shell.legal.termsDescription'),
    type: 'article',
    siteName: ctx.siteName,
  });
}

export default async function TermsPage({ params }: Props) {
  const locale = await localeOf(params);
  const { t } = await pageContext(locale);
  const env = serverEnv();
  return (
    <LegalPage
      kind="terms"
      locale={locale}
      t={t}
      fill={{ supportEmail: env.CARPAL_PWA_SUPPORT_EMAIL, domain: new URL(env.CARPAL_PWA_ORIGIN).host }}
    />
  );
}
