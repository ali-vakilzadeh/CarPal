// Port of the design system's Avatar (bundle.js; same classes and props). The bundle sizes the circle with an inline
// style; the page CSP has no 'unsafe-inline' for styles (GD-15), so server-rendered markup cannot carry style="…".
// Sizes therefore snap to the steps of globals.css (.pwa-avatar-<n>, all made from tokens); the default 44 is
// --avatar-md.
import { cx } from './cx';

export const AVATAR_SIZES = [24, 32, 40, 44, 48, 64, 96] as const;
export type AvatarSize = (typeof AVATAR_SIZES)[number];

export interface AvatarProps {
  name: string;
  src?: string;
  /** Snapped to the nearest of AVATAR_SIZES. */
  size?: number;
  /** signal ring = verified mechanic or seller */
  ring?: boolean;
  className?: string;
}

export function avatarSize(size: number): AvatarSize {
  return AVATAR_SIZES.reduce((best, s) => (Math.abs(s - size) < Math.abs(best - size) ? s : best), AVATAR_SIZES[3]);
}

export function initials(name: string): string {
  return (name || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => Array.from(w)[0] ?? '')
    .join('');
}

export function Avatar({ name, src, size = 44, ring, className }: AvatarProps) {
  const s = avatarSize(size);
  return (
    <span className={cx('cp-avatar', `pwa-avatar-${s}`, ring && 'has-ring', className)}>
      {src ? (
        // Signed media URLs from the storage host (CSP img-src); next/image would proxy them through the PWA.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" loading="lazy" decoding="async" width={s} height={s} />
      ) : (
        <span aria-hidden="true">{initials(name)}</span>
      )}
    </span>
  );
}
