// Requests tab (provider plan PW3): /<locale>/provider/requests is PW-REQ-01 (segments, ?s=), /requests/<id> is
// PW-REQ-02 with the answer sheets PW-REQ-03 (notification links "New appointment request" and "Customer message" open
// it). Private pages: the proxy marks /<locale>/provider no-store and noindex.
import { WorkshopRequestDetail, WorkshopRequests } from '@/features/provider';
import { workshopMetadata, type LocaleParams } from '../../../_shared';

type Params = Promise<{ locale: string; rest?: string[] }>;

export const generateMetadata = ({ params }: { params: LocaleParams }) => workshopMetadata(params, 'provider.tabs.requests');

export default async function Page({ params }: { params: Params }) {
  const { rest } = await params;
  const id = rest?.[0] ? decodeURIComponent(rest[0]) : null;
  return id ? <WorkshopRequestDetail key={id} appointmentId={id} /> : <WorkshopRequests />;
}
