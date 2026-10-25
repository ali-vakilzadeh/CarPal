// <Bidi> isolates a run of text inside a sentence of the other direction (GD-10, design system "Bidirectional
// layout"): names and user text keep their own direction (auto); plates, phone numbers, VINs, codes and URLs stay
// left-to-right as typed (`ltr`) and are never digit-converted.
import type { ReactNode } from 'react';

export function Bidi({ children, ltr = false, className }: { children: ReactNode; ltr?: boolean; className?: string }) {
  return (
    <bdi dir={ltr ? 'ltr' : 'auto'} className={className}>
      {children}
    </bdi>
  );
}
