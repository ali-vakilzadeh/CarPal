// AC10: the privacy-requests section (A-DSR-01 queue and A-DSR-02 request; support staff and platform admins). Other
// roles see the no-permission state inside the shell (D-26).
import type { Metadata } from 'next';
import { PrivacyPage } from '@/features/privacy';
import { SectionGate, sectionMetadata } from '@/server/section-page';

export function generateMetadata(): Promise<Metadata> {
  return sectionMetadata('privacy', 'admin.privacy.title');
}

export default function Page() {
  return (
    <SectionGate slug="privacy">
      <PrivacyPage />
    </SectionGate>
  );
}
