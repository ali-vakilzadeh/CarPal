// Navigation destinations of the shell (Docs/22 §2.3 left navigation, Docs/21 §2.1 bottom tab bar). Paths are
// relative to /<locale>; the screens behind them arrive in their stages (placeholders until then).
import type { IconName } from '@/components/ds/icon';
import type { MessageKey } from '@/lib/i18n/keys';

export interface NavItem {
  id: string;
  path: string;
  icon: IconName;
  label: MessageKey;
}

/** Left navigation, signed in (Docs/22 §2.3), in order. */
export const LEFT_NAV: readonly NavItem[] = [
  { id: 'home', path: '/home', icon: 'home', label: 'shell.nav.home' },
  { id: 'discover', path: '/search', icon: 'search', label: 'shell.nav.discover' },
  { id: 'garage', path: '/garage', icon: 'car', label: 'shell.nav.garage' },
  { id: 'help', path: '/help', icon: 'wrench', label: 'shell.nav.helpMe' },
  { id: 'appointments', path: '/appointments', icon: 'calendar', label: 'shell.nav.appointments' },
  { id: 'questions', path: '/questions', icon: 'chat', label: 'shell.nav.communityQa' },
  { id: 'saved', path: '/saved', icon: 'bookmark', label: 'shell.nav.saved' },
  { id: 'notifications', path: '/notifications', icon: 'bell', label: 'shell.nav.notifications' },
  { id: 'settings', path: '/settings', icon: 'sliders', label: 'shell.nav.settings' },
];

/** Bottom tab bar on phones, signed in (Docs/21 §2.1 order; mirrored in RTL by the layout). */
export const TABS: readonly NavItem[] = [
  { id: 'discover', path: '/home', icon: 'home', label: 'shell.nav.discover' },
  { id: 'garage', path: '/garage', icon: 'car', label: 'shell.nav.garage' },
  { id: 'help', path: '/help', icon: 'plus', label: 'shell.nav.helpMe' },
  { id: 'appointments', path: '/appointments', icon: 'calendar', label: 'shell.nav.appointments' },
  { id: 'community', path: '/questions', icon: 'chat', label: 'shell.nav.community' },
];

/** Guest menu on phones: public destinations only. */
export const GUEST_NAV: readonly NavItem[] = [
  { id: 'discover', path: '/search', icon: 'search', label: 'shell.nav.discover' },
  { id: 'map', path: '/map', icon: 'map', label: 'shell.header.browseOnMap' },
  { id: 'help', path: '/help', icon: 'wrench', label: 'shell.nav.helpMe' },
  { id: 'questions', path: '/questions', icon: 'chat', label: 'shell.nav.communityQa' },
];

/** The item whose path is the start of the current path (without the locale), if any. */
export function activeItem(items: readonly NavItem[], pathname: string): string | null {
  const rest = pathname.replace(/^\/[a-z]{2}(?=\/|$)/, '') || '/';
  const hit = items.find((i) => rest === i.path || rest.startsWith(`${i.path}/`));
  return hit?.id ?? null;
}

/** Same page in the other language: /fa/garage?x=1 → /en/garage?x=1 (Docs/22 principle 8). */
export function switchLocalePath(pathname: string, search: string, to: string): string {
  const rest = pathname.replace(/^\/[a-z]{2}(?=\/|$)/, '');
  return `/${to}${rest}${search ? (search.startsWith('?') ? search : `?${search}`) : ''}`;
}
