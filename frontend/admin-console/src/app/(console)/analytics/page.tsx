// AC13: analytics (A-ANL-01), one view per dashboard key of the contract. Administrators, moderators and support read
// it; other roles see the no-permission state (D-26).
import type { Metadata } from 'next';
import { AnalyticsPage } from '@/features/analytics';
import { SectionGate, sectionMetadata } from '@/server/section-page';

export function generateMetadata(): Promise<Metadata> {
  return sectionMetadata('analytics', 'admin.analytics.title');
}

export default function Page() {
  return (
    <SectionGate slug="analytics">
      <AnalyticsPage />
    </SectionGate>
  );
}
