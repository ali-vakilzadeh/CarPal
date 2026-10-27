// W-GAR-02 Add service record (mirrors C-GARAGE-05), P7.
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { RecordFormScreen } from '@/features/garage';
import { garageMetadata, GaragePage, localeOf, UUID } from '../../../_shared/garage-page';

type Props = { params: Promise<{ locale: string; vehicle: string }> };

export function generateMetadata({ params }: Props): Promise<Metadata> {
  return garageMetadata(params, 'garage.form.addRecord');
}

export default async function Page({ params }: Props) {
  const [locale, { vehicle }] = await Promise.all([localeOf(params), params]);
  if (!UUID.test(vehicle)) notFound();
  return (
    <GaragePage locale={locale}>
      <Suspense>
        <RecordFormScreen vehicleId={vehicle.toLowerCase()} recordId={null} />
      </Suspense>
    </GaragePage>
  );
}
