// AC14.T3: notification templates, rules and delivery health (platform admins). Other roles see the no-permission state
// inside the shell (D-26).
import type { Metadata } from 'next';
import { NotificationsPage } from '@/features/notifications';
import { SectionGate, sectionMetadata } from '@/server/section-page';

export function generateMetadata(): Promise<Metadata> {
  return sectionMetadata('notifications', 'admin.notif.title');
}

export default function Page() {
  return (
    <SectionGate slug="notifications">
      <NotificationsPage />
    </SectionGate>
  );
}
