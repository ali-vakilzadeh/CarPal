// Console home "My work" (AC5.T7, A-DASH-01 queue part): changes waiting for the caller's approval and the work queues
// their roles may see, with counts, oldest age and SLA state. The full dashboard (widgets, analytics) is AC13.
import type { Metadata } from 'next';
import { MyWork } from '@/features/dashboard';
import { ADMIN_CONTRACT } from '@/lib/api/generated';
import { formatNumber } from '@/lib/format';
import { getTranslator } from '@/lib/i18n/dictionary';
import { requestLocale } from '@/server/request-locale';
import { currentSession } from '@/server/staff-session';

export async function generateMetadata(): Promise<Metadata> {
  return { title: getTranslator(await requestLocale())('admin.work.metaTitle') };
}

export default async function ConsoleHome() {
  const [locale, session] = await Promise.all([requestLocale(), currentSession()]);
  // The layout sends a signed-out browser to the sign-in, but Next.js renders the page alongside it: render nothing.
  if (!session.staff) return null;
  const t = getTranslator(locale);
  const operations = ADMIN_CONTRACT.adminOperationCount + ADMIN_CONTRACT.apiReadCount;
  return (
    <>
      <MyWork />
      <p className="adm-muted" data-testid="contract-line">
        {t('admin.console.contractLine', { version: ADMIN_CONTRACT.version, n: formatNumber(operations, locale) })}
      </p>
    </>
  );
}
