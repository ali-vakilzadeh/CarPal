// AC6: the retention section (platform admins). Other roles see the no-permission state inside the shell (D-26).
import type { Metadata } from 'next';
import { RetentionPage } from '@/features/retention';
import { SectionGate, sectionMetadata } from '@/server/section-page';

export function generateMetadata(): Promise<Metadata> {
  return sectionMetadata('retention', 'admin.retention.title');
}

export default function Page() {
  return (
    <SectionGate slug="retention">
      <RetentionPage />
    </SectionGate>
  );
}
