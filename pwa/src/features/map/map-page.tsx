'use client';
// W-MAP-01 Map view, full page (P6.T4; Docs/22 W-MAP-01, Docs/90 + Docs/21 S-SHARED-02, 54 §5.5). /<locale>/map,
// not indexed. Top bar: query field with "Understood as" chips, car chip, For [car], layer chips Shops / Parts
// sellers, Open now, Advanced search (highlight, not filter, with "7 match · 14 others" and Hide others). Left: the
// places in the current view as result cards (rank order; "Sorted by closeness to the map centre" after Search this
// area). Centre: the map. Selected pin: a card with Request appointment or Ask about part, Directions and View.
// Data: the list is a search session for the area (search.run / search.refine with a map_center location; opened from
// W-SRCH-01 it starts with that session) and the pins are map.pins for the same viewport and session (ranks, reason
// summaries, highlight and vehicle relevance; ≤ 300 pins + clusters). map.pins runs when the area is searched, not on
// every pan (RL map). States: location unknown (the chosen city), no results, the vehicle filter leaving fewer than 3
// places (Show all nearby), map failed (the list only), offline. Keys: L shows/hides the list; the map's own keys pan
// and zoom; Tab walks the list and the pins.
import type { IntentChip, LocationInput, MapQuery, SearchFilters, SearchRequest } from '@carpal/api-contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Badge } from '@/components/ds/badge';
import { Banner } from '@/components/ds/banner';
import { Button, buttonClass } from '@/components/ds/button';
import { Chip } from '@/components/ds/chip';
import { cx } from '@/components/ds/cx';
import { IconButton } from '@/components/ds/icon-button';
import { useActiveVehicle, useVehicleLabel } from '@/components/shell/active-vehicle';
import { useGatedAction, useIntentHandler } from '@/components/shell/auth-intent';
import { Dialog } from '@/components/shell/dialog';
import { isTypingTarget } from '@/components/shell/search-box';
import { StateView, stateFromProblem } from '@/components/shell/states';
import { useToast } from '@/components/shell/toast';
import { VehicleChip } from '@/components/shell/vehicle-context';
import { RatingLine, requestHref, saveSearchOrigin } from '@/features/profiles';
import {
  EMPTY_URL_STATE,
  FilterPanel,
  GuestCarChip,
  LocationChip,
  QueryField,
  ResultCardView,
  SafetyNotice,
  UnderstoodAs,
  buildRequest,
  readStoredSearch,
  refined,
  resultHref,
  sessionKey,
  useGuestCarLabel,
  useResultEvent,
  useSearchActions,
  withChip,
  withoutChip,
  type RefineBody,
  type SearchView,
} from '@/features/search';
import { useAnalytics } from '@/lib/analytics/client';
import { ApiProblem } from '@/lib/api/problem';
import { useApiQuery } from '@/lib/api/query';
import { useSession } from '@/lib/api/session';
import { goTo } from '@/lib/browser-nav';
import { useFlag, useRegion } from '@/lib/config/client';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { sellerPath } from '@/lib/seo/urls';
import { DirectionsMenu } from './directions';
import { apiViewport, bboxAround, boundsOf, distanceM, movedEnough, type BBox, type Point } from './geo';
import { MapCanvas, type MapMove } from './map-canvas';
import {
  clustersFrom,
  highlightCounts,
  listOrder,
  mergePlaces,
  placesFromPins,
  placesFromResults,
  visiblePlaces,
  type Place,
} from './places';

type Area = { center: Point; zoom: number; bbox: BBox };

export interface MapScreenProps {
  center: Point;
  zoom: number;
  /** The business location the page was opened on (profile "Open the map"). */
  focusPlaceId: string | null;
  /** The search session the page was opened with ("Open full map" on W-SRCH-01). */
  sessionParam: string | null;
  styleUrl: string | null;
  privacyVersion: string;
  defaultCity: string;
  /** Where the visitor came from (map.opened entry_point). */
  entry: 'search' | 'profile' | 'map';
  /** true when the centre is only the default city (location unknown). */
  cityFallback: boolean;
}

