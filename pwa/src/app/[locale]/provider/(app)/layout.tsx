// CarPal Workshop pages that need a provider business (provider plan PW1.T2): the session gate (guests go to the
// hosted sign-in and come back here), then the Workshop gate (no business → the compact-onboarding entry).
import type { ReactNode } from 'react';
import { SessionGate } from '@/components/shell/session-gate';
import { WorkshopGate } from '@/features/provider';

export default function WorkshopAppLayout({ children }: { children: ReactNode }) {
  return (
    <SessionGate>
      <WorkshopGate>{children}</WorkshopGate>
    </SessionGate>
  );
}
