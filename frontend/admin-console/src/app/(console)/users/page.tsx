// AC10: the users section (A-USR-01 as an exact lookup within a work item, DI-03; support staff, moderators and platform
// admins). Other roles see the no-permission state inside the shell (D-26).
import type { Metadata } from 'next';
import { UsersPage } from '@/features/users';
import { SectionGate, sectionMetadata } from '@/server/section-page';

export function generateMetadata(): Promise<Metadata> {
  return sectionMetadata('users', 'admin.users.title');
}

export default function Page() {
  return (
    <SectionGate slug="users">
      <UsersPage />
    </SectionGate>
  );
}
