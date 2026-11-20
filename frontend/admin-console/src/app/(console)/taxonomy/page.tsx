// AC12: taxonomy management (A-TAX-01 tree and list, A-TAX-02 node editor and merge, zero-result searches). Platform
// admins edit; moderators read and decide AI-suggested synonyms. Other roles see the no-permission state (D-26).
import type { Metadata } from 'next';
import { TaxonomyPage } from '@/features/taxonomy';
import { SectionGate, sectionMetadata } from '@/server/section-page';

export function generateMetadata(): Promise<Metadata> {
  return sectionMetadata('taxonomy', 'admin.taxonomy.title');
}

export default function Page() {
  return (
    <SectionGate slug="taxonomy">
      <TaxonomyPage />
    </SectionGate>
  );
}
