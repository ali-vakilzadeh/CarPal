// AC10: one user (A-USR-02), read for the work item in ?purpose= (SEC-ADM-5). An id that is not a UUID is the
// not-found state inside the shell (D-26).
import type { Metadata } from 'next';
import { NotFoundState } from '@/components/shell/console-states';
import { UserPage } from '@/features/users';
import { getTranslator } from '@/lib/i18n/dictionary';
import { requestLocale } from '@/server/request-locale';
import { SectionGate, sectionMetadata } from '@/server/section-page';

type Props = { params: Promise<{ userId: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function generateMetadata(): Promise<Metadata> {
  return sectionMetadata('users', 'admin.users.detailTitle');
}

export default async function Page({ params }: Props) {
  const { userId } = await params;
  if (!UUID.test(userId)) return <NotFoundState t={getTranslator(await requestLocale())} />;
  return (
    <SectionGate slug="users">
      <UserPage userId={userId.toLowerCase()} />
    </SectionGate>
  );
}
