// AC14.T4: policies and consent texts (platform admins). Other roles see the no-permission state inside the shell (D-26).
import type { Metadata } from 'next';
import { PoliciesPage } from '@/features/policies';
import { SectionGate, sectionMetadata } from '@/server/section-page';

export function generateMetadata(): Promise<Metadata> {
  return sectionMetadata('policies', 'admin.policies.title');
}

export default function Page() {
  return (
    <SectionGate slug="policies">
      <PoliciesPage />
    </SectionGate>
  );
}
