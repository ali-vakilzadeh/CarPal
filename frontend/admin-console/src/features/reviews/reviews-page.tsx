'use client';
// Reviews (AC7, Docs/23 A-REV-01): two queues in tabs, each shown only to the roles that may read it — "Awaiting
// approval" (Path 2 reviews; community reviewers decide, moderators see it) and "Review cases" (reported, AI-flagged
// and system-rule cases on reviews; moderators and platform admins). Reviews the business objected to are decided on
// Disputes & appeals; the tab bar links there. The tab lives in the URL (?tab=approvals|cases).
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useSession } from '@/lib/api/query';
import { useT } from '@/lib/i18n/client';
import { canCall } from '@/lib/roles';
import { ApprovalQueue } from './approval-queue';
import { ReviewCases } from './review-cases';

export type ReviewsTab = 'approvals' | 'cases';

export function ReviewsPage() {
  const t = useT();
  const session = useSession();
  const roles = session.data?.staff?.roles ?? [];
  const params = useSearchParams();
  const tabs: ReviewsTab[] = [];
  if (canCall('admin.review_approvals_queue', roles)) tabs.push('approvals');
  if (canCall('admin.cases_list', roles)) tabs.push('cases');
  const asked = params.get('tab');
  const tab: ReviewsTab | undefined = tabs.find((x) => x === asked) ?? tabs[0];
  const disputes = canCall('admin.disputes_queue', roles);

  return (
    <div className="adm-page" data-testid="reviews-page">
      <h1 className="adm-page-title">{t('admin.reviews.title')}</h1>
      <p className="adm-measure">{t(tab === 'cases' ? 'admin.cases.intro' : 'admin.reviews.intro')}</p>
      <nav className="adm-tabs" aria-label={t('admin.reviews.tabsLabel')}>
        {tabs.map((x) => (
          <Link key={x} href={`/reviews?tab=${x}`} aria-current={x === tab ? 'page' : undefined} className="adm-tab">
            {t(`admin.reviews.tab.${x}`)}
          </Link>
        ))}
        {disputes ? (
          <Link href="/disputes?type=review_approval_objection" className="adm-tab">
            {t('admin.reviews.tab.disputed')}
          </Link>
        ) : null}
      </nav>
      {tab === 'approvals' ? <ApprovalQueue key="approvals" /> : tab === 'cases' ? <ReviewCases key="cases" /> : null}
    </div>
  );
}
