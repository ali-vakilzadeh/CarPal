// Port of the design system's Icon (Docs/carpal-design-system/components/bundle.js; same classes and props).
// P1 carries only the glyphs the placeholder pages use; P3.T1 completes the set, including the mobile/preview
// additions (DI-21) such as shield, doc and globe below.
const PATHS = {
  car: ['M3 17v-4l2.2-5.5A2 2 0 0 1 7 6h10a2 2 0 0 1 1.8 1.5L21 13v4z', 'M5 17v2', 'M19 17v2', 'M7.5 13.5h.01', 'M16.5 13.5h.01'],
  wrench: ['M14.7 6.3a4 4 0 0 0-5.2 5.2L4 17l3 3 5.5-5.5a4 4 0 0 0 5.2-5.2l-2.5 2.5-2.5-.5-.5-2.5z'],
  check: ['M5 12.5l4.5 4.5L19 7'],
  /* proposed design-system additions (mobile/preview/js/kit.js EX) */
  shield: ['M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6z', 'M8.5 12l2.5 2.5 4.5-5'],
  doc: ['M6 3h8l4 4v14H6z', 'M14 3v4h4', 'M9 12h6', 'M9 16h6'],
  globe: [
    'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z',
    'M3 12h18',
    'M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9',
    'M12 3c-2.5 2.5-3.5 5.5-3.5 9s1 6.5 3.5 9',
  ],
} as const;

export type IconName = keyof typeof PATHS;

/** Direction-bearing glyphs mirror under dir="rtl" (back, next, arrow, chat, comment, send, logout); none in this set yet. */
const FLIP: ReadonlySet<IconName> = new Set<IconName>();

export interface IconProps {
  name: IconName;
  size?: number;
  filled?: boolean;
  /** Give a label only when the icon stands alone and carries meaning. */
  label?: string;
  className?: string;
}

export function Icon({ name, size = 24, filled = false, label, className }: IconProps) {
  const classes = ['cp-icon', FLIP.has(name) && 'cp-flip', filled && 'cp-icon-filled', className].filter(Boolean).join(' ');
  return (
    <svg
      className={classes}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
      focusable="false"
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
