// DRV-WEB Fleet driver home (P12.T4): the vehicles assigned to me in each fleet I drive for. Private page.
import { DriverHome } from '@/features/fleet-driver';
import { DrivePage, driveMetadata, localeOf } from './_shared';

type Props = { params: Promise<{ locale: string }> };

export const generateMetadata = ({ params }: Props) => driveMetadata(params);

export default async function Page({ params }: Props) {
  return (
    <DrivePage locale={await localeOf(params)}>
      <DriverHome />
    </DrivePage>
  );
}
