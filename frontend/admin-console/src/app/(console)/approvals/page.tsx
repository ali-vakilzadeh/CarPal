// Pending approvals (AC5.T4): four-eyes changes waiting for a second staff member (ADM; MOD for moderation changes).
// Other roles see the no-permission state inside the shell (D-26: never forbidden() under (console)).
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { NoPermission } from '@/components/shell/console-states';
import { systemMetaTitle } from '@/components/shell/system-page';
import { ApprovalsPage } from '@/features/approvals';
import { canOpen, roleNames, rolesFor, sectionBySlug } from '@/features/shell';
import { getTranslator } from '@/lib/i18n/dictionary';
import { requestLocale } from '@/server/request-locale';
import { currentSession } from '@/server/staff-session';

const section = sectionBySlug('approvals')!;

export async function generateMetadata(): Promise<Metadata> {
  const [locale, session] = await Promise.all([requestLocale(), currentSession()]);
  const t = getTranslator(locale);
  if (!canOpen(section, session.staff?.roles ?? [])) return { title: systemMetaTitle('forbidden', t) };
  return { title: t('admin.approvals.title') };
}

export default async function Approvals() {
  const [locale, session] = await Promise.all([requestLocale(), currentSession()]);
  if (!session.staff) return null;
  if (!canOpen(section, session.staff.roles)) {
    const t = getTranslator(locale);
    const roles = rolesFor(section);
    return <NoPermission t={t} roles={roles} roleNames={roleNames(roles, t)} />;
  }
  return (
    <Suspense fallback={null}>
      <ApprovalsPage />
    </Suspense>
  );
}
