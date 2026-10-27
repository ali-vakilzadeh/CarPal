// W-GAR-03 Edit Vehicle (mirrors C-GARAGE-03), P7. ?decode=1 reads the details from the VIN once (after adding).
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { VehicleFormScreen } from '@/features/garage';
import { garageMetadata, GaragePage, localeOf, UUID } from '../../_shared/garage-page';

type Props = { params: Promise<{ locale: string; vehicle: string }> };

export function generateMetadata({ params }: Props): Promise<Metadata> {
  return garageMetadata(params, 'garage.form.editVehicle');
}

export default async function Page({ params }: Props) {
  const [locale, { vehicle }] = await Promise.all([localeOf(params), params]);
  if (!UUID.test(vehicle)) notFound();
  return (
    <GaragePage locale={locale}>
      <Suspense>
        <VehicleFormScreen vehicleId={vehicle.toLowerCase()} />
      </Suspense>
    </GaragePage>
  );
}
