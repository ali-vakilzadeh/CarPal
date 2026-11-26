// Replies tab (PW-RPL-01..04 arrive in provider plan PW5 and PW6): until then a "coming soon" state with Open in Web
// UI, so notification links to /provider/replies/… do not land on a 404.
import { WorkshopSoon } from '@/features/provider';
import { workshopMetadata, type LocaleParams } from '../../../_shared';

export const generateMetadata = ({ params }: { params: LocaleParams }) => workshopMetadata(params, 'provider.tabs.replies');

export default function Page() {
  return <WorkshopSoon tab="replies" />;
}
