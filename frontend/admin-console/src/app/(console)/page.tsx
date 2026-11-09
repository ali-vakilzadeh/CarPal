// Console home (AC4): who is signed in, with which roles, and the sections those roles open. AC5 replaces it with
// "My work" (pending approvals and queue counts).
import type { Metadata } from 'next';
import Link from 'next/link';
import { Icon } from '@/components/ds/icon';
import { roleNames } from '@/features/shell/roles';
import { visibleSections } from '@/features/shell/sections';
import { ADMIN_CONTRACT } from '@/lib/api/generated';
import { formatNumber } from '@/lib/format';
import { getTranslator } from '@/lib/i18n/dictionary';
import { requestLocale } from '@/server/request-locale';
import { currentSession } from '@/server/staff-session';

export async function generateMetadata(): Promise<Metadata> {
  return { title: getTranslator(await requestLocale())('admin.shell.nav.dashboard') };
}

export default async function ConsoleHome() {
  const [locale, session] = await Promise.all([requestLocale(), currentSession()]);
  const t = getTranslator(locale);
  // The layout sends a signed-out browser to the sign-in, but Next.js renders the page alongside it: render nothing.
  const staff = session.staff;
  if (!staff) return null;
  const sections = visibleSections(staff.roles).filter((s) => s.path !== '/');
  const operations = ADMIN_CONTRACT.adminOperationCount + ADMIN_CONTRACT.apiReadCount;
  return (
    <div className="adm-page">
      <h1 className="adm-page-title">{t('admin.console.home.title', { name: staff.display_name })}</h1>
      <p className="adm-measure">{t('admin.console.home.text')}</p>
      <p data-testid="home-roles">{t('admin.console.home.roles', { roles: roleNames(staff.roles, t) })}</p>
      <h2 className="adm-section-title">{t('admin.console.home.sections')}</h2>
      <ul className="adm-tiles">
        {sections.map((s) => (
          <li key={s.id}>
            <Link href={s.path} className="adm-tile">
              <Icon name={s.icon} size={20} />
              <span>{t(`admin.shell.nav.${s.id}`)}</span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="adm-muted" data-testid="contract-line">
        {t('admin.console.contractLine', { version: ADMIN_CONTRACT.version, n: formatNumber(operations, locale) })}
      </p>
    </div>
  );
}
