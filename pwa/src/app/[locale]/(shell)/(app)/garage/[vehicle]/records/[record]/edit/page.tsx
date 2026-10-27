// W-GAR-02 Edit service record (mirrors C-GARAGE-05; records the user added only), P7.
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { RecordFormScreen } from '@/features/garage';
import { garageMetadata, GaragePage, localeOf, UUID } from '../../../../_shared/garage-page';

type Props = { params: Promise<{ locale: string; vehicle: string; record: string }> };

export function generateMetadata({ params }: Props): Promise<Metadata> {
  return garageMetadata(params, 'garage.form.editRecord');
}

export default async function Page({ params }: Props) {
  const [locale, { vehicle, record }] = await Promise.all([localeOf(params), params]);
  if (!UUID.test(vehicle) || !UUID.test(record)) notFound();
  return (
    <GaragePage locale={locale}>
      <Suspense>
        <RecordFormScreen vehicleId={vehicle.toLowerCase()} recordId={record.toLowerCase()} />
      </Suspense>
    </GaragePage>
  );
}
