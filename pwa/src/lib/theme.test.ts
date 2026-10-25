import { describe, expect, it } from 'vitest';
import {
  BOOT_SCRIPT,
  THEME_BOOT_SCRIPT,
  TRUSTED_TYPES_BOOT_SCRIPT,
  autoTheme,
  isThemeChoice,
  themeChoiceOf,
  themeCookieString,
  themeOrDefault,
} from './theme';

describe('theme choice', () => {
  it('reads the cookie: a theme, or automatic for anything else', () => {
    expect(themeChoiceOf('dark')).toBe('dark');
    expect(themeChoiceOf(undefined)).toBe('auto');
    expect(themeChoiceOf('neon')).toBe('auto');
    expect(isThemeChoice('auto')).toBe(true);
    expect(themeOrDefault('auto')).toBe('light');
  });

  it('automatic: more contrast → Sunlight, dark scheme → Night, else Daylight', () => {
    expect(autoTheme((q) => q.includes('contrast'))).toBe('sun');
    expect(autoTheme((q) => q.includes('contrast') || q.includes('dark'))).toBe('sun');
    expect(autoTheme((q) => q.includes('dark'))).toBe('dark');
    expect(autoTheme(() => false)).toBe('light');
  });

  it('writes or deletes the cookie', () => {
    expect(themeCookieString('sun', true)).toBe('cp_theme=sun; Path=/; SameSite=Lax; Secure; Max-Age=31536000');
    expect(themeCookieString('auto', false)).toBe('cp_theme=; Path=/; SameSite=Lax; Max-Age=0');
  });

  it('boot script is a constant without markup-breaking characters', () => {
    expect(BOOT_SCRIPT).not.toContain('<');
    expect(BOOT_SCRIPT.startsWith(TRUSTED_TYPES_BOOT_SCRIPT)).toBe(true);
    expect(THEME_BOOT_SCRIPT).toContain('data-theme-choice');
  });

  it('the Trusted Types default policy admits same-origin chunks and markup-free HTML only', () => {
    let policy: { createScriptURL: (u: string) => string; createHTML: (h: string) => string } | undefined;
    const fakeWindow = { trustedTypes: { createPolicy: (_name: string, rules: typeof policy) => (policy = rules) } };
    new Function('window', 'location', TRUSTED_TYPES_BOOT_SCRIPT)(fakeWindow, {
      href: 'https://carpal.app/fa',
      origin: 'https://carpal.app',
    });
    // Unchanged: the Turbopack runtime finds its chunk scripts by the src attribute it set.
    expect(policy!.createScriptURL('/_next/static/chunks/a.js')).toBe('/_next/static/chunks/a.js');
    expect(() => policy!.createScriptURL('https://evil.example/_next/static/a.js')).toThrow();
    expect(() => policy!.createScriptURL('/api/v1/x')).toThrow();
    expect(policy!.createHTML('<script></script>')).toBe('<script></script>');
    expect(policy!.createHTML(':root { --x: 1 }')).toBe(':root { --x: 1 }');
    expect(() => policy!.createHTML('<img src=x onerror=alert(1)>')).toThrow();
  });
});
