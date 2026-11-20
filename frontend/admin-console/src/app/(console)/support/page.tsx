// AC14.T5: the support inbox (support staff and platform admins). Other roles see the no-permission state inside the
// shell (D-26).
import type { Metadata } from 'next';
import { SupportPage } from '@/features/support';
import { SectionGate, sectionMetadata } from '@/server/section-page';

export function generateMetadata(): Promise<Metadata> {
  return sectionMetadata('support', 'admin.support.title');
}

export default function Page() {
  return (
    <SectionGate slug="support">
      <SupportPage />
    </SectionGate>
  );
}
