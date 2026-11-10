// AC6: the flags section (platform admins). Other roles see the no-permission state inside the shell (D-26).
import type { Metadata } from 'next';
import { FlagsPage } from '@/features/flags';
import { SectionGate, sectionMetadata } from '@/server/section-page';

export function generateMetadata(): Promise<Metadata> {
  return sectionMetadata('flags', 'admin.flags.title');
}

export default function Page() {
  return (
    <SectionGate slug="flags">
      <FlagsPage />
    </SectionGate>
  );
}
