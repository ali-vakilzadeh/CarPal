// The app shell around public pages and signed-in tools (P3.T4): header, navigation, main column and the right rail.
// The rail is the @rail parallel route: a page may add @rail/<same path>/page.tsx with its boxes; otherwise
// @rail/default.tsx applies.
import type { ReactNode } from 'react';
import { ShellFrame } from '@/components/shell/shell-frame';

export default function ShellLayout({ children, rail }: { children: ReactNode; rail: ReactNode }) {
  return <ShellFrame rail={rail}>{children}</ShellFrame>;
}
