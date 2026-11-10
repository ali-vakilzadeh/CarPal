// AC8: the content section (reports inbox for moderators and support; content, account and AI output cases for
// moderators and platform admins). Other roles see the no-permission state inside the shell (D-26). The public web
// app's origin goes to the page for "Open the public page" links (GD-07).
import type { Metadata } from 'next';
import { ContentPage } from '@/features/moderation';
import { serverEnv } from '@/server/env';
import { SectionGate, sectionMetadata } from '@/server/section-page';

export function generateMetadata(): Promise<Metadata> {
  return sectionMetadata('content', 'admin.moderation.title');
}

export default function Page() {
  return (
    <SectionGate slug="content">
      <ContentPage publicWeb={serverEnv().CARPAL_ADMIN_PUBLIC_WEB_URL} />
    </SectionGate>
  );
}
