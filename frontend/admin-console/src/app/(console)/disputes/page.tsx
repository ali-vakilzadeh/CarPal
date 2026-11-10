// AC7: Disputes & appeals (moderators and community reviewers). Other roles see the no-permission state inside the
// shell (D-26).
import type { Metadata } from 'next';
import { DisputesPage } from '@/features/disputes';
import { SectionGate, sectionMetadata } from '@/server/section-page';

export function generateMetadata(): Promise<Metadata> {
  return sectionMetadata('disputes', 'admin.disputes.title');
}

export default function Page() {
  return (
    <SectionGate slug="disputes">
      <DisputesPage />
    </SectionGate>
  );
}
