// DRV-WEB Report an issue (P12.T4; Docs/55 §10.4 F-ISSUE-01) on an assigned vehicle: goes to the fleet manager.
import { notFound } from 'next/navigation';
import { DriverReport } from '@/features/fleet-driver';
import { DrivePage, UUID, driveMetadata, localeOf } from '../../../_shared';

type Props = { params: Promise<{ locale: string; org: string; vehicle: string }> };

export const generateMetadata = ({ params }: Props) => driveMetadata(params, true);

export default async function Page({ params }: Props) {
  const { org, vehicle } = await params;
  if (!UUID.test(org) || !UUID.test(vehicle)) notFound();
  return (
    <DrivePage locale={await localeOf(params)}>
      <DriverReport orgId={org} vehicleId={vehicle} />
    </DrivePage>
  );
}
