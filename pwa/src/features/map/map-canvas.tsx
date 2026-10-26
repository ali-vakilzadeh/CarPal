'use client';
// The map component (P6.T3, GD-12, Docs/22 W-MAP-01, Docs/21 S-SHARED-02): MapLibre loaded on demand, the region's
// style or the built-in fallback, one DOM marker per place (a React portal: shape + icon by kind, rank numbers 1-3,
// dimmed = smaller and outlined, still a button), server clusters with counts (click zooms in), service-radius circles
// for mobile providers, zoom / recenter buttons, a legend and the attribution that is always visible.
// Keyboard: MapLibre pans with the arrow keys and zooms with + and - while the map has focus; every pin is a button in
// list order, so Tab walks through them. Controls and panels use logical properties and mirror in RTL; the map itself
// does not (the canvas is dir=ltr). When WebGL or the library fails, onFailed() lets the page show the list only.
// MapLibre's stylesheet is not loaded: map.css carries the few rules the canvas and markers need (no MapLibre
// controls or popups are used), so pages that only link to the map never download it.
import type { Map as MlMap, Marker, StyleSpecification } from 'maplibre-gl';
import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '@/components/ds/cx';
import { Icon } from '@/components/ds/icon';
import { IconButton } from '@/components/ds/icon-button';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import { circleRing, type BBox, type Point } from './geo';
import { loadMapLibre, webglSupported } from './maplibre';
import { rankLabel, type Place, type PlaceCluster } from './places';
import { RADIUS_SOURCE, fallbackStyle, loadStyle, radiusLayers, type MapColors } from './style';

export const ATTRIBUTION = '© OpenStreetMap contributors';

export interface MapMove {
  center: Point;
  zoom: number;
  bbox: BBox;
  /** true when the user moved the map (drag, wheel, keys, buttons), false for programmatic moves. */
  byUser: boolean;
}

export interface MapCanvasProps {
  /** First view (and the Recenter target unless `home` says otherwise). */
  center: Point;
  zoom: number;
  home?: { center: Point; zoom: number };
  places: readonly Place[];
  clusters?: readonly PlaceCluster[];
  selectedId?: string | null;
  hoveredId?: string | null;
  /** Number ranks 1-3 (best-match order). */
  bestMatch?: boolean;
  /** A CSP-allowed style URL (style.ts usableStyleUrl), or null for the built-in style. */
  styleUrl: string | null;
  /** Fit the view to these bounds whenever the key changes. */
  fit?: { key: string; bbox: BBox } | null;
  /** Move the view here whenever the key changes (a chosen city, the user's position). */
  focus?: { key: string; center: Point; zoom: number } | null;
  label: string;
  onSelect?: (id: string) => void;
  onHover?: (id: string | null) => void;
  onMove?: (m: MapMove) => void;
  /** The first view once the map has loaded (its real bounds). */
  onReady?: (m: MapMove) => void;
  onFailed?: () => void;
  className?: string;
  /** Extra overlay content (e.g. "Search this area"), placed above the map at the top. */
  overlay?: ReactNode;
}

type Status = 'loading' | 'ready' | 'failed';

// ---------------------------------------------------------------- markers as an external store

type Item = { id: string; point: Point };

class MarkerStore {
  readonly #els = new Map<string, HTMLElement>();
  readonly #markers = new Map<string, Marker>();
  readonly #subs = new Set<() => void>();
  #snapshot: ReadonlyMap<string, HTMLElement> = new Map();
  #map: MlMap | null = null;
  #MarkerClass: typeof Marker | null = null;

  get map(): MlMap | null {
    return this.#map;
  }

  attach(map: MlMap, MarkerClass: typeof Marker) {
    this.#map = map;
    this.#MarkerClass = MarkerClass;
  }

  detach() {
    this.clear();
    this.#map = null;
  }

  subscribe = (fn: () => void) => {
    this.#subs.add(fn);
    return () => this.#subs.delete(fn);
  };
  snapshot = () => this.#snapshot;

