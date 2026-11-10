'use client';
// Lazy MapLibre for the Locations tab (AC9.T3). Adapted from pwa/src/features/map/maplibre.ts and style.ts (P6): the
// library loads only when a location map is shown; its worker is a static file under /_next/static/, same-origin for
// worker-src 'self' and admitted by the Trusted Types default policy (src/lib/theme.ts), which allows /_next/static/
// script URLs only. Style: the URL given by the server (CARPAL_ADMIN_MAP_STYLE_URL, its origin allowed by the page's
// CSP) or — when none is set or it does not answer — a built-in style without a basemap (the pilot tile URLs are
// placeholders today, D-59): the pins, the radius circle, the keyboard and the coordinates still work.
import type { StyleSpecification } from 'maplibre-gl';
import type { GeoPoint } from '@/lib/config/geo';

type MapLibre = typeof import('maplibre-gl');

let loading: Promise<MapLibre> | null = null;

export function loadMapLibre(): Promise<MapLibre> {
  loading ??= import('maplibre-gl').then((ml) => {
    ml.setWorkerUrl(new URL('maplibre-gl/dist/maplibre-gl-worker.mjs', import.meta.url).href);
    return ml;
  });
  loading.catch(() => (loading = null));
  return loading;
}

/** WebGL is needed; without it the tab shows the coordinates and the form only. */
export function webglSupported(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return !!(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

export const RADIUS_SOURCE = 'cp-radius';
const STYLE_TIMEOUT_MS = 4_000;

export interface MapColors {
  background: string;
  radius: string;
}

export function radiusLayers(colors: MapColors): StyleSpecification['layers'] {
  return [
    { id: 'cp-radius-fill', type: 'fill', source: RADIUS_SOURCE, paint: { 'fill-color': colors.radius, 'fill-opacity': 0.12 } },
    {
      id: 'cp-radius-line',
      type: 'line',
      source: RADIUS_SOURCE,
      paint: { 'line-color': colors.radius, 'line-width': 2, 'line-dasharray': [2, 2] },
    },
  ];
}

/** The built-in style: a plain background and the radius circle (pins are DOM markers). */
export function fallbackStyle(colors: MapColors): StyleSpecification {
  return {
    version: 8,
    name: 'carpal-admin-fallback',
    sources: { [RADIUS_SOURCE]: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': colors.background } }, ...radiusLayers(colors)],
  };
}

function isStyle(v: unknown): v is StyleSpecification {
  return !!v && typeof v === 'object' && (v as { version?: unknown }).version === 8 && Array.isArray((v as { layers?: unknown }).layers);
}

const failed = new Set<string>();

/** The remote style when it answers in time with a style document, else null (a failure is remembered in memory). */
export async function loadStyle(url: string | null, doFetch: typeof fetch = fetch): Promise<StyleSpecification | null> {
  if (!url || failed.has(url)) return null;
  try {
    const res = await doFetch(url, { signal: AbortSignal.timeout(STYLE_TIMEOUT_MS), credentials: 'omit' });
    if (!res.ok) throw new Error(`style ${res.status}`);
    const json: unknown = await res.json();
    if (!isStyle(json)) throw new Error('not a style');
    return json;
  } catch {
    failed.add(url);
    return null;
  }
}

const EARTH_RADIUS_M = 6_371_008.8;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in metres (the size of a proposed move; the server computes the address distance). */
export function distanceM(a: GeoPoint, b: GeoPoint): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A circle as a closed GeoJSON ring (lng, lat): the service radius (copy of pwa geo.ts circleRing). */
export function circleRing(center: GeoPoint, radiusKm: number, steps = 48): [number, number][] {
  const ring: [number, number][] = [];
  const d = (radiusKm * 1000) / EARTH_RADIUS_M;
  const lat1 = rad(center.lat);
  const lng1 = rad(center.lng);
  for (let i = 0; i <= steps; i++) {
    const bearing = (2 * Math.PI * (i % steps)) / steps;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(bearing));
    const lng2 = lng1 + Math.atan2(Math.sin(bearing) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
    ring.push([Math.round(((lng2 * 180) / Math.PI) * 1e6) / 1e6, Math.round(((lat2 * 180) / Math.PI) * 1e6) / 1e6]);
  }
  return ring;
}
