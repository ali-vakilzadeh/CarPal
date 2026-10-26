// Map styles (GD-12): the region's style URL (config.client region.map.style_url, overridden by
// CARPAL_PWA_MAP_STYLE_URL), or — when no style is reachable (the pilot URLs are placeholders today) — a built-in
// minimal style: a plain background and nothing else, so pins, clusters, list sync and the keyboard still work.
// No public OSM tile servers. The attribution is drawn by the page and always visible. Pure, except loadStyle().
import type { StyleSpecification } from 'maplibre-gl';

export const RADIUS_SOURCE = 'cp-radius';
export const RADIUS_FILL = 'cp-radius-fill';
export const RADIUS_LINE = 'cp-radius-line';
export const STYLE_TIMEOUT_MS = 4_000;
const FAILED_KEY = 'cp:map-style-failed';
const FAILED_TTL_MS = 10 * 60_000;

export interface MapColors {
  background: string;
  radiusFill: string;
  radiusLine: string;
}

/** The built-in style: no basemap, no glyphs or sprites (pins are DOM markers), only the radius circles. */
export function fallbackStyle(colors: MapColors): StyleSpecification {
  return {
    version: 8,
    name: 'carpal-fallback',
    sources: { [RADIUS_SOURCE]: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': colors.background } }, ...radiusLayers(colors)],
  };
}

export function radiusLayers(colors: MapColors): StyleSpecification['layers'] {
  return [
    { id: RADIUS_FILL, type: 'fill', source: RADIUS_SOURCE, paint: { 'fill-color': colors.radiusFill, 'fill-opacity': 0.12 } },
    {
      id: RADIUS_LINE,
      type: 'line',
      source: RADIUS_SOURCE,
      paint: { 'line-color': colors.radiusLine, 'line-width': 2, 'line-dasharray': [2, 2] },
    },
  ];
}

/** A style URL is used only when the page's CSP lets the browser fetch it (the server passes the allowed origins). */
export function usableStyleUrl(url: string | null | undefined, allowedOrigins: readonly string[]): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.hostname === 'localhost' || u.hostname === '127.0.0.1'
      ? allowedOrigins.includes(u.origin)
        ? u.href
        : null
      : null;
  } catch {
    return null;
  }
}

export function isStyle(v: unknown): v is StyleSpecification {
  return !!v && typeof v === 'object' && (v as { version?: unknown }).version === 8 && Array.isArray((v as { layers?: unknown }).layers);
}

function recentlyFailed(url: string, now: number): boolean {
  try {
    const f = JSON.parse(sessionStorage.getItem(FAILED_KEY) ?? 'null') as { url: string; at: number } | null;
    return !!f && f.url === url && now - f.at < FAILED_TTL_MS;
  } catch {
    return false;
  }
}

function rememberFailure(url: string, now: number): void {
  try {
    sessionStorage.setItem(FAILED_KEY, JSON.stringify({ url, at: now }));
  } catch {
    /* storage blocked: the next map tries again */
  }
}

/**
 * The style to start with: the remote style when it answers with a valid style document in time, else null (use
 * fallbackStyle). A failure is remembered for 10 minutes per tab so a dead placeholder URL is not retried on every map.
 */
export async function loadStyle(url: string | null, doFetch: typeof fetch = fetch, now = Date.now()): Promise<StyleSpecification | null> {
  if (!url || recentlyFailed(url, now)) return null;
  try {
    const res = await doFetch(url, { signal: AbortSignal.timeout(STYLE_TIMEOUT_MS), credentials: 'omit' });
    if (!res.ok) throw new Error(`style ${res.status}`);
    const json: unknown = await res.json();
    if (!isStyle(json)) throw new Error('not a style');
    return json;
  } catch {
    rememberFailure(url, now);
    return null;
  }
}
