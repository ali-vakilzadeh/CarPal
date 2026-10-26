// Map configuration for pages and the CSP (GD-12, P6.T3). The style URL is CARPAL_PWA_MAP_STYLE_URL, else
// config.client region.map.style_url. The browser may fetch styles and tiles only from origins the page CSP lists
// (img-src/connect-src); the proxy builds that list without a backend call, so it names the env override and the
// pilot region file's style and tile URLs. A live config.client URL outside the list is not used (the built-in style
// is): change the region file or the env together with the tile build.
import 'server-only';
import type { RegionConfig } from '@carpal/api-contracts';
import region from '@carpal/region-config/ir-pilot.json';
import { usableStyleUrl } from '@/features/map/style';
import { originsOf } from './security-headers';
import { serverEnv } from './env';

/** Origins of the map style and tiles that the page CSP admits. */
export function mapTileOrigins(env: { CARPAL_PWA_MAP_STYLE_URL?: string | undefined } = serverEnv()): string[] {
  return originsOf(env.CARPAL_PWA_MAP_STYLE_URL, region.map.style_url, region.map.tiles_url);
}

/** The style URL a page hands to the map component, or null for the built-in style. */
export function mapStyleUrl(regionConfig: Pick<RegionConfig, 'map'>): string | null {
  const env = serverEnv();
  return usableStyleUrl(env.CARPAL_PWA_MAP_STYLE_URL ?? regionConfig.map.style_url, mapTileOrigins(env));
}
