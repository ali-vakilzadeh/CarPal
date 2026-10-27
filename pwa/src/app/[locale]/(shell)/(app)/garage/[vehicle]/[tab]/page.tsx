// W-GAR-01 My Garage with a vehicle and a tab: /<locale>/garage/<vehicle-id>/<overview|history|issues|documents|
// reminders> (P7). Drawers and dialogs live in ?modal= (record, issue, issue-add, document-add).
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { GarageScreen, isTab } from '@/features/garage';
import { garageMetadata, GaragePage, localeOf, UUID } from '../../_shared/garage-page';

type Props = { params: Promise<{ locale: string; vehicle: string; tab: string }> };

export function generateMetadata({ params }: Props): Promise<Metadata> {
  return garageMetadata(params);
}

export default async function Page({ params }: Props) {
  const [locale, { vehicle, tab }] = await Promise.all([localeOf(params), params]);
  if (!UUID.test(vehicle) || !isTab(tab)) notFound();
  return (
    <GaragePage locale={locale}>
      <Suspense>
        <GarageScreen vehicleId={vehicle.toLowerCase()} tab={tab} />
      </Suspense>
    </GaragePage>
  );
}
