'use client';
// The signed-in staff member's own account state from admin.staff_me (AC10b.T1/T4): the BFF's session profile does not
// carry recovery_codes_remaining or restricted_until, so the shell reads them here (every 5 minutes, and again after
// new recovery codes). Two notices above every console page: the post-recovery restriction (72 hours: no approvals,
// role changes or staff re-enabling; STAFF_RECOVERY_RESTRICTED) and a prompt when no recovery code is left.
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Banner } from '@/components/ds/banner';
import { useApiQuery } from '@/lib/api/query';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';

/** Prefix of the admin.staff_me query (invalidate with it after new codes). */
export const STAFF_ME_KEY = ['admin.staff_me'] as const;
export const SECURITY_PATH = '/security';

export function useStaffMe() {
  return useApiQuery('admin.staff_me', undefined, { staleTime: 60_000, refetchInterval: 5 * 60_000 });
}

/** True while a post-recovery restriction runs (now is the time the answer was read). */
export function isRestricted(restrictedUntil: string | null | undefined, now: number): boolean {
  return !!restrictedUntil && Date.parse(restrictedUntil) > now;
}

export function StaffAccountNotices() {
  const t = useT();
  const f = useFormat();
  const pathname = usePathname();
  const me = useStaffMe();
  if (!me.data) return null;
  const restricted = isRestricted(me.data.restricted_until, me.dataUpdatedAt);
  const noCodes = me.data.recovery_codes_remaining === 0 && pathname !== SECURITY_PATH;
  if (!restricted && !noCodes) return null;
  return (
    <div className="adm-notice" data-testid="account-notices">
      {restricted ? (
        <div data-testid="restricted-banner">
          <Banner
            tone="warn"
            icon="shield"
            title={t('admin.security.restricted.title')}
            text={t('admin.security.restricted.text', { when: f.date(me.data.restricted_until!, 'dateTime') })}
          />
        </div>
      ) : null}
      {noCodes ? (
        <div data-testid="no-codes-banner">
          <Banner tone="warn" icon="lock" title={t('admin.security.noCodes.title')}>
            <p className="pwa-banner-text">
              {t('admin.security.noCodes.text')} <Link href={SECURITY_PATH}>{t('admin.security.noCodes.link')}</Link>
            </p>
          </Banner>
        </div>
      ) : null}
    </div>
  );
}
