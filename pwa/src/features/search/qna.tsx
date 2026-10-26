'use client';
// The Q&A tab of W-SRCH-01 (DI-19): search.run's qna mode ranks providers, so this tab asks questions.search with the
// text and the car instead. Shown only while qna.enabled is on (the flag is off in the pilot seeds, DI-18); the
// question pages themselves are W-QA-02 (P8).
import type { SearchFilters } from '@carpal/api-contracts';
import { Badge } from '@/components/ds/badge';
import { StateView, stateFromProblem } from '@/components/shell/states';
import { SkeletonList } from '@/components/shell/skeleton';
import { useApiQuery } from '@/lib/api/query';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import { questionPath } from '@/lib/seo/urls';

export function QnaResults({ text, filters }: { text: string; filters: SearchFilters }) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const body = {
    ...(text.trim() ? { text: text.trim().slice(0, 200) } : {}),
    ...(filters.brand_node_id ? { brand_node_id: filters.brand_node_id } : {}),
    ...(filters.model_node_id ? { model_node_id: filters.model_node_id } : {}),
    limit: 20,
  };
  const q = useApiQuery('questions.search', { body }, { staleTime: 60_000 });
  if (q.isPending) return <SkeletonList count={3} label={t('common.loading')} />;
  if (q.isError) return <StateView kind={stateFromProblem(q.error)} t={t} compact />;
  if (!q.data.items.length) return <StateView kind="empty" t={t} title={t('search.qna.empty')} compact />;
  return (
    <ol className="pwa-plain-list pwa-results" aria-label={t('search.mode.qna')}>
      {q.data.items.map((item) => (
        <li key={item.id}>
          <article className="pwa-result pwa-question">
            <div className="pwa-result-body">
              <h3 className="pwa-text-label m-0">
                <a href={questionPath(locale, item)} className="pwa-card-link" dir="auto">
                  {item.title}
                </a>
              </h3>
              <span className="pwa-text-caption">
                {[item.vehicle.brand?.text, item.vehicle.model?.text, item.category?.text ?? item.symptom?.text]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              <span className="pwa-badges">
                <Badge icon="comment">{t('search.qna.answers', { count: item.answer_count })}</Badge>
                {item.accepted_answer_id ? (
                  <Badge tone="success" icon="check">
                    {t('search.qna.accepted')}
                  </Badge>
                ) : null}
                <span className="pwa-text-caption">{f.relative(item.created_at)}</span>
              </span>
            </div>
          </article>
        </li>
      ))}
    </ol>
  );
}
