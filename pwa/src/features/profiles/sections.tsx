'use client';
// Anchored sections with a sticky section menu (Docs/22 W-PUB-02 "tabs as anchored sections on one page … the section
// menu highlights the current section on scroll"). The menu is plain links (works without JavaScript); once hydrated,
// an IntersectionObserver marks the section in view with aria-current.
import { useEffect, useState } from 'react';
import { cx } from '@/components/ds/cx';

export interface SectionLink {
  id: string;
  label: string;
}

export function SectionMenu({ sections, label }: { sections: readonly SectionLink[]; label: string }) {
  const [current, setCurrent] = useState<string | null>(sections[0]?.id ?? null);

  useEffect(() => {
    const els = sections.map((s) => document.getElementById(s.id)).filter((el): el is HTMLElement => !!el);
    if (!els.length || typeof IntersectionObserver === 'undefined') return;
    const visible = new Map<string, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) visible.set(e.target.id, e.isIntersecting ? e.intersectionRatio : 0);
        // The first section (in page order) that is visible wins.
        const first = sections.find((s) => (visible.get(s.id) ?? 0) > 0);
        if (first) setCurrent(first.id);
      },
      { rootMargin: '-30% 0px -60% 0px', threshold: [0, 0.01, 0.5, 1] },
    );
    for (const el of els) io.observe(el);
    return () => io.disconnect();
  }, [sections]);

  return (
    <nav className="pwa-section-menu" aria-label={label}>
      <ul>
        {sections.map((s) => (
          <li key={s.id}>
            <a
              href={`#${s.id}`}
              className={cx('pwa-section-link', current === s.id && 'is-current')}
              aria-current={current === s.id ? 'location' : undefined}
            >
              {s.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
