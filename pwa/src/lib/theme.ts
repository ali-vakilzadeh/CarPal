// Themes of the design system: Daylight (light, default), Sunlight (sun) and Night (dark).
// P1 reads a manual choice from a cookie; P3.T3 adds prefers-contrast / prefers-color-scheme.
export const THEMES = ['light', 'sun', 'dark'] as const;
export type Theme = (typeof THEMES)[number];
export const DEFAULT_THEME: Theme = 'light';
export const THEME_COOKIE = 'cp_theme';

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

export function themeOrDefault(value: unknown): Theme {
  return isTheme(value) ? value : DEFAULT_THEME;
}
