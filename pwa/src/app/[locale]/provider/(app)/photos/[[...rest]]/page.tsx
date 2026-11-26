// Photos tab (PW-PHO-01..04 arrive in provider plan PW7): until then a "coming soon" state with Open in Web UI.
import { WorkshopSoon } from '@/features/provider';
import { workshopMetadata, type LocaleParams } from '../../../_shared';

export const generateMetadata = ({ params }: { params: LocaleParams }) => workshopMetadata(params, 'provider.tabs.photos');

export default function Page() {
  return <WorkshopSoon tab="photos" />;
}
