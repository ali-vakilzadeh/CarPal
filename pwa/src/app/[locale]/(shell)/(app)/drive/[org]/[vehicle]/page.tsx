// DRV-WEB Assigned vehicle (P12.T4): status, mileage, my reports with their approval, appointments (status only).
import { notFound } from 'next/navigation';
import { DriverVehicle } from '@/features/fleet-driver';
import { DrivePage, UUID, driveMetadata, localeOf } from '../../_shared';

type Props = { params: Promise<{ locale: string; org: string; vehicle: string }> };

export const generateMetadata = ({ params }: Props) => driveMetadata(params);

export default async function Page({ params }: Props) {
  const { org, vehicle } = await params;
  if (!UUID.test(org) || !UUID.test(vehicle)) notFound();
  return (
    <DrivePage locale={await localeOf(params)}>
      <DriverVehicle orgId={org} vehicleId={vehicle} />
    </DrivePage>
  );
}
