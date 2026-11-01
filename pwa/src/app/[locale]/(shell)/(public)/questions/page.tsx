// W-QA-01 Community Q&A hub (mirrors C-COMM-03; P8.T3) at /<locale>/questions[?status&cat&brand&model]: the first page
// of questions.search for the URL's filters is rendered on the server, the client hub (QaHub) adds search text, My car
// and paging. The hub without filters is indexable (canonical without filters). P13.T10: a view about one topic — one
// category, or one brand (and model) — is a page of its own: title and heading name the topic, the canonical URL keeps
// its filter, and it is indexed when its first page holds enough answered questions (qaTopicIndexable); it is listed
// in /sitemaps/questions.xml. Other filtered views are noindex. qna.enabled off → the "not available right now" state
// with noindex (GD-13).
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { QaHub, parseQaFilters, qaFilterQuery, qaSearchBody, qaTopicIndexable, qaTopicOf, type QaFilters } from '@/features/community';
import { I18nNamespaces } from '@/lib/i18n/client';
import { isLocale, type Locale } from '@/lib/i18n/locales';
import { pageContext } from '@/server/ssr/page-context';
import { publicList } from '@/server/ssr/public-reads';
import { qaTopicName } from '@/server/ssr/qa-topics';
import { pageMetadata } from '@/server/ssr/seo/metadata';

type Props = { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

async function localeOf(params: Props['params']): Promise<Locale> {
  const { locale } = await params;
  return isLocale(locale) ? locale : 'fa';
}

/** The first page for the filters (cached public read, shared by the metadata and the page). */
const firstPage = (locale: Locale, filters: QaFilters) => publicList(locale, 'questions.search', { body: qaSearchBody(filters, '', null) });

/** The topic of a one-topic view with its name, or null. */
async function topicOf(locale: Locale, filters: QaFilters) {
  const topic = qaTopicOf(filters);
  const name = topic ? await qaTopicName(locale, topic) : null;
  return topic && name ? { topic, name } : null;
}

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const locale = await localeOf(params);
  const ctx = await pageContext(locale);
  const filters = parseQaFilters(await searchParams);
  const query = qaFilterQuery(filters);
  const enabled = !!ctx.flags['qna.enabled'];
  const topic = enabled && query ? await topicOf(locale, filters) : null;
  if (topic) {
    const page = await firstPage(locale, filters);
    return pageMetadata({
      locale,
      path: `/${locale}/questions?${query}`,
      title: ctx.t('community.meta.topicTitle', { topic: topic.name }),
      description: ctx.t('community.meta.topicDescription', { topic: topic.name }),
      noindex: !page || !qaTopicIndexable(page.items),
      siteName: ctx.siteName,
    });
  }
  return pageMetadata({
    locale,
    path: `/${locale}/questions`,
    title: ctx.t('community.meta.hubTitle'),
    description: ctx.t('community.meta.hubDescription'),
    noindex: query !== '' || !enabled,
    siteName: ctx.siteName,
  });
}

export default async function QuestionsPage({ params, searchParams }: Props) {
  const locale = await localeOf(params);
  const ctx = await pageContext(locale);
  const filters = parseQaFilters(await searchParams);
  const enabled = !!ctx.flags['qna.enabled'];
  const [initial, topic] = enabled ? await Promise.all([firstPage(locale, filters), topicOf(locale, filters)]) : [null, null];
  return (
    <I18nNamespaces resources={ctx.i18n.resources(['community'])}>
      <Suspense>
        <QaHub initial={initial} initialFilters={filters} topicName={topic?.name ?? null} />
      </Suspense>
    </I18nNamespaces>
  );
}
