// Port of the design system's Icon (Docs/carpal-design-system/components/bundle.js; same classes and props): 24 px
// grid, 2 px round stroke, inline SVG. The core set is the bundle's 21 glyphs; the second group is the set the
// screens need beyond it, taken from mobile/preview/js/kit.js EX (proposed DS addition, DI-21, GD-11 amendment).
import { cx } from './cx';

const CORE = {
  home: ['M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z'],
  search: ['M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14z', 'M20 20l-4-4'],
  plus: ['M12 5v14', 'M5 12h14'],
  chat: ['M4 5h16v11H9l-5 4z'],
  user: ['M12 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8z', 'M4 21c0-4 4-6 8-6s8 2 8 6'],
  heart: ['M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z'],
  comment: ['M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z'],
  share: ['M4 13v6h16v-6', 'M12 3v12', 'M7 8l5-5 5 5'],
  car: ['M3 17v-4l2.2-5.5A2 2 0 0 1 7 6h10a2 2 0 0 1 1.8 1.5L21 13v4z', 'M5 17v2', 'M19 17v2', 'M7.5 13.5h.01', 'M16.5 13.5h.01'],
  wrench: ['M14.7 6.3a4 4 0 0 0-5.2 5.2L4 17l3 3 5.5-5.5a4 4 0 0 0 5.2-5.2l-2.5 2.5-2.5-.5-.5-2.5z'],
  part: [
    'M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6z',
    'M12 2v3',
    'M12 19v3',
    'M2 12h3',
    'M19 12h3',
    'M4.9 4.9 7 7',
    'M17 17l2.1 2.1',
    'M4.9 19.1 7 17',
    'M17 7l2.1-2.1',
  ],
  store: ['M3 10l2-6h14l2 6z', 'M4 10v10h16V10', 'M10 20v-5h4v5'],
  star: ['M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3l-5.5 2.9 1-6.2L3 9.6l6.2-.9z'],
  pin: ['M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z', 'M12 7.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z'],
  back: ['M15 5l-7 7 7 7'],
  next: ['M9 5l7 7-7 7'],
  arrow: ['M5 12h14', 'M13 6l6 6-6 6'],
  more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
  check: ['M5 12.5l4.5 4.5L19 7'],
  alert: ['M12 3l10 18H2z', 'M12 10v4', 'M12 17.5h.01'],
  bell: ['M6 16V11a6 6 0 1 1 12 0v5l2 2H4z', 'M10 21h4'],
} as const;

