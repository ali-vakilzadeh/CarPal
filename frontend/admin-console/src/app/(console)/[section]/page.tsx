// A console section that is not built yet (AC4.T3/T6): the navigation already lists it for the roles that may open it,
// and the page says which stage builds it. A role without access sees the no-permission state with the roles that may
// open it (GD-09); an unknown section sees the not-found state, both inside the shell (rendered here, not through
// forbidden()/notFound(): src/components/shell/console-states.tsx, D-26). Each later stage adds a real folder of the
// same name (e.g. (console)/flags), which Next.js prefers over this dynamic route.
import type { Metadata } from 'next';
import { NoPermission, NotFoundState } from '@/components/shell/console-states';
import { systemMetaTitle } from '@/components/shell/system-page';
import { roleNames } from '@/features/shell/roles';
import { canOpen, rolesFor, sectionBySlug } from '@/features/shell/sections';
import { getTranslator } from '@/lib/i18n/dictionary';
import { requestLocale } from '@/server/request-locale';
import { currentSession } from '@/server/staff-session';

type Props = { params: Promise<{ section: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const [{ section: slug }, locale, session] = await Promise.all([params, requestLocale(), currentSession()]);
  const t = getTranslator(locale);
  const section = sectionBySlug(slug);
  if (!section) return { title: systemMetaTitle('notFound', t) };
  if (!canOpen(section, session.staff?.roles ?? [])) return { title: systemMetaTitle('forbidden', t) };
  return { title: t(`admin.shell.nav.${section.id}`) };
}

export default async function SectionPlaceholder({ params }: Props) {
  const [{ section: slug }, locale, session] = await Promise.all([params, requestLocale(), currentSession()]);
  // Signed out: the layout sends the browser to the sign-in (Next.js renders this page alongside it).
  if (!session.staff) return null;
  const t = getTranslator(locale);
  const section = sectionBySlug(slug);
  if (!section) return <NotFoundState t={t} />;
  if (!canOpen(section, session.staff.roles)) {
    const roles = rolesFor(section);
    return <NoPermission t={t} roles={roles} roleNames={roleNames(roles, t)} />;
  }
  return (
    <div className="adm-page" data-testid="section-placeholder" data-section={section.id}>
      <h1 className="adm-page-title">{t(`admin.shell.nav.${section.id}`)}</h1>
      <p className="adm-measure">{t('admin.shell.section.text', { stage: section.stage })}</p>
      <p className="adm-muted">{t('admin.shell.section.needs', { roles: roleNames(rolesFor(section), t) })}</p>
    </div>
  );
}
