'use client';
// "Needs your attention" (Docs/22 §2.4 right rail, BA-04): for signed-in users, ownership requests waiting for their
// decision (someone says they bought a car in their garage). Links to the garage, where the Ownership requests block
// has Accept / Reject. Renders no rail at all when nothing needs attention. P9-P11 add notifications, appointments
// and review invitations here.
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
  const count = transfers.data?.items.length ?? 0;
  if (count === 0) return null;
  return (
    <RightRail>
      <RailBox title={t('shell.attention.title')}>
        <p className="pwa-text-caption">{t('shell.attention.transfers', { count })}</p>
        <Link href={`/${locale}/garage`} className={buttonClass({ variant: 'secondary', size: 'sm', block: true })}>
          <span className="cp-btn-label">{t('shell.attention.review')}</span>
        </Link>
      </RailBox>
    </RightRail>
  );
}
