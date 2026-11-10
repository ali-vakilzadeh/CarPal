// AC9: the organizations section (A-ORG-01; platform admins, moderators and support staff). Other roles see the
// no-permission state inside the shell (D-26).
import type { Metadata } from 'next';
import { OrgsPage } from '@/features/orgs';
import { SectionGate, sectionMetadata } from '@/server/section-page';

export function generateMetadata(): Promise<Metadata> {
  return sectionMetadata('orgs', 'admin.orgs.title');
}

export default function Page() {
  return (
    <SectionGate slug="orgs">
      <OrgsPage />
    </SectionGate>
  );
}