  /** Adds, moves and removes markers so the map shows exactly `items`, in this order (the Tab order). */
  sync(items: readonly Item[]) {
    const map = this.#map;
    const MarkerClass = this.#MarkerClass;
    if (!map || !MarkerClass) return;
    let changed = false;
    const wanted = new Set(items.map((i) => i.id));
    for (const [id, m] of this.#markers)
      if (!wanted.has(id)) {
        m.remove();
        this.#markers.delete(id);
        this.#els.delete(id);
        changed = true;
      }
    const container = map.getCanvasContainer();
    for (const item of items) {
      let marker = this.#markers.get(item.id);
      if (!marker) {
        const el = document.createElement('div');
        el.className = 'pwa-marker';
        marker = new MarkerClass({ element: el, anchor: 'center' }).setLngLat([item.point.lng, item.point.lat]).addTo(map);
        this.#markers.set(item.id, marker);
        this.#els.set(item.id, el);
        changed = true;
      } else {
        const at = marker.getLngLat();
        if (at.lat !== item.point.lat || at.lng !== item.point.lng) marker.setLngLat([item.point.lng, item.point.lat]);
      }
      container.appendChild(marker.getElement()); // keeps DOM (Tab) order = list order
    }
    if (changed) {
      this.#snapshot = new Map(this.#els);
      for (const fn of this.#subs) fn();
    }
  }

  clear() {
    for (const m of this.#markers.values()) m.remove();
    this.#markers.clear();
    this.#els.clear();
    this.#snapshot = new Map();
    for (const fn of this.#subs) fn();
  }
}

function tokenColors(): MapColors {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return { background: v('--surface-sunken', '#eef0f2'), radiusFill: v('--accent', '#1d4ed8'), radiusLine: v('--accent', '#1d4ed8') };
}

const radiusData = (places: readonly Place[]) => ({
  type: 'FeatureCollection' as const,
  features: places
    .filter((p) => p.kind === 'mobile' && p.radiusKm)
    .map((p) => ({
      type: 'Feature' as const,
      properties: { id: p.id },
      geometry: { type: 'Polygon' as const, coordinates: [circleRing(p.point, p.radiusKm!)] },
    })),
});

// ---------------------------------------------------------------- the component

export function MapCanvas(p: MapCanvasProps) {
  const t = useT();
  const f = useFormat();
  const legendId = `legend-${useId().replace(/:/g, '')}`;
  const holder = useRef<HTMLDivElement>(null);
  const [store] = useState(() => new MarkerStore());
  const [status, setStatus] = useState<Status>('loading');
  const [basemap, setBasemap] = useState<'remote' | 'fallback' | null>(null);
  const els = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const latest = useRef(p);
  /** Set by the zoom/recenter buttons: their moves count as the user's. */
  const userMove = useRef(false);
  useEffect(() => {
    latest.current = p;
  });

  // Create the map once.
  useEffect(() => {
    let cancelled = false;
    let map: MlMap | null = null;
    const failed = () => {
      if (cancelled) return;
      setStatus('failed');
      latest.current.onFailed?.();
    };
    if (!webglSupported()) {
      queueMicrotask(failed);
      return;
    }
    void (async () => {
      try {
        const [ml, remote] = await Promise.all([loadMapLibre(), loadStyle(latest.current.styleUrl)]);
        if (cancelled || !holder.current) return;
        const colors = tokenColors();
        const style: StyleSpecification = remote ?? fallbackStyle(colors);
        const { center, zoom } = latest.current;
        map = new ml.Map({
          container: holder.current,
          style,
          center: [center.lng, center.lat],
          zoom,
          attributionControl: false,
          dragRotate: false,
          pitchWithRotate: false,
          touchPitch: false,
          cooperativeGestures: false,
        });
        map.touchZoomRotate.disableRotation();
        map.keyboard.disableRotation();
        store.attach(map, ml.Marker);
        map.on('load', () => {
          if (cancelled || !map) return;
          if (!map.getSource(RADIUS_SOURCE)) {
            map.addSource(RADIUS_SOURCE, { type: 'geojson', data: radiusData(latest.current.places) });
            for (const layer of radiusLayers(colors)) map.addLayer(layer);
          }
          setBasemap(remote ? 'remote' : 'fallback');
          setStatus('ready');
        });
        map.on('error', (e) => {
          // A remote style that fails after loading (tiles, sprite) leaves the canvas usable; a failed first load does not.
          if (!map?.loaded() && remote) map?.setStyle(fallbackStyle(colors));
          console.warn('map error', e.error?.message);
        });
        const view = (byUser: boolean): MapMove => {
          const c = map!.getCenter();
          const b = map!.getBounds();
          return {
            center: { lat: c.lat, lng: c.lng },
            zoom: map!.getZoom(),
            bbox: { north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() },
            byUser,
          };
        };
        map.once('load', () => !cancelled && latest.current.onReady?.(view(false)));
        map.on('moveend', (e) => {
          if (!map) return;
          latest.current.onMove?.(view(('originalEvent' in e && !!e.originalEvent) || userMove.current));
          userMove.current = false;
        });
      } catch (err) {
        console.warn('map unavailable', err);
        failed();
      }
    })();
    return () => {
      cancelled = true;
      store.detach();
      map?.remove();
    };
  }, [store]);

  // Markers and radius circles follow the places.
  const clusters = p.clusters;
  useEffect(() => {
    if (status !== 'ready') return;
    store.sync([
      ...p.places.map((x) => ({ id: x.id, point: x.point })),
      ...(clusters ?? []).map((c) => ({ id: `c:${c.id}`, point: c.point })),
    ]);
    const src = store.map?.getSource(RADIUS_SOURCE) as { setData?: (d: unknown) => void } | undefined;
    src?.setData?.(radiusData(p.places));
  }, [status, store, p.places, clusters]);

  // Fit to bounds when asked.
  const fitKey = p.fit?.key;
  useEffect(() => {
    const map = store.map;
    const b = latest.current.fit?.bbox;
    if (status !== 'ready' || !map || !b || !fitKey) return;
    if (b.north - b.south < 1e-6 && b.east - b.west < 1e-6) map.easeTo({ center: [b.east, b.north], zoom: Math.max(map.getZoom(), 14) });
    else
      map.fitBounds(
        [
          [b.west, b.south],
          [b.east, b.north],
        ],
        { padding: 56, maxZoom: 15, duration: 0 },
      );
  }, [status, store, fitKey]);

  // Fly to a focus point when asked.
  const focusKey = p.focus?.key;
  useEffect(() => {
    const map = store.map;
    const to = latest.current.focus;
    if (status !== 'ready' || !map || !to || !focusKey) return;
    map.easeTo({ center: [to.center.lng, to.center.lat], zoom: to.zoom });
  }, [status, store, focusKey]);

  // A place selected from the list comes into view.
  const selected = p.selectedId ? p.places.find((x) => x.id === p.selectedId) : undefined;
  useEffect(() => {
    const map = store.map;
    if (status !== 'ready' || !map || !selected) return;
    if (!map.getBounds().contains([selected.point.lng, selected.point.lat]))
      map.easeTo({ center: [selected.point.lng, selected.point.lat] });
  }, [status, store, selected]);

  const zoomBy = (d: number) => {
    userMove.current = true;
    if (d > 0) store.map?.zoomIn();
    else store.map?.zoomOut();
  };
  const recenter = () => {
    const h = p.home ?? { center: p.center, zoom: p.zoom };
    userMove.current = true;
    store.map?.easeTo({ center: [h.center.lng, h.center.lat], zoom: h.zoom });
  };

  return (
    <div className={cx('pwa-map', p.className)} data-map-status={status} data-basemap={basemap ?? undefined}>
      <div ref={holder} className="pwa-map-canvas" dir="ltr" role="region" aria-label={p.label} />
      {status === 'loading' ? (
        <p className="pwa-map-loading pwa-text-caption" role="status">
          {t('search.map.loading')}
        </p>
      ) : null}
      {p.overlay ? <div className="pwa-map-overlay">{p.overlay}</div> : null}
      {status === 'ready' ? (
        <div className="pwa-map-controls">
          <IconButton icon="plus" label={t('search.map.zoomIn')} onClick={() => zoomBy(1)} />
          <IconButton icon="minus" label={t('search.map.zoomOut')} onClick={() => zoomBy(-1)} />
          <IconButton icon="locate" label={t('search.map.recenter')} onClick={recenter} />
          <IconButton icon="help" label={t('search.map.legend')} popoverTarget={legendId} aria-haspopup="dialog" />
        </div>
      ) : null}
      <Legend id={legendId} />
      <p className="pwa-map-attribution">{ATTRIBUTION}</p>
      {status === 'ready'
        ? [
            ...p.places.map((x) => {
              const el = els.get(x.id);
              return el
                ? createPortal(
                    <PinButton
                      place={x}
                      rank={rankLabel(x.rank, p.bestMatch === true)}
                      selected={x.id === p.selectedId}
                      hovered={x.id === p.hoveredId}
                      onSelect={() => p.onSelect?.(x.id)}
                      onHover={(on) => p.onHover?.(on ? x.id : null)}
                      rankText={(n) => f.number(n)}
                    />,
                    el,
                    x.id,
                  )
                : null;
            }),
            ...(clusters ?? []).map((c) => {
              const el = els.get(`c:${c.id}`);
              return el
                ? createPortal(
                    <button
                      type="button"
                      className="pwa-pin is-cluster"
                      aria-label={t('search.map.cluster', { count: c.count })}
                      onClick={() => store.map?.easeTo({ center: [c.point.lng, c.point.lat], zoom: c.expansionZoom })}
                    >
                      <span className="pwa-pin-count">{f.number(c.count)}</span>
                    </button>,
                    el,
                    `c:${c.id}`,
                  )
                : null;
            }),
          ]
        : null}
    </div>
  );
}

const KIND_ICON = { shop: 'wrench', seller: 'store', hybrid: 'wrench', mobile: 'wrench' } as const;

function PinButton({
  place,
  rank,
  selected,
  hovered,
  onSelect,
  onHover,
  rankText,
}: {
  place: Place;
  rank: number | null;
  selected: boolean;
  hovered: boolean;
  onSelect: () => void;
  onHover: (on: boolean) => void;
  rankText: (n: number) => string;
}) {
  const t = useT();
  const kind = t(`search.map.kind.${place.kind}`);
  const parts = [place.name, kind];
  if (rank) parts.push(t('search.map.rank', { rank: rankText(rank) }));
  if (place.openNow) parts.push(t('profiles.location.openNow'));
  if (place.dimmed) parts.push(t('search.map.notMatching'));
  return (
    <button
      type="button"
      className={cx('pwa-pin', `is-${place.kind}`, place.dimmed && 'is-dimmed', selected && 'is-selected', hovered && 'is-hovered')}
      aria-label={parts.join(', ')}
      aria-pressed={selected}
      data-place-id={place.id}
      onClick={onSelect}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onFocus={() => onHover(true)}
      onBlur={() => onHover(false)}
    >
      <span className="pwa-pin-shape" aria-hidden="true">
        <Icon name={KIND_ICON[place.kind]} size={18} />
        {place.kind === 'hybrid' ? <Icon name="store" size={18} /> : null}
      </span>
      {rank ? (
        <span className="pwa-pin-rank" aria-hidden="true">
          {rankText(rank)}
        </span>
      ) : null}
    </button>
  );
}

/** Map legend (Docs/21 S-SHARED-02): shape and icon carry the meaning, never colour alone. */
function Legend({ id }: { id: string }) {
  const t = useT();
  const rows: { kind: string; title: string; text: string }[] = [
    { kind: 'shop', title: t('search.map.kind.shop'), text: t('search.map.legendShop') },
    { kind: 'seller', title: t('search.map.kind.seller'), text: t('search.map.legendSeller') },
    { kind: 'hybrid', title: t('search.map.kind.hybrid'), text: t('search.map.legendHybrid') },
    { kind: 'mobile', title: t('search.map.kind.mobile'), text: t('search.map.legendMobile') },
    { kind: 'dimmed', title: t('search.map.dimmed'), text: t('search.map.legendDimmed') },
  ];
  return (
    <div id={id} popover="auto" role="dialog" className="pwa-popover" aria-labelledby={`${id}-title`}>
      <p id={`${id}-title`} className="pwa-text-label m-0">
        {t('search.map.legend')}
      </p>
      <ul className="pwa-plain-list pwa-stack-sm">
        {rows.map((r) => (
          <li key={r.kind} className="pwa-legend-row">
            <span className={cx('pwa-pin', 'is-static', r.kind === 'dimmed' ? 'is-shop is-dimmed' : `is-${r.kind}`)} aria-hidden="true">
              <span className="pwa-pin-shape">
                <Icon name={r.kind === 'seller' ? 'store' : 'wrench'} size={18} />
                {r.kind === 'hybrid' ? <Icon name="store" size={18} /> : null}
              </span>
            </span>
            <span className="pwa-stack-xs">
              <span className="pwa-text-label">{r.title}</span>
              <span className="pwa-text-caption">{r.text}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
