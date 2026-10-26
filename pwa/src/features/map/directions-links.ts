// Directions links (P6.T5, Docs/90 S-SHARED-10, Docs/22 W-MAP-01 "Directions on the web"): the region's map apps for
// the web platform, plus the phone's own map app on Android/iOS. A link carries the destination only — never the
// user's position or any id. The remembered app is the account's navigation_app_key when signed in (must be in the
// region list) and the cp_nav cookie otherwise; the device link is never remembered (not a region key). Pure.
import type { RegionConfig } from '@carpal/api-contracts';

export const NAV_COOKIE = 'cp_nav';
export const DEVICE_APP = 'device';
const ONE_YEAR_S = 365 * 24 * 60 * 60;
const KEY = /^[a-z0-9_.-]{1,40}$/;

export type DevicePlatform = 'android' | 'ios' | null;

export interface DirectionsApp {
  key: string;
  label: string;
  href: string;
  /** The phone's map app (not from the region list). */
  device?: boolean;
}

const coord = (v: number) => v.toFixed(6).replace(/\.?0+$/, '');

/** A navigation app link: {lat} and {lng} of the template filled with the point (six decimals at most). */
export function directionsUrl(template: string, point: { lat: number; lng: number }): string {
  return template.replaceAll('{lat}', coord(point.lat)).replaceAll('{lng}', coord(point.lng));
}

/** The phone's map app: geo: on Android, Apple Maps on iOS. */
export function deviceUrl(platform: Exclude<DevicePlatform, null>, point: { lat: number; lng: number }): string {
  const ll = `${coord(point.lat)},${coord(point.lng)}`;
  return platform === 'android' ? `geo:${ll}?q=${ll}` : `https://maps.apple.com/?daddr=${ll}`;
}

/** Android / iOS from the user agent (phones and tablets); null on desktops. */
export function devicePlatform(userAgent: string, maxTouchPoints = 0): DevicePlatform {
  if (/Android/i.test(userAgent)) return 'android';
  if (/iPhone|iPad|iPod/i.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1)) return 'ios';
  return null;
}

/** The apps of the Directions menu, the remembered one first. */
export function directionsApps(
  region: Pick<RegionConfig, 'navigation_apps'>,
  point: { lat: number; lng: number },
  o: { platform: DevicePlatform; remembered: string | null; deviceLabel: string },
): DirectionsApp[] {
  const apps: DirectionsApp[] = region.navigation_apps
    .filter((a) => a.platforms.includes('web'))
    .map((a) => ({ key: a.key, label: a.label.text, href: directionsUrl(a.url_template, point) }));
  if (o.platform) apps.unshift({ key: DEVICE_APP, label: o.deviceLabel, href: deviceUrl(o.platform, point), device: true });
  const i = o.remembered ? apps.findIndex((a) => a.key === o.remembered) : -1;
  if (i > 0) apps.unshift(...apps.splice(i, 1));
  return apps;
}

/** The remembered app when it is still in the region list (an app removed from the list makes the menu ask again). */
export function rememberedApp(region: Pick<RegionConfig, 'navigation_apps'>, key: string | null | undefined): string | null {
  if (!key || !KEY.test(key)) return null;
  return region.navigation_apps.some((a) => a.key === key && a.platforms.includes('web')) ? key : null;
}

export function readNavCookie(cookie: string): string | null {
  const m = new RegExp(`(?:^|;\\s*)${NAV_COOKIE}=([^;]*)`).exec(cookie);
  const v = m ? decodeURIComponent(m[1]!) : '';
  return KEY.test(v) ? v : null;
}

export function navCookieString(key: string | null, secure: boolean): string {
  const attrs = `; Path=/; SameSite=Lax${secure ? '; Secure' : ''}`;
  return key ? `${NAV_COOKIE}=${encodeURIComponent(key)}${attrs}; Max-Age=${ONE_YEAR_S}` : `${NAV_COOKIE}=${attrs}; Max-Age=0`;
}
