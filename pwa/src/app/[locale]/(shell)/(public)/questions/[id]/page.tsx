// W-PUB-06 Question Page (mirrors C-COMM-05; P8.T3) at /<locale>/questions/<id>-<slug>: server-rendered from the public
// read (questions.get through cp-ssr), so search engines and guests see the question and its answers; the interactive
// thread (QuestionThread) takes over in the browser. Indexed with QAPage JSON-LD only once answered (an accepted
// answer, isIndexable; OQ-20), otherwise noindex. A wrong slug moves permanently to the canonical URL; a missing or
// held question is a 404 (only its author can read a held question, through the BFF); qna.enabled off → the
// "not available right now" state with noindex. The right rail (@rail) holds Help Me, Ask and related questions; on
// smaller screens the Help Me card follows the thread.
import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { StateView } from '@/components/shell/states';
import { HelpMeCard, QuestionThread, excerpt, isIndexable } from '@/features/community';
import { I18nNamespaces } from '@/lib/i18n/client';
import { isLocale, type Locale } from '@/lib/i18n/locales';
import { parseIdSlug, questionPath, slugify } from '@/lib/seo/urls';
import { loadQuestion, type QuestionRead } from '@/server/ssr/community';
import { pageContext } from '@/server/ssr/page-context';
import { JsonLd } from '@/server/ssr/seo/json-ld';
import { pageMetadata, unavailableMetadata } from '@/server/ssr/seo/metadata';
import { qaPage } from '@/server/ssr/seo/schema';

type Props = { params: Promise<{ locale: string; id: string }> };

async function load(params: Props['params']): Promise<{ locale: Locale; read: QuestionRead }> {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const parsed = parseIdSlug(id);
  if (!parsed) notFound();
  const read = await loadQuestion(locale, parsed.id);
  if (read.state === 'missing') notFound();
  if (read.state === 'ok') {
    const q = read.data.question;
    if (slugify(parsed.slug) !== slugify(q.title)) permanentRedirect(questionPath(locale, q));
  }
  return { locale, read };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, read } = await load(params);
  const ctx = await pageContext(locale);
  if (read.state !== 'ok') return unavailableMetadata(ctx.t('community.qa.title'));
  const q = read.data.question;
  return pageMetadata({
    locale,
    path: questionPath(locale, q),
    title: ctx.t('community.meta.questionTitle', { title: q.title }),
    description: excerpt(q.body, 160),
    type: 'article',
    noindex: !isIndexable(q),
    siteName: ctx.siteName,
  });
}

export default async function QuestionPage({ params }: Props) {
  const { locale, read } = await load(params);
  const ctx = await pageContext(locale);
  const { t } = ctx;
  if (read.state !== 'ok')
    return (
      <div className="py-6">
        <StateView kind="featureOff" t={t} title={t('community.qa.off')} />
      </div>
    );
  const { question, answers } = read.data;
  const path = questionPath(locale, question);
  return (
    <I18nNamespaces resources={ctx.i18n.resources(['community', 'media'])}>
      {isIndexable(question) ? <JsonLd data={qaPage(question, answers.items, `${ctx.origin}${path}`)} /> : null}
      <div className="pwa-community-page">
        <QuestionThread initial={read.data} />
        <div className="pwa-rail-inline">
          <HelpMeCard text={`${question.title}\n${question.body}`} />
        </div>
      </div>
    </I18nNamespaces>
  );
}
