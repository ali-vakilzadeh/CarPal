// W-GAR-01 Print / Export PDF of the service history (buyer-friendly, Story Ch. 10), P7. ?costs=0 leaves costs out.
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { PrintView } from '@/features/garage';
import { garageMetadata, GaragePage, localeOf, UUID } from '../../_shared/garage-page';

type Props = { params: Promise<{ locale: string; vehicle: string }> };

export function generateMetadata({ params }: Props): Promise<Metadata> {
  return garageMetadata(params, 'garage.print.title');
}

export default async function Page({ params }: Props) {
  const [locale, { vehicle }] = await Promise.all([localeOf(params), params]);
  if (!UUID.test(vehicle)) notFound();
  return (
    <GaragePage locale={locale}>
      <Suspense>
        <PrintView vehicleId={vehicle.toLowerCase()} />
      </Suspense>
    </GaragePage>
  );
}
