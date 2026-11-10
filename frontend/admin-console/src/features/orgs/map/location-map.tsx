'use client';
// The map of one location (AC9.T3, Docs/23 A-ORG-02 Locations): the owner's pin, the service radius circle and — while
// staff correct the location — the proposed pin, which follows a click on the map or a drag of the proposed pin. The
// map is never the only way: the coordinates are typed in the form next to it (the keyboard alternative), and without
// WebGL or the library the tab says so and keeps the form. MapLibre pans with the arrow keys and zooms with + and -
// while the canvas has focus; the zoom buttons are real buttons. Pins are DOM markers with a role and a label; shape
// and text tell them apart, never colour alone. The canvas stays dir=ltr (maps do not mirror); controls mirror in RTL.
import type { GeoJSONSource, Map as MlMap, Marker, StyleSpecification } from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';
import { IconButton } from '@/components/ds/icon-button';
import { LOCATION_ZOOM, REGION_MAP, type GeoPoint } from '@/lib/config/geo';
import { useT } from '@/lib/i18n/client';
import {
  circleRing,
  fallbackStyle,
  loadMapLibre,
  loadStyle,
  RADIUS_SOURCE,
  radiusLayers,
  webglSupported,
  type MapColors,
} from './maplibre';

export interface LocationMapProps {
  /** The owner's pin (or the current admin-corrected one). */
  pin: GeoPoint | null;
  /** The proposed new pin while correcting. */
  proposed?: GeoPoint | null;
  radiusKm?: number | null;
  /** Clicks and drags propose a new pin. */
  editable?: boolean;
  onPropose?: (p: GeoPoint) => void;
  /** A CSP-allowed style URL, or null for the built-in style. */
  styleUrl: string | null;
  label: string;
}

type Status = 'loading' | 'ready' | 'failed';

function colors(): MapColors {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return { background: v('--surface-sunken', '#eef0f2'), radius: v('--accent', '#1d4ed8') };
}

