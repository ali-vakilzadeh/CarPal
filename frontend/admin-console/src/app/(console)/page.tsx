// Console home (A-DASH-01): My work and the queues (AC5.T7), and since AC13 the full dashboard (safety, growth, trust,
// AI and system widgets, each failing on its own).
import type { Metadata } from 'next';
import { Dashboard } from '@/features/dashboard';
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
      <Dashboard />
      <p className="adm-muted" data-testid="contract-line">
        {t('admin.console.contractLine', { version: ADMIN_CONTRACT.version, n: formatNumber(operations, locale) })}
      </p>
    </>
  );
}
