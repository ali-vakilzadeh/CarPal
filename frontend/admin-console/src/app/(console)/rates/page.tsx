// AC6: the rates section (platform admins). Other roles see the no-permission state inside the shell (D-26).
import type { Metadata } from 'next';
import { RatesPage } from '@/features/rates';
import { SectionGate, sectionMetadata } from '@/server/section-page';

export function generateMetadata(): Promise<Metadata> {
  return sectionMetadata('rates', 'admin.rates.title');
}

export default function Page() {
  return (
    <SectionGate slug="rates">
      <RatesPage />
    </SectionGate>
  );
}
