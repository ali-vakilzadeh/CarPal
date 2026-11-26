// Business notifications of the active business (provider plan PW1.T6). Private page.
import { WorkshopNotifications } from '@/features/provider';
import { workshopMetadata, type LocaleParams } from '../../_shared';

export const generateMetadata = ({ params }: { params: LocaleParams }) =>
  workshopMetadata(params, 'provider.notifications.title');

export default function Page() {
  return <WorkshopNotifications />;
}