const LIST_ONLY_SPAN_DEG = 0.3;
/** Result cards per searched area (the list; search.run allows 50). */
const AREA_LIMIT = 50;

function subscribeOnline(fn: () => void) {
  window.addEventListener('online', fn);
  window.addEventListener('offline', fn);
  return () => {
    window.removeEventListener('online', fn);
    window.removeEventListener('offline', fn);
  };
}

export function MapScreen(p: MapScreenProps) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const region = useRegion();
  const toast = useToast();
  const queryClient = useQueryClient();
  const session = useSession();
  const signedIn = session.data?.signed_in === true;
  const { active, isLoading: vehiclesLoading } = useActiveVehicle();
  const activeLabel = useVehicleLabel(active);
  const mapOn = useFlag('map.enabled');
  const actions = useSearchActions();
  const resultEvent = useResultEvent();
  const gate = useGatedAction();
  const { track } = useAnalytics();
  const online = useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
  const maxDeg = Number(region.map.max_bbox_deg) || 0.6;
  const opts = useMemo(() => ({ signedIn, fallbackCity: p.defaultCity }), [signedIn, p.defaultCity]);

  // The session this page was opened with (W-SRCH-01 "Open full map"), if this tab still has it.
  const [view, setView] = useState<SearchView | null>(() => {
    if (!p.sessionParam) return null;
    return queryClient.getQueryData<SearchView>(sessionKey(p.sessionParam)) ?? null;
  });
  const [area, setArea] = useState<Area | null>(null);
  const [moved, setMoved] = useState<MapMove | null>(null);
  const [byDistance, setByDistance] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiProblem | null>(null);
  const [mapFailed, setMapFailed] = useState(false);
  const [listOpen, setListOpen] = useState(true);
  const [layers, setLayers] = useState({ shops: true, sellers: true });
  const [openNow, setOpenNow] = useState(false);
  const [advanced, setAdvanced] = useState<SearchFilters>({});
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [hideOthers, setHideOthers] = useState(false);
  const [vehicleFilter, setVehicleFilter] = useState(true);
  const [carFilters, setCarFilters] = useState<SearchFilters>(() => {
    const r = view?.request.filters;
    return r?.brand_node_id ? { brand_node_id: r.brand_node_id, model_node_id: r.model_node_id, series_node_id: r.series_node_id } : {};
  });
  const [carOpen, setCarOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(p.focusPlaceId);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ key: string; center: Point; zoom: number } | null>(null);
  const [location, setLocation] = useState<LocationInput>({ mode: 'chosen_city', city_key: p.defaultCity });
  const searchAfterMove = useRef(false);
  const guestCar = useGuestCarLabel(carFilters);
  const vehicleId = signedIn ? (active?.id ?? null) : null;
  const vehicleLabel = signedIn ? activeLabel : guestCar;
  const hasVehicle = !!(vehicleId || carFilters.brand_node_id);
  const ready = session.isFetched && session.dataUpdatedAt > 0 && (!signedIn || !vehiclesLoading);

  useEffect(() => {
    track('map.opened', { entry_point: p.entry });
  }, [track, p.entry]);

  // ------------------------------------------------------------ the list search for an area
  const searchArea = useCallback(
    async (a: Area, o: { text?: string; intent?: SearchRequest['intent_override'] | null; vehicleFilterOn?: boolean } = {}) => {
      const viewport = apiViewport(a.center, a.zoom, a.bbox, maxDeg).viewport;
      const loc: LocationInput = { mode: 'map_center', viewport };
      setBusy(true);
      setFailure(null);
      try {
        const filters = { ...(view?.request.filters ?? {}), ...carFilters };
        const textChanged = o.text !== undefined && o.text !== (view?.request.query_text ?? '');
        if (view && !textChanged && (view.request.vehicle_id ?? null) === vehicleId) {
          const body: RefineBody = { location: loc, filters };
          if (o.intent) body.intent_override = o.intent;
          if (o.vehicleFilterOn !== undefined) body.vehicle_filter_applied = o.vehicleFilterOn;
          const r = await actions.refine(view.response.session_id, view.request, body);
          setView({ response: r, request: refined(view.request, body) });
        } else {
          const request: SearchRequest = {
            ...buildRequest(
              {
                text: o.text ?? view?.request.query_text ?? '',
                location: loc,
                vehicleId,
                entry: 'map',
                ...(o.intent ? { intentOverride: o.intent } : {}),
              },
              {
                ...EMPTY_URL_STATE,
                mode: view && view.request.search_mode !== 'showcases' ? view.request.search_mode : 'all',
                filters,
                vehicleFilter: o.vehicleFilterOn ?? vehicleFilter,
              },
              opts,
            ),
            limit: AREA_LIMIT,
          };
          const r = await actions.run(request, { started: o.text !== undefined });
          setView({ response: r, request });
        }
        setArea(a);
        setMoved(null);
        setByDistance(true);
      } catch (err) {
        setFailure(err instanceof ApiProblem ? err : new ApiProblem(0, {}));
      } finally {
        setBusy(false);
      }
    },
    [maxDeg, view, carFilters, vehicleId, vehicleFilter, actions, opts],
  );

  // A session from "Open full map" that the cache lost (reload): run its stored text for the first area.
  const firstArea = useRef(false);
  const startArea = useCallback(
    (a: Area) => {
      if (firstArea.current) return;
      firstArea.current = true;
      if (view) {
        setArea(a);
        return;
      }
      const stored = p.sessionParam ? readStoredSearch(p.sessionParam)?.request : undefined;
      void searchArea(a, stored?.query_text ? { text: stored.query_text } : {});
    },
    [view, searchArea, p.sessionParam],
  );

  const sessionPlaces = useMemo(() => (view ? placesFromResults(view.response.results) : []), [view]);
  const fitBox = useMemo(
    () => (p.sessionParam && !p.focusPlaceId ? boundsOf(sessionPlaces.map((x) => x.point)) : null),
    [p.sessionParam, p.focusPlaceId, sessionPlaces],
  );

  // List-only mode (no WebGL or the map failed): search the default area without the canvas.
  useEffect(() => {
    if (!mapFailed || !ready || firstArea.current) return;
    queueMicrotask(() => startArea({ center: p.center, zoom: p.zoom, bbox: bboxAround(p.center, LIST_ONLY_SPAN_DEG) }));
  }, [mapFailed, ready, startArea, p.center, p.zoom]);

  const onReady = (m: MapMove) => {
    if (fitBox) return; // the fit's own move starts the area
    if (ready) startArea(m);
    else setMoved(m);
  };
  const onMove = (m: MapMove) => {
    if (!m.byUser && !firstArea.current && ready) startArea(m);
    else if (!m.byUser && searchAfterMove.current) {
      searchAfterMove.current = false;
      void searchArea(m);
    } else setMoved(m);
  };
  // Started before the session was known (the first view came early): start now.
  useEffect(() => {
    if (!ready || firstArea.current || !moved) return;
    queueMicrotask(() => startArea(moved));
  }, [ready, moved, startArea]);

  // ------------------------------------------------------------ pins for the searched area
  const layerList = [...(layers.shops ? (['providers'] as const) : []), ...(layers.sellers ? (['vendors'] as const) : [])];
  const pinQuery: MapQuery | null = area
    ? {
        viewport: apiViewport(area.center, area.zoom, area.bbox, maxDeg).viewport,
        layers: layerList,
        ...(view ? { search_session_id: view.response.session_id } : {}),
        ...(vehicleId ? { vehicle_id: vehicleId } : {}),
        ...(hasVehicle ? { vehicle_filter_applied: vehicleFilter } : {}),
        ...(Object.keys({ ...advanced, ...carFilters }).length ? { filters: { ...advanced, ...carFilters } } : {}),
      }
    : null;
  const pins = useApiQuery('map.pins', pinQuery ? { body: pinQuery } : undefined, {
    enabled: !!pinQuery && mapOn && layerList.length > 0 && online,
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });
  const results = useMemo(() => view?.response.results ?? [], [view]);
  // Pins on the map: map.pins (clustered by the server); the list: every result card of the area plus unclustered pins.
  const resultPlaces = useMemo(() => placesFromResults(results), [results]);
  const pinPlaces = useMemo(() => (pins.data && mapOn ? placesFromPins(pins.data.pins, results) : null), [pins.data, mapOn, results]);
  const places = pinPlaces ?? resultPlaces;
  const listed = useMemo(() => mergePlaces(resultPlaces, pinPlaces ?? []), [resultPlaces, pinPlaces]);
  const shown = useMemo(() => visiblePlaces(places, { ...layers, openNow, hideOthers }), [places, layers, openNow, hideOthers]);
  const ordered = useMemo(
    () => listOrder(visiblePlaces(listed, { ...layers, openNow, hideOthers }), area?.center ?? p.center, byDistance),
    [listed, layers, openNow, hideOthers, area, p.center, byDistance],
  );
  const clusters = useMemo(() => (pins.data && mapOn ? clustersFrom(pins.data.clusters) : []), [pins.data, mapOn]);
  const counts = highlightCounts(listed);
  const advancedOn = Object.keys(advanced).length > 0;
  const relevantCount = listed.filter((x) => x.relevant === true).length;
  const fallback = hasVehicle && vehicleFilter && (pins.data?.vehicle_filter_fallback ?? view?.response.vehicle_filter_fallback ?? false);
  const selected = selectedId ? (listed.find((x) => x.id === selectedId) ?? null) : null;

  // ------------------------------------------------------------ keyboard: L toggles the list
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'l' || e.key === 'L') && !e.ctrlKey && !e.metaKey && !e.altKey && !isTypingTarget(e.target)) {
        e.preventDefault();
        setListOpen((v) => !v);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const choose = (id: string) => {
    setSelectedId(id);
    const place = listed.find((x) => x.id === id);
    track('map.pin_selected', { target_type: 'location', rank: Math.min(1000, place?.rank ?? 0) });
    document.querySelector(`[data-place-card="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  const toggleVehicle = (on: boolean, showAll = false) => {
    setVehicleFilter(on);
    track('map.vehicle_filter_toggled', { enabled: on, show_all_nearby: showAll });
    if (area && view) void searchArea(area, { vehicleFilterOn: on });
  };

  const changeLocation = (loc: LocationInput) => {
    setLocation(loc);
    const center =
      loc.mode === 'chosen_city'
        ? region.cities.find((c) => c.city_key === loc.city_key)?.center
        : loc.mode === 'user_position'
          ? loc.point
          : null;
    if (!center) return;
    if (mapFailed) {
      void searchArea({ center, zoom: region.map.default_zoom, bbox: bboxAround(center, LIST_ONLY_SPAN_DEG) });
      return;
    }
    searchAfterMove.current = true;
    setFocus({ key: `${Date.now()}`, center, zoom: loc.mode === 'user_position' ? 14 : region.map.default_zoom });
  };

  useIntentHandler<{ location?: string | null; slug?: string | null }>('request', (intent) => {
    if (intent.target)
      goTo(requestHref(locale, intent.target, intent.draft?.location ?? null, undefined, { slug: intent.draft?.slug, via: 'search' }));
  });
  const request = (place: Place) => {
    const r = place.result;
    gate({
      type: 'request',
      target: place.orgId,
      draft: { location: place.id, slug: r?.organization.slug ?? null },
      title: t('profiles.intent.request', { name: place.name }),
      run: () => {
        if (r && view) {
          saveSearchOrigin({ orgId: place.orgId, sessionId: view.response.session_id, resultId: r.result_id });
          resultEvent(view.response.session_id, r.result_id, 'selected');
        }
        goTo(requestHref(locale, place.orgId, place.id, undefined, { slug: r?.organization.slug, via: 'search' }));
      },
    });
  };

  const offerArea = !!moved?.byUser && !!area && movedEnough(area, moved);
  const intent = view?.response.interpreted_intent;

  return (
    <div className={cx('pwa-map-page', 'pwa-wide-page', !listOpen && 'is-list-hidden', mapFailed && 'is-list-only')} aria-busy={busy}>
      <h1 className="sr-only">{t('search.map.title')}</h1>
      <header className="pwa-map-top">
        <QueryField
          key={view?.response.session_id ?? 'none'}
          initial={view?.request.query_text ?? ''}
          busy={busy}
          onSubmit={(text) => area && void searchArea(area, { text, intent: null })}
        />
        <div className="pwa-search-context">
          {signedIn ? (
            <VehicleChip />
          ) : (
            <GuestCarChip
              filters={carFilters}
              open={carOpen}
              onOpenChange={setCarOpen}
              onChange={(car) => {
                setCarFilters(car.brand_node_id ? car : {});
                track('map.vehicle_filter_toggled', { enabled: !!car.brand_node_id, show_all_nearby: false });
              }}
            />
          )}
          {hasVehicle ? (
            <Chip selected={vehicleFilter} icon="car" onClick={() => toggleVehicle(!vehicleFilter)}>
              {t('search.filters.forMyCar', { vehicle: vehicleLabel ?? t('search.vehicle.yourCar') })}
            </Chip>
          ) : null}
          <Chip selected={layers.shops} onClick={() => setLayers((l) => ({ ...l, shops: !l.shops }))}>
            {t('search.map.shops')}
          </Chip>
          <Chip selected={layers.sellers} onClick={() => setLayers((l) => ({ ...l, sellers: !l.sellers }))}>
            {t('search.map.sellers')}
          </Chip>
          <Chip selected={openNow} icon="clock" onClick={() => setOpenNow((v) => !v)}>
            {t('search.filters.openNow')}
          </Chip>
          <Chip selected={advancedOn} icon="sliders" toggle={false} onClick={() => setAdvancedOpen(true)}>
            {t('search.map.advanced')}
          </Chip>
          <LocationChip value={location} region={region} policyVersion={p.privacyVersion} onChange={changeLocation} />
          {!mapFailed ? (
            <Button
              size="sm"
              variant="ghost"
              icon="list"
              aria-pressed={listOpen}
              aria-keyshortcuts="L"
              onClick={() => setListOpen((v) => !v)}
            >
              {t(listOpen ? 'search.map.hideList' : 'search.map.showList')}
            </Button>
          ) : null}
        </div>
        {intent && intent.chips.length > 1 ? (
          <UnderstoodAs
            intent={intent}
            disabled={busy || !area}
            onRemove={(i, c: IntentChip) => {
              track('search.chip_edited', { chip_type: c.kind });
              if (area) void searchArea(area, { intent: withoutChip(intent, i) });
            }}
            onAdd={(c) => {
              track('search.chip_edited', { chip_type: c.kind });
              if (area) void searchArea(area, { intent: withChip(intent, c) });
            }}
          />
        ) : null}
        {advancedOn ? (
          <div className="pwa-inline-actions" role="status">
            <span className="pwa-text-caption">
              {t('search.map.highlightCount', { matching: f.number(counts.matching), others: f.number(counts.others) })}
            </span>
            <label className="pwa-filter-row">
              <input type="checkbox" checked={hideOthers} onChange={(e) => setHideOthers(e.target.checked)} />
              <span>{t('search.map.hideOthers')}</span>
            </label>
          </div>
        ) : null}
      </header>

      {!online ? <Banner tone="warn" icon="offline" text={t('search.map.offline')} /> : null}
      {view ? <SafetyNotice safety={view.response.safety} /> : null}
      {p.cityFallback && location.mode === 'chosen_city' && !p.sessionParam ? (
        <p className="pwa-text-caption">
          {t('search.map.cityFallback', {
            city: region.cities.find((c) => c.city_key === location.city_key)?.label.text ?? location.city_key,
          })}
        </p>
      ) : null}
      {mapFailed ? <Banner tone="info" icon="map" title={t('search.map.failedTitle')} text={t('search.map.failedText')} /> : null}
      {fallback ? (
        <Banner
          tone="warn"
          icon="car"
          title={t('search.map.fewForCar', { count: relevantCount, vehicle: vehicleLabel ?? t('search.vehicle.yourCar') })}
          text={t('search.vehicle.fallbackText')}
        >
          <div className="pwa-banner-actions">
            <Button size="sm" onClick={() => toggleVehicle(false, true)}>
              {t('search.vehicle.showAll')}
            </Button>
          </div>
        </Banner>
      ) : null}
      {failure ? (
        <StateView
          kind={stateFromProblem(failure)}
          t={t}
          compact
          action={
            <Button size="sm" onClick={() => area && void searchArea(area)}>
              {t('common.actions.retry')}
            </Button>
          }
        />
      ) : null}

      <div className="pwa-map-layout">
        <section className="pwa-map-list" aria-labelledby="places-title" hidden={!listOpen && !mapFailed}>
          <div className="pwa-section-head">
            <h2 id="places-title" className="pwa-text-label m-0">
              {t('search.map.placesInView', { count: ordered.length })}
            </h2>
          </div>
          {byDistance ? <p className="pwa-text-caption m-0">{t('search.map.sortedByCentre')}</p> : null}
          {area && !busy && ordered.length === 0 ? (
            <StateView kind="empty" t={t} compact title={t('search.map.nothingHere')} text={t('search.map.zoomOut')} />
          ) : (
            <ol className="pwa-plain-list pwa-results" aria-label={t('search.map.placesLabel')}>
              {ordered.map((x) => (
                <li
                  key={x.id}
                  data-place-card={x.id}
                  onMouseEnter={() => setHoveredId(x.id)}
                  onMouseLeave={() => setHoveredId(null)}
                  onClick={(e) => {
                    if (!(e.target as HTMLElement).closest('a, button')) choose(x.id);
                  }}
                >
                  <PlaceCard
                    place={x}
                    highlighted={x.id === selectedId || x.id === hoveredId}
                    center={area?.center ?? p.center}
                    onRequest={() => request(x)}
                  />
                </li>
              ))}
            </ol>
          )}
        </section>
        {!mapFailed ? (
          <div className="pwa-map-main">
            <MapCanvas
              center={p.center}
              zoom={p.zoom}
              places={shown}
              clusters={clusters}
              selectedId={selectedId}
              hoveredId={hoveredId}
              bestMatch={view?.request.sort === undefined || view?.request.sort === 'best_match'}
              styleUrl={p.styleUrl}
              fit={fitBox ? { key: `session-${p.sessionParam}`, bbox: fitBox } : null}
              focus={focus}
              label={t('search.map.label')}
              onSelect={choose}
              onHover={setHoveredId}
              onMove={onMove}
              onReady={onReady}
              onFailed={() => setMapFailed(true)}
              overlay={
                offerArea && moved ? (
                  <Button size="sm" variant="primary" icon="search" loading={busy} onClick={() => void searchArea(moved)}>
                    {t('search.map.searchArea')}
                  </Button>
                ) : null
              }
            />
            {selected ? (
              <SelectedPlace
                place={selected}
                center={area?.center ?? p.center}
                onClose={() => setSelectedId(null)}
                onRequest={() => request(selected)}
              />
            ) : null}
          </div>
        ) : null}
      </div>

      <Dialog
        open={advancedOpen}
        onClose={() => setAdvancedOpen(false)}
        title={t('search.map.advanced')}
        variant="drawer"
        name="map-filters"
      >
        <FilterPanel idPrefix="mf" mode="all" filters={advanced} onChange={setAdvanced} highlight />
        <Button
          variant="primary"
          block
          onClick={() => {
            setAdvancedOpen(false);
            if (!mapOn) toast(t('search.map.highlightUnavailable'));
          }}
        >
          {t('search.map.highlight', { count: counts.matching })}
        </Button>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------- cards

function PlaceCard({
  place,
  highlighted,
  center,
  onRequest,
}: {
  place: Place;
  highlighted: boolean;
  center: Point;
  onRequest: () => void;
}) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  if (place.result)
    return (
      <div className={cx('pwa-place', place.dimmed && 'is-dimmed')}>
        <ResultCardView
          r={place.result}
          locale={locale}
          t={t}
          f={f}
          highlighted={highlighted}
          bestMatch
          actions={<PlaceActions place={place} onRequest={onRequest} />}
        />
      </div>
    );
  return (
    <article className={cx('pwa-result', 'pwa-place', highlighted && 'is-highlighted', place.dimmed && 'is-dimmed')}>
      <div className="pwa-result-body">
        <h3 className="pwa-text-label m-0" dir="auto">
          {place.name}
        </h3>
        <span className="pwa-text-caption">
          {t(`search.map.kind.${place.kind}` as MessageKey)} · {f.distance(distanceM(center, place.point))}
        </span>
        {place.rating ? <RatingLine value={place.rating} count={1} t={t} f={f} /> : null}
        <span className="pwa-badges">
          {place.openNow ? (
            <Badge tone="success" icon="clock">
              {t('profiles.location.openNow')}
            </Badge>
          ) : null}
          {place.itemCount ? <Badge icon="part">{t('search.result.partsFit', { count: place.itemCount })}</Badge> : null}
        </span>
        {place.reason ? (
          <p className="pwa-result-reason m-0" dir="auto">
            {place.reason}
          </p>
        ) : null}
        <div className="pwa-result-actions">
          <PlaceActions place={place} onRequest={onRequest} />
        </div>
      </div>
    </article>
  );
}

function PlaceActions({ place, onRequest }: { place: Place; onRequest: () => void }) {
  const t = useT();
  const locale = useLocale();
  const r = place.result;
  const slug = r?.organization.slug ?? null;
  const shop = place.kind !== 'seller';
  return (
    <>
      {shop ? (
        <Button size="sm" variant="primary" onClick={onRequest}>
          {t('profiles.request.request')}
        </Button>
      ) : slug ? (
        <a href={`${sellerPath(locale, slug)}#parts`} className={buttonClass({ size: 'sm', variant: 'primary' })}>
          <span className="cp-btn-label">{t('search.result.askAboutPart')}</span>
        </a>
      ) : null}
      <DirectionsMenu point={place.point} name={place.name} approximate={place.approximate} address={r?.location?.city ?? null} size="sm" />
      {r && resultHref(r, locale) ? (
        <a href={resultHref(r, locale)!} className={buttonClass({ size: 'sm', variant: 'ghost' })}>
          <span className="cp-btn-label">{t('search.map.view')}</span>
        </a>
      ) : null}
    </>
  );
}

