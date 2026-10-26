'use client';
// W-SRCH-01 Search results with map (P6.T1/T2; Docs/22 W-SRCH-01, Docs/21 S-SHARED-01 + C-SEARCH-01, Docs/90
// S-SHARED-01..03, Docs/01 Flow 5). Two routes:
//   /<locale>/search            — the hand-over from the header search, the landing hero and recent searches
//                                 (sessionStorage cp:pending-search, GD-14): runs search.run, then replaces the URL with
//                                 the session's. Without a pending search it is the search entry (field, recent searches,
//                                 Browse on map).
//   /<locale>/search/<session>  — the results: query field, car chip, location chip, mode tabs, "Understood as" chips,
//                                 sort; the safety banner; the filter panel (column from 1200 px, drawer below); the
//                                 result cards with reasons, 20 per page (search.page); the map pane from 1200 px.
// Every change refines the session (or runs a new one for a new mode, text or car) and pushes a new URL, so Back goes
// to the previous results. Free text, coordinates and map areas never enter a URL (TR-7).
import type { IntentChip, LocationInput, SearchFilters, SearchRequest } from '@carpal/api-contracts';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Badge } from '@/components/ds/badge';
import { Banner } from '@/components/ds/banner';
import { Button, buttonClass } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { useActiveVehicle, useVehicleLabel } from '@/components/shell/active-vehicle';
import { Dialog } from '@/components/shell/dialog';
import { PENDING_SEARCH_EVENT, PENDING_SEARCH_KEY, type PendingSearch } from '@/components/shell/search-box';
import { SkeletonList } from '@/components/shell/skeleton';
import { StateView, stateFromProblem } from '@/components/shell/states';
import { useToast } from '@/components/shell/toast';
import { useUrlModal } from '@/components/shell/url-modal';
import { VEHICLE_MODAL, VehicleChip } from '@/components/shell/vehicle-context';
import { saveHelpDraft } from '@/features/onboarding';
import { useAnalytics } from '@/lib/analytics/client';
import { ApiProblem } from '@/lib/api/problem';
import { useSession } from '@/lib/api/session';
import { useFlag, useRegion } from '@/lib/config/client';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import { WIDE, useMediaQuery } from '@/lib/media-query';
import { UnderstoodAs } from './chips';
import { FilterPanel } from './filter-panel';
import { LocationChip } from './location';
import { SearchMapPane } from './map-pane';
import { QnaResults } from './qna';
import {
  EMPTY_URL_STATE,
  activeFilterCount,
  buildRequest,
  changeOf,
  looksLikeSymptom,
  parseUrlState,
  searchPath,
  switchedToParts,
  withChip,
  withoutChip,
  type SearchContext,
  type UrlState,
} from './request';
import { ResultList } from './results';
import { GuestCarChip, ModeTabs, QueryField, SortSelect, useGuestCarLabel } from './search-bar';
import { EmptyResults, SafetyNotice, VehicleFallback, VehicleMissing } from './search-states';
import { RecentSearches } from './recent';
import { addRecent } from './storage';
import { asGuest, useSafetyFallback, useSearchActions, useSearchPages, useSearchView, type SearchView } from './use-search';

const PENDING_MAX_AGE_MS = 30 * 60_000;

export interface SearchScreenProps {
  sessionId: string | null;
  /** Privacy policy version named in the location_usage consent. */
  privacyVersion: string;
  /** A CSP-allowed map style URL, or null for the built-in style (GD-12). */
  styleUrl: string | null;
  /** The chosen city (?city / cp_city cookie) or the region's first city. */
  defaultCity: string;
}

function subscribePending(fn: () => void) {
  window.addEventListener(PENDING_SEARCH_EVENT, fn);
  return () => window.removeEventListener(PENDING_SEARCH_EVENT, fn);
}

function readPendingRaw(): string | null {
  try {
    return sessionStorage.getItem(PENDING_SEARCH_KEY);
  } catch {
    return null;
  }
}

