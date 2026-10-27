// /<locale>/garage/<vehicle-id> → its Overview tab (W-GAR-01 tabs are routes).
import { notFound, redirect } from 'next/navigation';
import { localeOf, UUID } from '../_shared/garage-page';

type Props = { params: Promise<{ locale: string; vehicle: string }> };

export default async function Page({ params }: Props) {
  const [locale, { vehicle }] = await Promise.all([localeOf(params), params]);
  if (!UUID.test(vehicle)) notFound();
  redirect(`/${locale}/garage/${vehicle.toLowerCase()}/overview`);
}
