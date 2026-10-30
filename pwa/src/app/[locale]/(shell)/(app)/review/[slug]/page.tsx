// W-REV-01 Write Review (mirrors C-REV-01/02) and W-REV-03 Write Vendor Review (C-REV-04; P11.T1/T3) at
// /<locale>/review/<slug>[?as=vendor&appointment|inquiry|record=<id>&invite=1&edit=<review id>]: signed in, private
// (no-store, noindex). The emailed invitation (/l/ri) arrives here with ?invite=1 and its grant in the tab.
import type { Metadata } from 'next';
import { ReviewPage, parseReviewQuery } from '@/features/reviews';
import { I18nNamespaces } from '@/lib/i18n/client';
import { isLocale, type Locale } from '@/lib/i18n/locales';
import { serverI18n } from '@/server/i18n';

type Props = {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

async function localeOf(params: Props['params']): Promise<Locale> {
  const { locale } = await params;
  return isLocale(locale) ? locale : 'fa';
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { t } = await serverI18n(await localeOf(params));
  return { title: t('reviews.form.heading'), robots: { index: false, follow: false } };
}

export default async function Page({ params, searchParams }: Props) {
  const [{ slug }, query, i18n] = await Promise.all([params, searchParams, serverI18n(await localeOf(params))]);
  return (
    <I18nNamespaces resources={i18n.resources(['reviews', 'profiles', 'media'])}>
      <ReviewPage slug={decodeURIComponent(slug)} query={parseReviewQuery(query)} />
    </I18nNamespaces>
  );
}
