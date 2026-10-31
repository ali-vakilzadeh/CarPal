// The web app manifest (P12.T1), one per locale (/manifests/<locale>.webmanifest): names in the page language,
// start_url and scope of that locale, standalone display, colours from the design-system tokens (Metal_black
// background, the light theme's surface as the bar colour) and the icons drawn by tools/make-icons.mjs from the
// type-set logo (Docs/carpal-design-system README "Logo": "CarPal" in Atkinson Hyperlegible Next 800, White on
// Metal_black). Pure; the route src/app/manifests/[file]/route.ts serves it.
import type { Locale } from '@/lib/i18n/locales';

/** tokens.css: --Metal_black (the logo's ground) and the light/dark surfaces for the browser bar. */
export const THEME_COLORS = { brand: '#0c1136', light: '#ffffff', dark: '#0c1136' } as const;

export const MANIFEST_ICONS = [
  { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
] as const;

const NAMES: Record<Locale, { name: string; short_name: string; description: string }> = {
  en: {
    name: 'CarPal',
    short_name: 'CarPal',
    description: 'Find a trusted repair shop, keep your car’s service history and get help when something is wrong.',
  },
  fa: {
    name: 'کارپال',
    short_name: 'کارپال',
    description: 'تعمیرگاه مطمئن پیدا کنید، سابقهٔ سرویس خودرو را نگه دارید و وقتی مشکلی پیش آمد کمک بگیرید.',
  },
};

export function manifestFor(locale: Locale) {
  const n = NAMES[locale];
  return {
    id: '/',
    name: n.name,
    short_name: n.short_name,
    description: n.description,
    lang: locale,
    dir: locale === 'fa' ? 'rtl' : 'ltr',
    start_url: `/${locale}?source=pwa`,
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: THEME_COLORS.brand,
    theme_color: THEME_COLORS.light,
    categories: ['auto', 'lifestyle', 'utilities'],
    icons: MANIFEST_ICONS,
  };
}
