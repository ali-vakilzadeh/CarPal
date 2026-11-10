// AC9: the verification section (A-VER-01 queue and A-VER-02 review; platform admins and moderators). Other roles see
// the no-permission state inside the shell (D-26).
import type { Metadata } from 'next';
import { VerificationPage } from '@/features/verification';
import { SectionGate, sectionMetadata } from '@/server/section-page';

export function generateMetadata(): Promise<Metadata> {
  return sectionMetadata('verification', 'admin.verification.title');
}

export default function Page() {
  return (
    <SectionGate slug="verification">
      <VerificationPage />
    </SectionGate>
  );
}