/* proposed DS addition (mobile/preview/js/kit.js EX) */
const EXTRA = {
  close: ['M6 6l12 12', 'M18 6 6 18'],
  down: ['M6 9l6 6 6-6'],
  up: ['M6 15l6-6 6 6'],
  minus: ['M5 12h14'],
  calendar: ['M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z', 'M4 10h16', 'M8 3v4', 'M16 3v4'],
  clock: ['M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z', 'M12 7v5l3 2'],
  camera: ['M4 8h3l2-3h6l2 3h3v11H4z', 'M12 10a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7z'],
  video: ['M3 7h12v10H3z', 'M15 10.5 21 7v10l-6-3.5z'],
  image: ['M4 5h16v14H4z', 'M4 16l5-5 4 4 3-3 4 4', 'M15.5 8.5h.01'],
  doc: ['M6 3h8l4 4v14H6z', 'M14 3v4h4', 'M9 12h6', 'M9 16h6'],
  shield: ['M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6z', 'M8.5 12l2.5 2.5 4.5-5'],
  info: ['M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z', 'M12 11v5', 'M12 7.5h.01'],
  help: ['M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z', 'M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.4', 'M12 16.5h.01'],
  lock: ['M6 11h12v10H6z', 'M8 11V8a4 4 0 0 1 8 0v3'],
  eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', 'M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6z'],
  phone: ['M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1z'],
  mic: ['M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z', 'M5 11a7 7 0 0 0 14 0', 'M12 18v3'],
  globe: [
    'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z',
    'M3 12h18',
    'M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9',
    'M12 3c-2.5 2.5-3.5 5.5-3.5 9s1 6.5 3.5 9',
  ],
  spark: ['M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z', 'M19 15l.7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7z'],
  download: ['M12 4v11', 'M7 10l5 5 5-5', 'M4 20h16'],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13'],
  edit: ['M4 20h4L19 9l-4-4L4 16z', 'M13.5 6.5l4 4'],
  flag: ['M5 21V4', 'M5 4h12l-2 4 2 4H5'],
  filter: ['M4 5h16l-6 8v6l-4-2v-4z'],
  sliders: ['M4 7h9', 'M17 7h3', 'M15 5v4', 'M4 17h3', 'M11 17h9', 'M9 15v4'],
  map: ['M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z', 'M9 4v14', 'M15 6v14'],
  list: ['M9 6h11', 'M9 12h11', 'M9 18h11', 'M4.5 6h.01', 'M4.5 12h.01', 'M4.5 18h.01'],
  logout: ['M10 4H5v16h5', 'M14 8l4 4-4 4', 'M18 12H9'],
  refresh: ['M20 11a8 8 0 1 0-2.3 5.7', 'M20 4v7h-7'],
  offline: ['M2 8.5a15 15 0 0 1 20 0', 'M5.5 12a10 10 0 0 1 13 0', 'M9 15.5a5 5 0 0 1 6 0', 'M12 19h.01', 'M3 3l18 18'],
  scan: ['M4 8V4h4', 'M16 4h4v4', 'M20 16v4h-4', 'M8 20H4v-4', 'M7 12h10'],
  gauge: ['M3.5 18a8.5 8.5 0 1 1 17 0', 'M12 17l4-5.5', 'M12 17h.01'],
  bookmark: ['M6 3h12v18l-6-4-6 4z'],
  thumb: ['M7 11v9H4v-9z', 'M7 11l4-8a2.5 2.5 0 0 1 2.5 2.5V9h5.2a2 2 0 0 1 2 2.4l-1.5 7A2 2 0 0 1 17.2 20H7'],
  truck: ['M2 6h12v10H2z', 'M14 10h4l3 3.5V16h-7', 'M6.5 15a2 2 0 1 1 0 4 2 2 0 0 1 0-4z', 'M17 15a2 2 0 1 1 0 4 2 2 0 0 1 0-4z'],
  copy: ['M8 8h12v12H8z', 'M16 8V4H4v12h4'],
  send: ['M4 12 20 4l-4 16-4-7z', 'M12 13l8-9'],
  grid: ['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z'],
  sun: [
    'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8z',
    'M12 2v2',
    'M12 20v2',
    'M2 12h2',
    'M20 12h2',
    'M4.9 4.9l1.4 1.4',
    'M17.7 17.7l1.4 1.4',
    'M4.9 19.1l1.4-1.4',
    'M17.7 6.3l1.4-1.4',
  ],
  moon: ['M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z'],
  locate: ['M12 5a7 7 0 1 1 0 14 7 7 0 0 1 0-14z', 'M12 2v3', 'M12 19v3', 'M2 12h3', 'M19 12h3'],
  attach: ['M20 11.5l-8 8a5 5 0 0 1-7-7l8.5-8.5a3.5 3.5 0 0 1 5 5L10 17.5a2 2 0 0 1-3-3l7.5-7.5'],
  building: ['M4 21V5h10v16', 'M14 9h6v12', 'M2 21h20', 'M8 9h2', 'M8 13h2', 'M8 17h2'],
  tag: ['M3 12V4h8l10 10-8 8z', 'M7.5 7.5h.01'],
  route: ['M6 19a2 2 0 1 1 0-4 2 2 0 0 1 0 4z', 'M18 9a2 2 0 1 1 0-4 2 2 0 0 1 0 4z', 'M8 17h7a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h7'],
} as const;

const PATHS: Record<IconName, readonly string[]> = { ...CORE, ...EXTRA };

export type CoreIconName = keyof typeof CORE;
export type IconName = CoreIconName | keyof typeof EXTRA;
export const ICON_NAMES = Object.keys(PATHS) as IconName[];

/** Direction-bearing glyphs mirror under dir="rtl"; everything else (logos, media controls) never does. */
export const MIRRORED_ICONS: ReadonlySet<IconName> = new Set<IconName>(['back', 'next', 'arrow', 'chat', 'comment', 'send', 'logout']);

export interface IconProps {
  name: IconName;
  size?: number;
  filled?: boolean;
  /** Give a label only when the icon stands alone and carries meaning. */
  label?: string;
  className?: string;
}

export function Icon({ name, size = 24, filled = false, label, className }: IconProps) {
  return (
    <svg
      className={cx('cp-icon', MIRRORED_ICONS.has(name) && 'cp-flip', filled && 'cp-icon-filled', className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
      focusable="false"
    >
      {(PATHS[name] ?? PATHS.home).map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
