// AC10b: Security keys and recovery codes, for every staff member (their own keys and codes; reached from the avatar
// menu, not a navigation section).
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { SecurityPage } from '@/features/staff-security';
import { getTranslator } from '@/lib/i18n/dictionary';
import { requestLocale } from '@/server/request-locale';
import { currentSession } from '@/server/staff-session';

export async function generateMetadata(): Promise<Metadata> {
  return { title: getTranslator(await requestLocale())('admin.security.title') };
}

export default async function Page() {
  const session = await currentSession();
  if (!session.staff) return null;
  return (
    <Suspense fallback={null}>
      <SecurityPage />
    </Suspense>
  );
}
