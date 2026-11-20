// AC13: the platform audit log (A-AUD-01). admin.audit_search is for platform admins only; other roles see the
// no-permission state (D-26).
import type { Metadata } from 'next';
import { AuditPage } from '@/features/audit';
import { SectionGate, sectionMetadata } from '@/server/section-page';

export function generateMetadata(): Promise<Metadata> {
  return sectionMetadata('audit', 'admin.audit.title');
}

export default function Page() {
  return (
    <SectionGate slug="audit">
      <AuditPage />
    </SectionGate>
  );
}