export function parsePending(raw: string | null, now = Date.now()): PendingSearch | null {
  try {
    const p = JSON.parse(raw ?? 'null') as PendingSearch | null;
    return p && typeof p.text === 'string' && typeof p.at === 'number' && now - p.at < PENDING_MAX_AGE_MS ? p : null;
  } catch {
    return null;
  }
}

/** The non-URL parts of a stored request. */
export function contextOf(req: SearchRequest): SearchContext {
  return {
    text: req.query_text ?? '',
    location: req.location,
    vehicleId: req.vehicle_id ?? null,
    entry: req.entry_point,
    ...(req.intent_override ? { intentOverride: req.intent_override } : {}),
  };
}

/** The URL state a pending search starts with (its car as filters, its city). */
export function pendingUrlState(p: PendingSearch, defaultCity: string): UrlState {
  const f: SearchFilters = {};
  if (p.vehicle?.brand_node_id) {
    f.brand_node_id = p.vehicle.brand_node_id;
    if (p.vehicle.model_node_id) f.model_node_id = p.vehicle.model_node_id;
    if (p.vehicle.series_node_id) f.series_node_id = p.vehicle.series_node_id;
  }
  return { ...EMPTY_URL_STATE, city: p.city ?? defaultCity, filters: f };
}

export function SearchScreen({ sessionId, privacyVersion, styleUrl, defaultCity }: SearchScreenProps) {
  const locale = useLocale();
  const router = useRouter();
  const params = useSearchParams();
  const region = useRegion();
  const session = useSession();
  const signedIn = session.data?.signed_in === true;
  const { active, isLoading: vehiclesLoading } = useActiveVehicle();
  const qnaOn = useFlag('qna.enabled');
  const actions = useSearchActions();
  const cities = useMemo(() => region.cities.map((c) => c.city_key), [region.cities]);
  const paramString = params.toString();
  const url = useMemo(() => {
    const s = parseUrlState(new URLSearchParams(paramString), cities);
    return !qnaOn && s.mode === 'qna' ? { ...s, mode: 'all' as const } : s;
  }, [paramString, cities, qnaOn]);
  // A server-seeded session that the browser has not confirmed yet (dataUpdatedAt 0) may be the wrong one (P2 notes).
  const ready = session.isFetched && session.dataUpdatedAt > 0 && (!signedIn || !vehiclesLoading);
  const opts = useMemo(() => ({ signedIn, fallbackCity: defaultCity }), [signedIn, defaultCity]);

  // ------------------------------------------------------------ /search: run the hand-over
  const pendingRaw = useSyncExternalStore(
    subscribePending,
    () => (sessionId ? null : readPendingRaw()),
    () => null,
  );
  const [typed, setTyped] = useState<PendingSearch | null>(null);
  const stored = useMemo(() => parsePending(pendingRaw), [pendingRaw]);
  const pending = typed ?? stored;
  const [runFailed, setRunFailed] = useState<ApiProblem | null>(null);
  const started = useRef<number | null>(null);
  const startPending = useCallback(() => {
    if (!pending) return;
    const s = pendingUrlState(pending, defaultCity);
    const ctx: SearchContext = {
      text: pending.text,
      location: { mode: 'chosen_city', city_key: s.city! },
      vehicleId: active?.id ?? null,
      entry: 'search_box',
    };
    addRecent({ text: pending.text, ...(pending.node ? { node: pending.node } : {}) });
    actions.run(buildRequest(ctx, s, opts), { started: true, fromHome: pending.entry === 'home' }).then(
      (r) => {
        try {
          sessionStorage.removeItem(PENDING_SEARCH_KEY);
        } catch {
          /* ignore */
        }
        router.replace(searchPath(locale, r.session_id, s));
      },
      (err: unknown) => setRunFailed(err instanceof ApiProblem ? err : new ApiProblem(0, {})),
    );
  }, [pending, defaultCity, active, actions, opts, router, locale]);
  useEffect(() => {
    if (sessionId || !ready || !pending || started.current === pending.at) return;
    started.current = pending.at;
    startPending();
  }, [sessionId, ready, pending, startPending]);

  // ------------------------------------------------------------ /search/<session>: the results
  const recover = useCallback(
    (stored: SearchRequest | null) =>
      buildRequest(
        stored
          ? contextOf(stored)
          : {
              text: '',
              location: { mode: 'chosen_city', city_key: url.city ?? defaultCity },
              vehicleId: active?.id ?? null,
              entry: 'search_box',
            },
        url,
        opts,
      ),
    [url, defaultCity, active, opts],
  );
  const view = useSearchView(sessionId, recover, { ready, fallbackCity: defaultCity });
  const current = view.data;
  const newId = current?.response.session_id;
  useEffect(() => {
    if (sessionId && newId && newId !== sessionId) router.replace(searchPath(locale, newId, url));
  }, [sessionId, newId, router, locale, url]);

  if (!sessionId) {
    if (!pending)
      return (
        <SearchEntry
          onSearch={(p) => {
            savePending(p);
            setTyped(p);
          }}
        />
      );
    if (runFailed) return <RunFailed error={runFailed} text={pending.text} onRetry={startPending} />;
    return <SearchLoading text={pending.text} />;
  }
  if (view.isError) return <RunFailed error={view.error} text="" onRetry={() => void view.refetch()} />;
  if (!current || newId !== sessionId) return <SearchLoading text="" />;
  return (
    <SearchResults
      key={sessionId}
      view={current}
      url={url}
      opts={opts}
      privacyVersion={privacyVersion}
      styleUrl={styleUrl}
      activeVehicleId={active?.id ?? null}
      vehiclesReady={!signedIn || !vehiclesLoading}
      qnaOn={qnaOn}
    />
  );
}

