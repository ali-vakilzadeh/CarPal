// AC9: one organization (A-ORG-02), read for the work item in ?purpose= (SEC-ADM-5). The page passes the public web
// app's origin (View public profile, GD-07) and the map style URL whose origin the page CSP allows (Locations tab).
// An id that is not a UUID is the not-found state inside the shell (D-26).
import type { Metadata } from 'next';
import { NotFoundState } from '@/components/shell/console-states';
import { OrgPage } from '@/features/orgs';
import { getTranslator } from '@/lib/i18n/dictionary';
import { requestLocale } from '@/server/request-locale';
import { serverEnv } from '@/server/env';
import { SectionGate, sectionMetadata } from '@/server/section-page';

type Props = { params: Promise<{ orgId: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function generateMetadata(): Promise<Metadata> {
  return sectionMetadata('orgs', 'admin.orgs.detailTitle');
}

export default async function Page({ params }: Props) {
  const { orgId } = await params;
  if (!UUID.test(orgId)) return <NotFoundState t={getTranslator(await requestLocale())} />;
  const env = serverEnv();
  return (
    <SectionGate slug="orgs">
      <OrgPage
        orgId={orgId.toLowerCase()}
        publicWeb={env.CARPAL_ADMIN_PUBLIC_WEB_URL}
        mapStyleUrl={env.CARPAL_ADMIN_MAP_STYLE_URL ?? null}
      />
    </SectionGate>
  );
}
