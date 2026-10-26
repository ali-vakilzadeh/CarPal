'use client';
// The map pane of W-SRCH-01 (Docs/22 "Right: map (sticky)", ≥ 1200 px): the loaded results' locations as pins, in
// sync with the list (hovering a card highlights its pin and the other way round; a pin click brings its card into
// view), Search this area after panning (refines the session with a map_center location; the ranking rules stay),
// For my car and the layer chips (Shops, Parts sellers), Open full map (W-MAP-01 with this session) and Hide map.
// It mounts only on wide screens, so phones never load MapLibre here.
import type { MapViewport, ResultCard } from '@carpal/api-contracts';
import { useMemo, useState } from 'react';
import { Button, buttonClass } from '@/components/ds/button';
import { Chip } from '@/components/ds/chip';
import {
  MapCanvas,
  apiViewport,
  boundsOf,
  movedEnough,
  placesFromResults,
  visiblePlaces,
  type BBox,
  type MapMove,
  type Point,
} from '@/features/map';
import { useRegion } from '@/lib/config/client';
import { useT } from '@/lib/i18n/client';

export function SearchMapPane({
  results,
  sessionId,
  bestMatch,
  highlightedId,
  onHover,
  onSearchArea,
  onHide,
  fullMapHref,
  styleUrl,
  center,
  vehicle,
}: {
  results: readonly ResultCard[];
  sessionId: string;
  bestMatch: boolean;
  highlightedId: string | null;
  onHover: (id: string | null) => void;
  onSearchArea: (viewport: MapViewport) => void;
  onHide: () => void;
  fullMapHref: string;
  styleUrl: string | null;
  center: Point;
  vehicle?: { label: string; on: boolean; onToggle: (on: boolean) => void } | null;
}) {
  const t = useT();
  const region = useRegion();
  const [layers, setLayers] = useState({ shops: true, sellers: true });
  const [moved, setMoved] = useState<MapMove | null>(null);
  const places = useMemo(() => placesFromResults(results), [results]);
  const shown = useMemo(() => visiblePlaces(places, { ...layers, openNow: false, hideOthers: false }), [places, layers]);
  const bbox = useMemo(() => boundsOf(places.map((p) => p.point)), [places]);
  const searched = useMemo<{ center: Point; zoom: number; bbox: BBox } | null>(
    () => (bbox ? { center: { lat: (bbox.north + bbox.south) / 2, lng: (bbox.east + bbox.west) / 2 }, zoom: 12, bbox } : null),
    [bbox],
  );
  const maxDeg = Number(region.map.max_bbox_deg) || 0.6;
  const offerArea = !!moved?.byUser && (!searched || movedEnough(searched, moved));

  const select = (id: string) => {
    onHover(id);
    document.querySelector(`[data-location-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  return (
    <aside className="pwa-search-map" aria-label={t('search.map.paneLabel')}>
      <div className="pwa-search-map-bar">
        <Chip selected={layers.shops} onClick={() => setLayers((l) => ({ ...l, shops: !l.shops }))}>
          {t('search.map.shops')}
        </Chip>
        <Chip selected={layers.sellers} onClick={() => setLayers((l) => ({ ...l, sellers: !l.sellers }))}>
          {t('search.map.sellers')}
        </Chip>
        {vehicle ? (
          <Chip selected={vehicle.on} icon="car" onClick={() => vehicle.onToggle(!vehicle.on)}>
            {t('search.filters.forMyCar', { vehicle: vehicle.label })}
          </Chip>
        ) : null}
      </div>
      <MapCanvas
        key={sessionId}
        className="pwa-search-map-canvas"
        center={searched?.center ?? center}
        zoom={region.map.default_zoom}
        places={shown}
        bestMatch={bestMatch}
        hoveredId={highlightedId}
        selectedId={highlightedId}
        styleUrl={styleUrl}
        fit={bbox ? { key: sessionId, bbox } : null}
        label={t('search.map.label')}
        onHover={onHover}
        onSelect={select}
        onMove={setMoved}
        overlay={
          offerArea && moved ? (
            <Button
              size="sm"
              variant="primary"
              icon="search"
              onClick={() => {
                onSearchArea(apiViewport(moved.center, moved.zoom, moved.bbox, maxDeg).viewport);
                setMoved(null);
              }}
            >
              {t('search.map.searchArea')}
            </Button>
          ) : null
        }
      />
      <div className="pwa-search-map-bar">
        <a href={fullMapHref} className={buttonClass({ size: 'sm' })}>
          <span className="cp-btn-label">{t('search.map.openFull')}</span>
        </a>
        <Button size="sm" variant="ghost" onClick={onHide}>
          {t('search.map.hide')}
        </Button>
      </div>
    </aside>
  );
}
