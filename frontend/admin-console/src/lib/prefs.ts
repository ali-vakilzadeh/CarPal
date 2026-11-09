// Language and theme links (AC4, GD-05): ?lang= and ?theme= on the current page; the proxy stores the choice in a
// cookie and redirects to the same page without the parameter, so they work without JavaScript. On a sign-in page the
// authorize request's ui_locales follows the choice (it would win over the cookie there).
export function prefHref(path: string, key: 'lang' | 'theme', value: string): string {
  const u = new URL(path || '/', 'http://console.invalid');
  u.searchParams.set(key, value);
  if (key === 'lang' && u.searchParams.has('ui_locales')) u.searchParams.set('ui_locales', value);
  return `${u.pathname}${u.search}${u.hash}`;
}
