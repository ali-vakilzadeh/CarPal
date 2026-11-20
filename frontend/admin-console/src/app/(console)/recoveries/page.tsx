// AC10b: Recovery requests (staff account recoveries waiting for two administrators; ADM only). Other roles see the
// no-permission state inside the shell (D-26).
import type { Metadata } from 'next';
import { RecoveriesPage } from '@/features/staff-security';
import { SectionGate, sectionMetadata } from '@/server/section-page';

export function generateMetadata(): Promise<Metadata> {
  return sectionMetadata('recoveries', 'admin.recoveries.title');
}

export default function Page() {
  return (
    <SectionGate slug="recoveries">
      <RecoveriesPage />
    </SectionGate>
  );
}