function SelectedPlace({ place, center, onClose, onRequest }: { place: Place; center: Point; onClose: () => void; onRequest: () => void }) {
  const t = useT();
  const f = useFormat();
  return (
    <section className="pwa-map-selected" aria-labelledby={`sel-${place.id}`} aria-live="polite">
      <div className="pwa-section-head">
        <h2 id={`sel-${place.id}`} className="pwa-text-label m-0" dir="auto">
          {place.name}
        </h2>
        <IconButton icon="close" label={t('common.actions.close')} onClick={onClose} />
      </div>
      <span className="pwa-text-caption">
        {t(`search.map.kind.${place.kind}` as MessageKey)} · {f.distance(distanceM(center, place.point))}
        {place.openNow ? ` · ${t('profiles.location.openNow')}` : ''}
      </span>
      {place.result ? (
        <RatingLine value={place.result.organization.overall_rating} count={place.result.organization.review_count} t={t} f={f} />
      ) : null}
      {place.badge ? <Badge>{t(`profiles.badge.${place.badge}.label` as MessageKey)}</Badge> : null}
      {place.reason ? (
        <p className="pwa-result-reason m-0" dir="auto">
          {place.reason}
        </p>
      ) : null}
      {place.approximate ? <p className="pwa-text-caption m-0">{t('profiles.location.approximateText')}</p> : null}
      <div className="pwa-result-actions">
        <PlaceActions place={place} onRequest={onRequest} />
      </div>
    </section>
  );
}
