'use client';
// Lazy MapLibre (GD-12): the library loads only where a map is shown, with a dynamic import. Its worker is emitted by
// the bundler as a static file under /_next/static/ (new URL(…, import.meta.url)), so it is same-origin for
// worker-src 'self' and passes the Trusted Types default policy (src/lib/theme.ts), which admits /_next/static/ script
// URLs only — no blob: worker and no extra policy (P6 finding; the P3 note expected one).
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

/** WebGL is needed; without it the pages show the list only (Docs/22 W-MAP-01 "map failed to load"). */
export function webglSupported(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return !!(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    return false;
  }
}
