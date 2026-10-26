// One anchored section of a public page (heading + body); the id is the section menu's anchor.
import type { ReactNode } from 'react';
import { cx } from '@/components/ds/cx';

export function Section({
  id,
  title,
  children,
  end,
  className,
}: {
  id: string;
  title: string;
  children: ReactNode;
  end?: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={cx('pwa-profile-section', className)}>
      <div className="pwa-section-head">
        <h2 id={`${id}-title`} className="pwa-text-h2 m-0">
          {title}
        </h2>
        {end}
      </div>
      {children}
    </section>
  );
}
