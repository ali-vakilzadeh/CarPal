// Public media (P5.T7, BA-06): signed URLs from the media host in a fixed aspect-ratio box, so nothing shifts while
// images load; lazy by default, eager with high fetch priority for the one image that is the page's LCP candidate.
// A missing URL (still private until moderation, not servable for this viewer, or a video in lite) renders the same
// box with an icon and a short label. Plain <img>: the URLs are short-lived signed links on another origin, so the
// Next.js image optimizer would only add a hop; the media host has no width variants beyond the thumbnail, so the
// thumbnail is chosen by `variant` instead of srcset. Server-renderable (no hooks).
import { cx } from '@/components/ds/cx';
import { Icon, type IconName } from '@/components/ds/icon';

export type MediaAspect = 'wide' | 'photo' | 'square';

export interface MediaImageProps {
  url: string | null | undefined;
  thumbnailUrl?: string | null;
  /** 'thumb' prefers the thumbnail (grids, cards); 'full' the full image (galleries, sliders). */
  variant?: 'thumb' | 'full';
  alt: string;
  aspect?: MediaAspect;
  width?: number | null;
  height?: number | null;
  /** The page's largest image above the fold. */
  priority?: boolean;
  /** Shown in the placeholder (e.g. "Photo being reviewed"). */
  placeholder: string;
  placeholderIcon?: IconName;
  className?: string;
}

export function MediaImage({
  url,
  thumbnailUrl,
  variant = 'full',
  alt,
  aspect = 'photo',
  width,
  height,
  priority,
  placeholder,
  placeholderIcon = 'image',
  className,
}: MediaImageProps) {
  const src = (variant === 'thumb' ? (thumbnailUrl ?? url) : (url ?? thumbnailUrl)) ?? null;
  return (
    <span className={cx('pwa-media', `is-${aspect}`, className)}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- signed media-host URLs (see the header comment)
        <img
          src={src}
          alt={alt}
          {...(width && height ? { width, height } : {})}
          loading={priority ? 'eager' : 'lazy'}
          decoding="async"
          {...(priority ? { fetchPriority: 'high' as const } : {})}
          referrerPolicy="no-referrer"
        />
      ) : (
        <span className="pwa-media-placeholder">
          <Icon name={placeholderIcon} size={32} />
          <span className="pwa-text-caption">{placeholder}</span>
        </span>
      )}
    </span>
  );
}
