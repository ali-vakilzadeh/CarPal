// W-QA-01 Community Q&A hub (mirrors C-COMM-03; P8.T3) at /<locale>/questions[?status&cat&brand&model]: the first page
// of questions.search for the URL's filters is rendered on the server (indexable, canonical without filters; filtered
// views are noindex), the client hub (QaHub) adds search text, My car and paging. qna.enabled off → the
// "not available right now" state with noindex (GD-13).
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { QaHub, parseQaFilters, qaFilterQuery, qaSearchBody } from '@/features/community';
import { I18nNamespaces } from '@/lib/i18n/client';
import { isLocale, type Locale } from '@/lib/i18n/locales';
import { pageContext } from '@/server/ssr/page-context';
import { publicList } from '@/server/ssr/public-reads';
import { pageMetadata } from '@/server/ssr/seo/metadata';

type Props = { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

async function localeOf(params: Props['params']): Promise<Locale> {
  const { locale } = await params;
  return isLocale(locale) ? locale : 'fa';
}

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const locale = await localeOf(params);
  const ctx = await pageContext(locale);
  const filtered = qaFilterQuery(parseQaFilters(await searchParams)) !== '';
  return pageMetadata({
    locale,
    path: `/${locale}/questions`,
    title: ctx.t('community.meta.hubTitle'),
    description: ctx.t('community.meta.hubDescription'),
    noindex: filtered || !ctx.flags['qna.enabled'],
    siteName: ctx.siteName,
  });
}

export default async function QuestionsPage({ params, searchParams }: Props) {
  const locale = await localeOf(params);
  const ctx = await pageContext(locale);
  const filters = parseQaFilters(await searchParams);
  const initial = ctx.flags['qna.enabled'] ? await publicList(locale, 'questions.search', { body: qaSearchBody(filters, '', null) }) : null;
  return (
    <I18nNamespaces resources={ctx.i18n.resources(['community'])}>
      <Suspense>
        <QaHub initial={initial} initialFilters={filters} />
      </Suspense>
    </I18nNamespaces>
  );
}
