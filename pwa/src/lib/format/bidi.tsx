// <Bidi> isolates a run of text inside a sentence of the other direction (GD-10, design system "Bidirectional
// layout"): names and user text keep their own direction (auto); plates, phone numbers, VINs, codes and URLs stay
// left-to-right as typed (`ltr`) and are never digit-converted.
import type { ReactNode } from 'react';

/**
 * The same isolation inside a translated string (an interpolated value): U+2066/U+2068 … U+2069, so a phone number or
 * an email keeps its order inside a Persian sentence.
 */
const LRI = String.fromCodePoint(0x2066);
const FSI = String.fromCodePoint(0x2068);
const PDI = String.fromCodePoint(0x2069);

export function isolate(text: string, ltr = false): string {
  return `${ltr ? LRI : FSI}${text}${PDI}`;
}

export function Bidi({ children, ltr = false, className }: { children: ReactNode; ltr?: boolean; className?: string }) {
  return (
    <bdi dir={ltr ? 'ltr' : 'auto'} className={className}>
      {children}
    </bdi>
  );
}
