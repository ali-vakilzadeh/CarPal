// Right rail of W-PUB-06 (≥ 1200 px): "Need hands-on help? Describe it in Help Me" (pre-filled with the question),
// Ask a question, and related questions (questions.search on the title's significant words, DI-50). Same cached reads
// as the page.
import Link from 'next/link';
import { RailBox, RightRail } from '@/components/shell/right-rail';
import { buttonClass } from '@/components/ds/button';
import { HelpMeCard } from '@/features/community';
import { I18nNamespaces } from '@/lib/i18n/client';
import { isLocale } from '@/lib/i18n/locales';
import { parseIdSlug, questionPath } from '@/lib/seo/urls';
import { loadQuestion, relatedQuestions } from '@/server/ssr/community';
import { pageContext } from '@/server/ssr/page-context';

export default async function QuestionRail({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  const parsed = parseIdSlug(id);
  if (!isLocale(locale) || !parsed) return null;
  const read = await loadQuestion(locale, parsed.id).catch(() => null);
  if (read?.state !== 'ok') return null;
  const q = read.data.question;
  const [ctx, related] = await Promise.all([pageContext(locale), relatedQuestions(locale, q)]);
  const { t } = ctx;
  return (
    <I18nNamespaces resources={ctx.i18n.resources(['community'])}>
      <RightRail>
        <HelpMeCard text={`${q.title}\n${q.body}`} rail />
        <RailBox title={t('community.qa.askTitle')}>
          <Link href={`/${locale}/questions/ask`} className={buttonClass({ variant: 'secondary', size: 'sm', block: true })}>
            <span className="cp-btn-label">{t('community.qa.ask')}</span>
          </Link>
        </RailBox>
        {related.length ? (
          <RailBox title={t('community.question.related')}>
            <ul className="pwa-plain-list pwa-stack-sm">
              {related.map((r) => (
                <li key={r.id}>
                  <Link href={questionPath(locale, r)} className="pwa-link" dir="auto">
                    {r.title}
                  </Link>
                  <span className="pwa-text-caption"> · {t('community.answer.count', { count: r.answer_count })}</span>
                </li>
              ))}
            </ul>
          </RailBox>
        ) : null}
      </RightRail>
    </I18nNamespaces>
  );
}
