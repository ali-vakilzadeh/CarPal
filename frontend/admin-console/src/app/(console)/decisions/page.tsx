// AC14-2: My decisions (admin.my_decisions_list) for community reviewers and moderators, reached from the account menu
// like /security (not a navigation section). Other roles see the no-permission state inside the shell (D-26).
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { NoPermission } from '@/components/shell/console-states';
import { systemMetaTitle } from '@/components/shell/system-page';
import { DecisionsPage } from '@/features/decisions';
import { roleNames, STAFF_ROLE_ORDER } from '@/features/shell';
import { getTranslator } from '@/lib/i18n/dictionary';
import { canCall } from '@/lib/roles';
import { requestLocale } from '@/server/request-locale';
import { currentSession } from '@/server/staff-session';

export async function generateMetadata(): Promise<Metadata> {
  const [locale, session] = await Promise.all([requestLocale(), currentSession()]);
  const t = getTranslator(locale);
  if (!canCall('admin.my_decisions_list', session.staff?.roles ?? [])) return { title: systemMetaTitle('forbidden', t) };
  return { title: t('admin.decisions.title') };
}

export default async function Page() {
  const [locale, session] = await Promise.all([requestLocale(), currentSession()]);
  if (!session.staff) return null;
  if (!canCall('admin.my_decisions_list', session.staff.roles)) {
    const t = getTranslator(locale);
    const roles = STAFF_ROLE_ORDER.filter((r) => canCall('admin.my_decisions_list', [r]));
    return <NoPermission t={t} roles={roles} roleNames={roleNames(roles, t)} />;
  }
  return (
    <Suspense fallback={null}>
      <DecisionsPage />
    </Suspense>
  );
}
