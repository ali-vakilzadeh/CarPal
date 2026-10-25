'use client';
// Right rail (Docs/22 §2.4): context boxes, at most three at a time, on desktop (≥ 1200 px). Pages fill it through the
// @rail parallel route of the (shell) layout; the default box is "Join CarPal" for guests. Featured placements stay
// off while featured.enabled is off and only ever appear in a box labelled "Featured" (never inside lists).
import { Children, type ReactNode } from 'react';
import { buttonClass } from '@/components/ds/button';
import { useSession } from '@/lib/api/session';
import { useFlag } from '@/lib/config/client';
import { useT } from '@/lib/i18n/client';
import { useLoginHref } from './use-login-href';

export const MAX_RAIL_BOXES = 3;

export function RailBox({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="pwa-rail-box" aria-label={title}>
      <h2 className="pwa-rail-title">{title}</h2>
      {children}
    </section>
  );
}

export function RightRail({ children }: { children?: ReactNode }) {
  const t = useT();
  const boxes = Children.toArray(children).slice(0, MAX_RAIL_BOXES);
  if (boxes.length === 0) return null;
  return (
    <aside className="pwa-rail" aria-label={t('shell.rail.label')}>
      {boxes}
    </aside>
  );
}

export function JoinBox() {
  const t = useT();
  const signupHref = useLoginHref('signup');
  return (
    <RailBox title={t('shell.rail.joinTitle')}>
      <p className="pwa-text-caption">{t('shell.rail.joinText')}</p>
      <a href={signupHref} className={buttonClass({ variant: 'primary', block: true })}>
        <span className="cp-btn-label">{t('shell.header.signUp')}</span>
      </a>
    </RailBox>
  );
}

/** A "Featured" box: renders nothing while featured.enabled is off (MVP Rule 2). */
export function FeaturedBox({ children }: { children: ReactNode }) {
  const t = useT();
  const enabled = useFlag('featured.enabled');
  if (!enabled) return null;
  return <RailBox title={t('shell.rail.featured')}>{children}</RailBox>;
}

/** The rail when a page sets none: Join CarPal for guests; signed-in boxes (Your car, Needs your attention) come with P7-P11. */
export function DefaultRail() {
  const session = useSession();
  return <RightRail>{session.data?.signed_in ? null : <JoinBox />}</RightRail>;
}
