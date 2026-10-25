// Test double of next/link: a plain anchor (no App Router context in jsdom).
import type { AnchorHTMLAttributes, ReactNode } from 'react';

export default function Link({
  href,
  children,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children?: ReactNode }) {
  return (
    <a href={href} {...rest}>
      {children}
    </a>
  );
}
