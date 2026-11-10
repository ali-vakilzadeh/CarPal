// AC8: the inventory section (cases of listings and fitment records; moderators and platform admins). Other roles
// see the no-permission state inside the shell (D-26).
import type { Metadata } from 'next';
import { InventoryPage } from '@/features/moderation';
import { serverEnv } from '@/server/env';
import { SectionGate, sectionMetadata } from '@/server/section-page';

export function generateMetadata(): Promise<Metadata> {
  return sectionMetadata('inventory', 'admin.moderation.inventory.title');
}

export default function Page() {
  return (
    <SectionGate slug="inventory">
      <InventoryPage publicWeb={serverEnv().CARPAL_ADMIN_PUBLIC_WEB_URL} />
    </SectionGate>
  );
}
