// Themes of the design system: Daylight (light, default), Sunlight (sun) and Night (dark), GD-11 / P3.T3.
// The visitor's choice lives in the cp_theme cookie (light | sun | dark); no cookie = automatic: Sunlight when the
// device asks for more contrast, Night when it prefers a dark scheme, otherwise Daylight. The server renders the
// cookie's theme; for "automatic" a tiny inline script in <head> picks the theme before the first paint (no flash).
export const THEMES = ['light', 'sun', 'dark'] as const;
export type Theme = (typeof THEMES)[number];
export type ThemeChoice = Theme | 'auto';
export const THEME_CHOICES: readonly ThemeChoice[] = ['auto', ...THEMES];
export const DEFAULT_THEME: Theme = 'light';
export const THEME_COOKIE = 'cp_theme';

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === 'auto' || isTheme(value);
}

export function themeOrDefault(value: unknown): Theme {
  return isTheme(value) ? value : DEFAULT_THEME;
}

/** The choice stored in the cookie (anything else, including no cookie, is automatic). */
export function themeChoiceOf(cookie: unknown): ThemeChoice {
  return isTheme(cookie) ? cookie : 'auto';
}

/** Automatic theme from the device preferences: prefers-contrast: more → sun, prefers-color-scheme: dark → dark. */
export function autoTheme(matches: (query: string) => boolean): Theme {
  if (matches('(prefers-contrast: more)')) return 'sun';
  if (matches('(prefers-color-scheme: dark)')) return 'dark';
  return 'light';
}

export const CONTRAST_QUERY = '(prefers-contrast: more)';
export const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * Runs in <head> before the body paints, only when the server rendered data-theme-choice="auto". A constant string
 * (no request data), allowed by the page CSP through the request nonce.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var d=document.documentElement;if(d.getAttribute("data-theme-choice")!=="auto")return;var m=function(q){return window.matchMedia(q).matches};d.setAttribute("data-theme",m("${CONTRAST_QUERY}")?"sun":m("${DARK_QUERY}")?"dark":"light")}catch(e){}})();`;

/**
 * The Trusted Types 'default' policy (production CSP enforces Trusted Types, GD-15): Next.js 16.4.3's Turbopack
 * runtime assigns lazy chunk URLs to script.src without a policy, React creates <script> elements with
 * innerHTML = "<script></script>" and Next.js's error UI writes CSS text with innerHTML. The policy admits exactly
 * that: same-origin script URLs under /_next/static/ (returned unchanged — the runtime later finds its chunk scripts
 * by that exact src attribute), the empty script element, and HTML without "<" (text cannot create elements).
 * Everything else is still refused. Written without "<" outside string escapes.
 */
export const TRUSTED_TYPES_BOOT_SCRIPT = `(function(){try{var tt=window.trustedTypes;if(!tt||!tt.createPolicy||tt.defaultPolicy)return;tt.createPolicy("default",{createScriptURL:function(u){var x=new URL(u,location.href);if(x.origin===location.origin&&x.pathname.indexOf("/_next/static/")===0)return u;throw new TypeError("script URL refused")},createHTML:function(h){if(h==="\\u003cscript\\u003e\\u003c/script\\u003e"||String(h).indexOf("\\u003c")===-1)return h;throw new TypeError("HTML refused")}})}catch(e){}})();`;

/** The single inline script of every page: Trusted Types default policy first, then the automatic theme. */
export const BOOT_SCRIPT = TRUSTED_TYPES_BOOT_SCRIPT + THEME_BOOT_SCRIPT;

export const ONE_YEAR_S = 365 * 24 * 60 * 60;

/** document.cookie value that stores a choice (automatic deletes the cookie). */
export function themeCookieString(choice: ThemeChoice, secure: boolean): string {
  const attrs = `; Path=/; SameSite=Lax${secure ? '; Secure' : ''}`;
  return choice === 'auto' ? `${THEME_COOKIE}=${attrs}; Max-Age=0` : `${THEME_COOKIE}=${choice}${attrs}; Max-Age=${ONE_YEAR_S}`;
}
