// Compact onboarding /<locale>/provider/start (provider plan PW2, PW-ONB-01..04): signed in, no business needed. Entered
// from W-ONB-01 'Service provider', the account menu's 'Create a business', the business switch's 'Add a business',
// the Workshop entry's Sign up and Today's 'Continue setting up'. The map of step 2 needs the region's style and the
// map words (search); the licence photo of step 4 the upload words (media).
import { SessionGate } from '@/components/shell/session-gate';
import { WorkshopOnboarding } from '@/features/provider';
import { I18nNamespaces } from '@/lib/i18n/client';
import { mapStyleUrl } from '@/server/map-config';
import { pageContext } from '@/server/ssr/page-context';
import { localeOf, workshopMetadata, type LocaleParams } from '../../_shared';

export const generateMetadata = ({ params }: { params: LocaleParams }) => workshopMetadata(params, 'provider.start.title');

export default async function Page({ params }: { params: LocaleParams }) {
  const ctx = await pageContext(await localeOf(params));
  return (
    <I18nNamespaces resources={ctx.i18n.resources(['search', 'media'])}>
      <SessionGate>
        <WorkshopOnboarding styleUrl={mapStyleUrl(ctx.region)} />
      </SessionGate>
    </I18nNamespaces>
  );
}
