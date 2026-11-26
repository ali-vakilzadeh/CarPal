// Counter tile (PRV-GD-08): one number with its label and a caption, optionally a link to the list behind it. Used on
// the Workshop's Today screen (PW-HOME-01) and the Web UI dashboard (P-DASH-01). `value` is already formatted by the
// caller (Persian digits, "50+"); `alert` is a short warning line in the danger colour (e.g. "1 safety-critical").
import type { ComponentType, ReactNode } from 'react';
import { cx } from './cx';

export type LinkLike = ComponentType<{
  href: string;
  className?: string;
  children?: ReactNode;
}>;

export interface CounterTileProps {
  label: string;
  value: string;
  caption?: string;
  alert?: string;
  href?: string;
  linkAs?: LinkLike | 'a';
  /** Emphasise the tile (something waits for the shop). */
  attention?: boolean;
  className?: string;
}

export function CounterTile({ label, value, caption, alert, href, linkAs = 'a', attention, className }: CounterTileProps) {
  const body = (
    <>
      <span className="bui-counter-label">{label}</span>
      <span className="bui-counter-value">{value}</span>
      {alert ? <span className="bui-counter-alert">{alert}</span> : null}
      {caption ? <span className="bui-counter-caption">{caption}</span> : null}
    </>
  );
  const classes = cx('bui-counter', attention && 'is-attention', href && 'is-link', className);
  if (!href) return <div className={classes}>{body}</div>;
  const Link = linkAs;
  return (
    <Link href={href} className={classes}>
      {body}
    </Link>
  );
}
