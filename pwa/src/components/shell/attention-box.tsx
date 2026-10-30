'use client';
// "Needs your attention" (Docs/22 §2.4 right rail, BA-04): for signed-in users, ownership requests waiting for their
// decision (someone says they bought a car in their garage) and open review invitations (P11). Links to the garage,
// where the Ownership requests block has Accept / Reject, and to My Activity Reviews. Renders no rail at all when
// nothing needs attention.
import Link from 'next/link';
import { buttonClass } from '@/components/ds/button';
import { useApiQuery } from '@/lib/api/query';
import { useLocale, useT } from '@/lib/i18n/client';
import { RailBox, RightRail } from './right-rail';

export function AttentionRail() {
  const t = useT();
  const locale = useLocale();
  const transfers = useApiQuery(
    'vehicles.transfers_list',
    { query: { direction: 'incoming', status: 'pending', limit: 20 } },
    { staleTime: 60_000 },
  );
  const invitations = useApiQuery('review_invitations.mine_list', { query: { limit: 20 } }, { staleTime: 60_000 });
  const count = transfers.data?.items.length ?? 0;
  const reviews = invitations.data?.items.length ?? 0;
  if (count === 0 && reviews === 0) return null;
  return (
    <RightRail>
      <RailBox title={t('shell.attention.title')}>
        {count ? (
          <>
            <p className="pwa-text-caption">{t('shell.attention.transfers', { count })}</p>
            <Link href={`/${locale}/garage`} className={buttonClass({ variant: 'secondary', size: 'sm', block: true })}>
              <span className="cp-btn-label">{t('shell.attention.review')}</span>
            </Link>
          </>
        ) : null}
        {reviews ? (
          <>
            <p className="pwa-text-caption">{t('shell.attention.reviewInvitations', { count: reviews })}</p>
            <Link href={`/${locale}/activity?tab=reviews`} className={buttonClass({ variant: 'secondary', size: 'sm', block: true })}>
              <span className="cp-btn-label">{t('shell.attention.writeReview')}</span>
            </Link>
          </>
        ) : null}
      </RailBox>
    </RightRail>
  );
}
