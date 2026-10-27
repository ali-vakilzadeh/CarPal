// W-GAR-03 Add Vehicle (mirrors C-GARAGE-03, C-PLAN-01), P7.
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { VehicleFormScreen } from '@/features/garage';
import { garageMetadata, GaragePage, localeOf } from '../_shared/garage-page';

type Props = { params: Promise<{ locale: string }> };

export function generateMetadata({ params }: Props): Promise<Metadata> {
  return garageMetadata(params, 'garage.addVehicle');
}

export default async function Page({ params }: Props) {
  return (
    <GaragePage locale={await localeOf(params)}>
      <Suspense>
        <VehicleFormScreen vehicleId={null} />
      </Suspense>
    </GaragePage>
  );
}
