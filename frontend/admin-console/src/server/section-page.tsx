// The server half of a built console section (AC6, after AC5's Pending approvals page): the page title, and the
// no-permission state inside the shell for a role that may not open the section (D-26: never forbidden() under
// (console)). The section's client screen renders only for staff who may open it; the server still decides every call.
import type { Metadata } from 'next';
import { Suspense, type ReactNode } from 'react';
import { NoPermission } from '@/components/shell/console-states';
import { systemMetaTitle } from '@/components/shell/system-page';
import { canOpen, roleNames, rolesFor, sectionBySlug, type Section } from '@/features/shell';
import { getTranslator } from '@/lib/i18n/dictionary';
import type { MessageKey } from '@/lib/i18n/keys';
import { requestLocale } from '@/server/request-locale';
import { currentSession } from '@/server/staff-session';

function section(slug: string): Section {
  const s = sectionBySlug(slug);
  if (!s) throw new Error(`unknown console section ${slug}`);
  return s;
}

export async function sectionMetadata(slug: string, title: MessageKey): Promise<Metadata> {
  const [locale, session] = await Promise.all([requestLocale(), currentSession()]);
  const t = getTranslator(locale);
  if (!canOpen(section(slug), session.staff?.roles ?? [])) return { title: systemMetaTitle('forbidden', t) };
  return { title: t(title) };
}

/** Renders the screen for staff who may open the section, else the no-permission state (signed out: nothing). */
export async function SectionGate({ slug, children }: { slug: string; children: ReactNode }) {
  const [locale, session] = await Promise.all([requestLocale(), currentSession()]);
  if (!session.staff) return null;
  const s = section(slug);
  if (!canOpen(s, session.staff.roles)) {
    const t = getTranslator(locale);
    const roles = rolesFor(s);
    return <NoPermission t={t} roles={roles} roleNames={roleNames(roles, t)} />;
  }
  return <Suspense fallback={null}>{children}</Suspense>;
}
