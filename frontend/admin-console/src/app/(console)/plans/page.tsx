// AC6: the plans section (platform admins). Other roles see the no-permission state inside the shell (D-26).
import type { Metadata } from 'next';
import { PlansPage } from '@/features/plans';
import { SectionGate, sectionMetadata } from '@/server/section-page';

export function generateMetadata(): Promise<Metadata> {
  return sectionMetadata('plans', 'admin.plans.title');
}

export default function Page() {
  return (
    <SectionGate slug="plans">
      <PlansPage />
    </SectionGate>
  );
}
