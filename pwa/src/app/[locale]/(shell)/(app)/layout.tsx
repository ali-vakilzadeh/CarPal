// Signed-in tools (W-GAR, W-APP, W-SET …): private pages (no-store, noindex via the proxy) behind the session gate.
// The server never redirects on a missing cookie (SameSite=Strict, P2 notes); the gate confirms in the browser and
// sends guests to the hosted sign-in with this page as the return URL.
import type { ReactNode } from 'react';
import { SessionGate } from '@/components/shell/session-gate';

export default function AppLayout({ children }: { children: ReactNode }) {
  return <SessionGate>{children}</SessionGate>;
}