function markerElement(kind: 'pin' | 'proposed', label: string): HTMLElement {
  const el = document.createElement('div');
  el.className = `adm-marker adm-marker-${kind}`;
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', label);
  return el;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export function LocationMap(p: LocationMapProps) {
  const t = useT();
  const holder = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const markers = useRef<{ pin: Marker | null; proposed: Marker | null; Marker: typeof Marker | null }>({
    pin: null,
    proposed: null,
    Marker: null,
  });
  const [status, setStatus] = useState<Status>('loading');
  const [basemap, setBasemap] = useState<'remote' | 'fallback' | null>(null);
  const latest = useRef(p);
  useEffect(() => {
    latest.current = p;
  });

  // Create the map once.
  useEffect(() => {
    let cancelled = false;
    let map: MlMap | null = null;
    if (!webglSupported()) {
      queueMicrotask(() => !cancelled && setStatus('failed'));
      return;
    }
    void (async () => {
      try {
        const [ml, remote] = await Promise.all([loadMapLibre(), loadStyle(latest.current.styleUrl)]);
        if (cancelled || !holder.current) return;
        const c = colors();
        const style: StyleSpecification = remote ?? fallbackStyle(c);
        const start = latest.current.pin ?? REGION_MAP.center;
        map = new ml.Map({
          container: holder.current,
          style,
          center: [start.lng, start.lat],
          zoom: latest.current.pin ? LOCATION_ZOOM : REGION_MAP.zoom,
          attributionControl: false,
          dragRotate: false,
          pitchWithRotate: false,
          touchPitch: false,
        });
        map.touchZoomRotate.disableRotation();
        map.keyboard.disableRotation();
        markers.current.Marker = ml.Marker;
        mapRef.current = map;
        map.on('load', () => {
          if (cancelled || !map) return;
          if (!map.getSource(RADIUS_SOURCE)) {
            map.addSource(RADIUS_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
            for (const layer of radiusLayers(c)) map.addLayer(layer);
          }
          setBasemap(remote ? 'remote' : 'fallback');
          setStatus('ready');
        });
        map.on('click', (e) => {
          if (!latest.current.editable) return;
          latest.current.onPropose?.({ lat: round6(e.lngLat.lat), lng: round6(e.lngLat.lng) });
        });
        map.on('error', (e) => {
          if (!map?.loaded() && remote) map?.setStyle(fallbackStyle(c));
          console.warn('map error', e.error?.message);
        });
      } catch (err) {
        console.warn('map unavailable', err);
        if (!cancelled) setStatus('failed');
      }
    })();
    return () => {
      cancelled = true;
      markers.current = { pin: null, proposed: null, Marker: null };
      mapRef.current = null;
      map?.remove();
    };
  }, []);

  // The owner's pin and the radius circle.
  const pinKey = p.pin ? `${p.pin.lat},${p.pin.lng}` : '';
  const radius = p.radiusKm ?? 0;
  useEffect(() => {
    const map = mapRef.current;
    const M = markers.current.Marker;
    if (status !== 'ready' || !map || !M) return;
    const pin = latest.current.pin;
    markers.current.pin?.remove();
    markers.current.pin = pin
      ? new M({ element: markerElement('pin', t('admin.orgs.map.pin')), anchor: 'bottom' }).setLngLat([pin.lng, pin.lat]).addTo(map)
      : null;
    const src = map.getSource(RADIUS_SOURCE) as GeoJSONSource | undefined;
    src?.setData({
      type: 'FeatureCollection',
      features:
        pin && radius > 0
          ? [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [circleRing(pin, radius)] } }]
          : [],
    });
    if (pin) map.jumpTo({ center: [pin.lng, pin.lat] });
  }, [status, pinKey, radius, t]);

  // The proposed pin (draggable while editing).
  const proposedKey = p.proposed ? `${p.proposed.lat},${p.proposed.lng}` : '';
  const editable = !!p.editable;
  useEffect(() => {
    const map = mapRef.current;
    const M = markers.current.Marker;
    if (status !== 'ready' || !map || !M) return;
    const at = latest.current.proposed;
    if (!at) {
      markers.current.proposed?.remove();
      markers.current.proposed = null;
      return;
    }
    let m = markers.current.proposed;
    if (!m) {
      m = new M({ element: markerElement('proposed', t('admin.orgs.map.proposed')), anchor: 'bottom', draggable: editable })
        .setLngLat([at.lng, at.lat])
        .addTo(map);
      m.on('dragend', () => {
        const ll = markers.current.proposed?.getLngLat();
        if (ll) latest.current.onPropose?.({ lat: round6(ll.lat), lng: round6(ll.lng) });
      });
      markers.current.proposed = m;
    } else {
      m.setLngLat([at.lng, at.lat]);
      m.setDraggable(editable);
    }
    if (!map.getBounds().contains([at.lng, at.lat])) map.easeTo({ center: [at.lng, at.lat] });
  }, [status, proposedKey, editable, t]);

  const zoom = (d: number) => (d > 0 ? mapRef.current?.zoomIn() : mapRef.current?.zoomOut());
  const recenter = () => {
    const at = latest.current.proposed ?? latest.current.pin;
    if (at) mapRef.current?.easeTo({ center: [at.lng, at.lat], zoom: LOCATION_ZOOM });
  };

  return (
    <div className="adm-map" data-map-status={status} data-basemap={basemap ?? undefined} data-testid="location-map">
      <div ref={holder} className="adm-map-canvas" dir="ltr" role="region" aria-label={p.label} />
      {status === 'loading' ? (
        <p className="adm-map-note adm-muted" role="status">
          {t('admin.orgs.map.loading')}
        </p>
      ) : null}
      {status === 'failed' ? (
        <p className="adm-map-note" role="status" data-testid="map-failed">
          {t('admin.orgs.map.failed')}
        </p>
      ) : null}
      {status === 'ready' ? (
        <div className="adm-map-controls">
          <IconButton icon="plus" label={t('admin.orgs.map.zoomIn')} onClick={() => zoom(1)} />
          <IconButton icon="minus" label={t('admin.orgs.map.zoomOut')} onClick={() => zoom(-1)} />
          <IconButton icon="locate" label={t('admin.orgs.map.recenter')} onClick={recenter} />
        </div>
      ) : null}
      {basemap === 'fallback' ? <p className="adm-map-basemap adm-muted">{t('admin.orgs.map.noBasemap')}</p> : null}
      <p className="adm-map-attribution">{REGION_MAP.attribution}</p>
    </div>
  );
}