// ---------------------------------------------------------------- results

function SearchResults({
  view,
  url,
  opts,
  privacyVersion,
  styleUrl,
  activeVehicleId,
  vehiclesReady,
  qnaOn,
}: {
  view: SearchView;
  url: UrlState;
  opts: { signedIn: boolean; fallbackCity: string };
  privacyVersion: string;
  styleUrl: string | null;
  activeVehicleId: string | null;
  vehiclesReady: boolean;
  qnaOn: boolean;
}) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const router = useRouter();
  const region = useRegion();
  const toast = useToast();
  const { track } = useAnalytics();
  const actions = useSearchActions();
  const wide = useMediaQuery(WIDE);
  const vehicleModal = useUrlModal(VEHICLE_MODAL);
  const { active } = useActiveVehicle();
  const activeLabel = useVehicleLabel(active);
  const guestCar = useGuestCarLabel(url.filters);
  const { response, request } = view;
  const sessionId = response.session_id;
  const [busy, setBusy] = useState(false);
  const [consentAsked, setConsentAsked] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [mapHidden, setMapHidden] = useState(false);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [carOpen, setCarOpen] = useState(false);
  const pages = useSearchPages(view, () => setGone(true));
  const { signedIn } = opts;

  const apply = useCallback(
    async (next: { url?: Partial<UrlState>; ctx?: Partial<SearchContext> }) => {
      const nextUrl: UrlState = { ...url, ...next.url };
      const ctx: SearchContext = { ...contextOf(request), ...next.ctx };
      if (next.url && 'city' in next.url && next.url.city) ctx.location = { mode: 'chosen_city', city_key: next.url.city };
      const req = buildRequest(ctx, nextUrl, opts);
      const change = changeOf(request, req);
      setBusy(true);
      try {
        const r =
          change.kind === 'refine'
            ? await actions.refine(sessionId, request, change.body)
            : await actions.run(req, { started: next.ctx?.text !== undefined });
        router.push(searchPath(locale, r.session_id, nextUrl), { scroll: false });
      } catch (err) {
        if (err instanceof ApiProblem && err.code === 'LOCATION_CONSENT_REQUIRED') setConsentAsked(true);
        else if (err instanceof ApiProblem && err.status === 401) {
          const r = await actions.run(asGuest(req, opts.fallbackCity)).catch(() => null);
          if (r) router.push(searchPath(locale, r.session_id, nextUrl), { scroll: false });
          else toast(t('search.failed'));
        } else toast(t('search.failed'));
      } finally {
        setBusy(false);
      }
    },
    [url, request, opts, actions, sessionId, router, locale, toast, t],
  );

  // A stale session (search.page 404/400 CURSOR_MISMATCH): run the same request again (DI-17).
  useEffect(() => {
    if (!gone) return;
    void actions.run(request).then((r) => router.replace(searchPath(locale, r.session_id, url)));
  }, [gone, actions, request, router, locale, url]);

  // The signed-in user changed the active car (vehicle selector): search again for it.
  const wantVehicle = signedIn && vehiclesReady && (request.vehicle_id ?? null) !== activeVehicleId;
  const vehicleRun = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!wantVehicle || busy || vehicleRun.current === activeVehicleId) return;
    vehicleRun.current = activeVehicleId;
    queueMicrotask(() => void apply({ ctx: { vehicleId: activeVehicleId } }));
  }, [wantVehicle, busy, activeVehicleId, apply]);

  // Analytics: the safety banner once per session.
  const safetyShown = useRef<string | null>(null);
  useEffect(() => {
    if (!response.safety.flag || safetyShown.current === sessionId) return;
    safetyShown.current = sessionId;
    track('search.safety_banner_shown', { entry_point: 'search' });
  }, [response.safety.flag, sessionId, track]);

  const intent = response.interpreted_intent;
  const chipsText = intent.chips
    .filter((c) => c.kind !== 'target_type')
    .map((c) => c.label.text)
    .join(' · ');
  const vehicleLabel = signedIn ? (request.vehicle_id ? activeLabel : null) : guestCar;
  const hasVehicle = !!(request.vehicle_id || url.filters.brand_node_id);
  const vehicleToggle = hasVehicle
    ? {
        label: vehicleLabel ?? t('search.vehicle.yourCar'),
        on: url.vehicleFilter,
        onToggle: (on: boolean) => void apply({ url: { vehicleFilter: on } }),
      }
    : null;
  const results = pages.results;
  const complete = !pages.hasMore;
  const bestMatch = url.sort === 'best_match';
  const helpHref = `/${locale}/help`;
  const setFilters = (filters: SearchFilters) => void apply({ url: { filters } });
  const removeChip = (i: number, chip: IntentChip) => {
    track('search.chip_edited', { chip_type: chip.kind });
    void apply({ ctx: { intentOverride: withoutChip(intent, i) } });
  };
  const addChip = (chip: IntentChip) => {
    track('search.chip_edited', { chip_type: chip.kind });
    void apply({ ctx: { intentOverride: withChip(intent, chip) } });
  };
  const setLocation = (loc: LocationInput) => {
    if (loc.mode === 'chosen_city') void apply({ url: { city: loc.city_key } });
    else void apply({ url: { city: null }, ctx: { location: loc } });
  };
  const filterCount = activeFilterCount(url.filters, ['brand_node_id', 'model_node_id', 'series_node_id', 'year']);
  const center = cityCenter(region, request.location, url.city ?? opts.fallbackCity);
  const fullMap = `/${locale}/map?${new URLSearchParams({ session: sessionId, ...(url.mode !== 'all' ? { mode: url.mode } : {}) }).toString()}`;
  const showMap = wide && !mapHidden && url.mode !== 'qna';

  const panel = (id: string) => (
    <FilterPanel
      idPrefix={id}
      mode={url.mode}
      filters={url.filters}
      onChange={setFilters}
      results={results}
      complete={complete}
      vehicle={vehicleToggle}
    />
  );

  return (
    <div className="pwa-search-page pwa-wide-page" aria-busy={busy}>
      <header className="pwa-search-top">
        <h1 className="sr-only">{t('search.title')}</h1>
        <QueryField
          initial={request.query_text ?? ''}
          busy={busy}
          onSubmit={(text) => {
            if (text) addRecent({ text });
            void apply({ ctx: { text, intentOverride: undefined } });
          }}
        />
        <div className="pwa-search-context">
          {signedIn ? (
            <VehicleChip />
          ) : (
            <GuestCarChip
              filters={url.filters}
              disabled={busy}
              open={carOpen}
              onOpenChange={setCarOpen}
              onChange={(car) => setFilters({ ...url.filters, ...car })}
            />
          )}
          <LocationChip
            value={request.location}
            region={region}
            policyVersion={privacyVersion}
            onChange={setLocation}
            consentAsked={consentAsked}
            onConsentClosed={() => setConsentAsked(false)}
          />
          <a className={buttonClass({ size: 'sm', variant: 'ghost' })} href={fullMap}>
            <Icon name="map" size={20} />
            <span className="cp-btn-label">{t('shell.header.browseOnMap')}</span>
          </a>
        </div>
        <ModeTabs value={url.mode} qna={qnaOn} disabled={busy} onChange={(mode) => void apply({ url: { mode } })} />
        {url.mode !== 'qna' ? <UnderstoodAs intent={intent} onRemove={removeChip} onAdd={addChip} disabled={busy} /> : null}
      </header>

      <SafetyNotice safety={response.safety} />

      <div className={showMap ? 'pwa-search-grid has-map' : 'pwa-search-grid'}>
        {wide && url.mode !== 'qna' ? <div className="pwa-search-filters">{panel('fp')}</div> : null}
        <section className="pwa-search-main" aria-labelledby="results-title">
          <div className="pwa-search-toolbar">
            <h2 id="results-title" className="pwa-text-label m-0" aria-live="polite">
              {url.mode === 'qna'
                ? t('search.mode.qna')
                : t(pages.hasMore ? 'search.results.countMore' : 'search.results.count', { count: results.length })}
              {chipsText && url.mode !== 'qna' ? <span className="pwa-text-caption"> · {chipsText}</span> : null}
            </h2>
            {url.mode !== 'qna' ? (
              <div className="pwa-inline-actions">
                {!wide ? (
                  <Button size="sm" icon="filter" onClick={() => setFiltersOpen(true)}>
                    {t('search.filters.title')}
                    {filterCount ? <Badge tone="accent">{f.number(filterCount)}</Badge> : null}
                  </Button>
                ) : null}
                <SortSelect value={url.sort} disabled={busy} onChange={(sort) => void apply({ url: { sort } })} />
                {wide && mapHidden ? (
                  <Button size="sm" icon="map" onClick={() => setMapHidden(false)}>
                    {t('search.map.show')}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>

          {url.mode === 'qna' ? (
            <QnaResults text={request.query_text ?? ''} filters={url.filters} />
          ) : (
            <>
              {switchedToParts(request.search_mode, intent) ? (
                <Banner tone="info" icon="part" text={t('search.result.switchedToParts')} />
              ) : null}
              {response.vehicle_filter_fallback && vehicleLabel ? <VehicleFallback label={vehicleLabel} /> : null}
              {!hasVehicle ? (
                <VehicleMissing
                  signedIn={signedIn}
                  garageHref={`/${locale}/garage`}
                  onChoose={() => (signedIn ? vehicleModal.open() : setCarOpen(true))}
                />
              ) : !url.vehicleFilter ? (
                <p className="pwa-text-caption">{t('search.vehicle.lessSpecific')}</p>
              ) : null}
              {request.location.mode === 'map_center' ? <p className="pwa-text-caption">{t('search.map.searchedArea')}</p> : null}
              {results.length === 0 ? (
                <EmptyResults mode={url.mode} filters={url.filters} what={chipsText} onFilters={setFilters} helpHref={helpHref} />
              ) : (
                <ResultList
                  results={results}
                  sessionId={sessionId}
                  bestMatch={bestMatch}
                  highlightedId={highlighted}
                  onHover={setHighlighted}
                  label={t('search.results.label')}
                />
              )}
              {pages.hasMore ? (
                <div className="pwa-load-more">
                  <Button onClick={pages.loadMore} loading={pages.loadingMore}>
                    {t('common.actions.loadMore')}
                  </Button>
                </div>
              ) : null}
              {pages.error && !gone ? (
                <StateView
                  kind={stateFromProblem(pages.error)}
                  t={t}
                  compact
                  action={
                    <Button size="sm" onClick={pages.loadMore}>
                      {t('common.actions.retry')}
                    </Button>
                  }
                />
              ) : null}
              {results.length > 0 ? (
                <div className="pwa-search-foot">
                  {looksLikeSymptom(intent) ? (
                    <p className="pwa-text-caption">
                      {t('search.helpMe.notSure')}{' '}
                      <a
                        className="pwa-link"
                        href={helpHref}
                        onClick={() =>
                          saveHelpDraft({ vehicleId: request.vehicle_id ?? null, text: request.query_text ?? '', symptoms: [] })
                        }
                      >
                        {t('search.helpMe.describe')}
                      </a>
                    </p>
                  ) : (
                    <a className="pwa-link" href={helpHref}>
                      {t('search.helpMe.ask')}
                    </a>
                  )}
                </div>
              ) : null}
            </>
          )}
        </section>
        {showMap ? (
          <SearchMapPane
            results={results}
            sessionId={sessionId}
            bestMatch={bestMatch}
            highlightedId={highlighted}
            onHover={setHighlighted}
            onSearchArea={(viewport) => void apply({ url: { city: null }, ctx: { location: { mode: 'map_center', viewport } } })}
            onHide={() => setMapHidden(true)}
            fullMapHref={fullMap}
            styleUrl={styleUrl}
            center={center}
            vehicle={vehicleToggle}
          />
        ) : null}
      </div>
      {!wide ? (
        <Dialog open={filtersOpen} onClose={() => setFiltersOpen(false)} title={t('search.filters.title')} variant="drawer" name="filters">
          {panel('fd')}
        </Dialog>
      ) : null}
    </div>
  );
}

/** The centre of the searched area: the map area, the position, or the city. */
function cityCenter(region: ReturnType<typeof useRegion>, loc: LocationInput, city: string) {
  if (loc.mode === 'map_center') return loc.viewport.center;
  if (loc.mode === 'user_position') return loc.point;
  const key = loc.mode === 'chosen_city' ? loc.city_key : city;
  return region.cities.find((c) => c.city_key === key)?.center ?? region.map.default_center;
}

// ---------------------------------------------------------------- entry, loading, failure

function savePending(p: PendingSearch): void {
  try {
    sessionStorage.setItem(PENDING_SEARCH_KEY, JSON.stringify(p));
  } catch {
    /* storage blocked: the search still runs once */
  }
}

function SearchEntry({ onSearch }: { onSearch: (p: PendingSearch) => void }) {
  const t = useT();
  const locale = useLocale();
  return (
    <div className="pwa-search-page pwa-wide-page pwa-search-entry">
      <h1 className="pwa-text-title m-0">{t('search.entry.title')}</h1>
      <QueryField initial="" onSubmit={(text) => text && onSearch({ text, at: Date.now() })} />
      <a className={buttonClass({ variant: 'secondary' })} href={`/${locale}/map`}>
        <Icon name="map" size={20} />
        <span className="cp-btn-label">{t('shell.header.browseOnMap')}</span>
      </a>
      <RecentSearches onPick={(r) => onSearch({ text: r.text, ...(r.node ? { node: r.node } : {}), at: Date.now() })} />
    </div>
  );
}

function SearchLoading({ text }: { text: string }) {
  const t = useT();
  return (
    <div className="pwa-search-page" aria-busy="true">
      <p className="pwa-text-body" role="status">
        {text ? t('search.loadingFor', { text }) : t('search.loading')}
      </p>
      <SkeletonList count={4} label={t('search.loading')} />
    </div>
  );
}

function RunFailed({ error, text, onRetry }: { error: ApiProblem; text: string; onRetry: () => void }) {
  const t = useT();
  const locale = useLocale();
  const safety = useSafetyFallback(text, true, locale);
  return (
    <div className="pwa-search-page">
      {safety.data ? <SafetyNotice safety={safety.data} /> : null}
      <StateView
        kind={stateFromProblem(error)}
        t={t}
        action={
          <Button variant="primary" onClick={onRetry}>
            {t('common.actions.retry')}
          </Button>
        }
      />
    </div>
  );
}
