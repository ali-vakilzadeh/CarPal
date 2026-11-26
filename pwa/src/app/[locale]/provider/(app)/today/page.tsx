// PW-HOME-01 Today (provider plan PW1.T5; mirrors P-DASH-01, reduced). Private page.
import { WorkshopToday } from '@/features/provider';
import { workshopMetadata, type LocaleParams } from '../../_shared';

export const generateMetadata = ({ params }: { params: LocaleParams }) => workshopMetadata(params, 'provider.today.title');

export default function Page() {
  return <WorkshopToday />;
}
