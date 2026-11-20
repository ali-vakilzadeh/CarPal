// AC14.T2: the staff directory (platform admins). Other roles see the no-permission state inside the shell (D-26).
import type { Metadata } from 'next';
import { StaffPage } from '@/features/staff';
import { SectionGate, sectionMetadata } from '@/server/section-page';

export function generateMetadata(): Promise<Metadata> {
  return sectionMetadata('staff', 'admin.staffDir.title');
}

export default function Page() {
  return (
    <SectionGate slug="staff">
      <StaffPage />
    </SectionGate>
  );
}
