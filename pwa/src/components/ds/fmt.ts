// Locale-aware number of the design system (bundle.js fmt): fmt(12, 'fa') → "۱۲". The richer formatters (dates,
// money, distance, digit strings) live in src/lib/format; this one keeps the bundle's signature for the components.
export function fmt(n: number, locale?: 'en' | 'fa' | (string & {})): string {
  try {
    return new Intl.NumberFormat(locale === 'fa' ? 'fa-IR' : locale || 'en-US').format(n);
  } catch {
    return String(n);
  }
}
