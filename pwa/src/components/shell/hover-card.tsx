'use client';
// Hover card (Docs/22 §2.5): hovering an author or provider name with a mouse for 500 ms shows a small card (rating,
// badges, Follow). Never on touch or pen, never on focus: the same information and actions are on the profile the
// name links to, so the card adds nothing a keyboard or touch user needs. Esc or leaving closes it.
import { useEffect, useRef, useState, type ReactNode } from 'react';

export const HOVER_DELAY_MS = 500;
const CLOSE_DELAY_MS = 150;

export function HoverCard({ children, card, label }: { children: ReactNode; card: ReactNode; label: string }) {
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const clear = () => window.clearTimeout(timer.current);
  const later = (fn: () => void, ms: number) => {
    clear();
    timer.current = window.setTimeout(fn, ms);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  useEffect(() => clear, []);

  return (
    <span
      className="pwa-hover"
      onPointerEnter={(e) => {
        if (e.pointerType === 'mouse') later(() => setOpen(true), HOVER_DELAY_MS);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === 'mouse') later(() => setOpen(false), CLOSE_DELAY_MS);
        else clear();
      }}
    >
      {children}
      {open ? (
        <span className="pwa-hover-card" role="group" aria-label={label}>
          {card}
        </span>
      ) : null}
    </span>
  );
}
