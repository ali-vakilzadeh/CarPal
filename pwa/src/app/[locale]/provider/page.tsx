// PW-AUTH-01 Workshop entry (provider plan PW1; mockup 'Sign in to your workshop'): signed out, what CarPal Workshop
// does and Sign in through the hosted sign-in; signed in, straight to Today. The address the Web UI sign-in button
// opens (PP1.T6) and the Workshop manifest starts from (PW8.T1).
import { WorkshopEntry } from '@/features/provider';
import { workshopMetadata, type LocaleParams } from './_shared';

export const generateMetadata = ({ params }: { params: LocaleParams }) => workshopMetadata(params);

export default function Page() {
  return <WorkshopEntry />;
}
