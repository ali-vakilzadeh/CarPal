// W-GAR-01 My Garage (mirrors C-GARAGE-01/02/06/08/09): /<locale>/garage opens the browser's active vehicle, or the
// empty state with "Add your first car" (P7).
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { GarageScreen } from '@/features/garage';
import { garageMetadata, GaragePage, localeOf } from './_shared/garage-page';

type Props = { params: Promise<{ locale: string }> };

export function generateMetadata({ params }: Props): Promise<Metadata> {
  return garageMetadata(params);
}

export default async function Page({ params }: Props) {
  return (
    <GaragePage locale={await localeOf(params)}>
      <Suspense>
        <GarageScreen vehicleId={null} tab="overview" />
      </Suspense>
    </GaragePage>
  );
}
