// Jobs (provider plan PW4, PW-JOB-01): /<locale>/provider/jobs/<id> updates a booked visit (status buttons from
// allowed_transitions, Awaiting parts, no-show, cancel) and /jobs/<id>/close closes it with the outcome. Today's jobs
// and the Upcoming requests link here. /jobs alone goes to Today. Private pages: the proxy marks /<locale>/provider
// no-store and noindex.
import { redirect } from 'next/navigation';
import { WorkshopCloseJob, WorkshopJob } from '@/features/provider';
import { localeOf, workshopMetadata, type LocaleParams } from '../../../_shared';

type Params = Promise<{ locale: string; rest?: string[] }>;

export const generateMetadata = ({ params }: { params: LocaleParams }) => workshopMetadata(params, 'provider.jobs.title');

export default async function Page({ params }: { params: Params }) {
  const { rest } = await params;
  const id = rest?.[0] ? decodeURIComponent(rest[0]) : null;
  if (!id) redirect(`/${await localeOf(params)}/provider/today`);
  if (rest?.[1] === 'close') return <WorkshopCloseJob key={id} appointmentId={id} />;
  return <WorkshopJob key={id} appointmentId={id} />;
}
