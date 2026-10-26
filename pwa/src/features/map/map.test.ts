// P6.T3/T5/T8: map geometry (the region's bbox limit, "about" distances, radius circles), places from pins and
// results (kinds, ranks 1-3, highlight, layer/open-now/hide-others filters, list order), the style choice and the
// Directions links per app template (destination only), device links and the remembered app.
import type { MapPin, ResultCard } from '@carpal/api-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fallbackConfig } from '@/server/config';
import { devicePlatform, directionsApps, directionsUrl, navCookieString, readNavCookie, rememberedApp } from './directions-links';
import { apiViewport, circleRing, distanceM, limitBBox, movedEnough } from './geo';
import { kindOf, listOrder, mergePlaces, placesFromPins, placesFromResults, rankLabel, visiblePlaces } from './places';
import { fallbackStyle, loadStyle, usableStyleUrl } from './style';

const region = fallbackConfig('en').region;
const point = { lat: 35.689198, lng: 51.38897 };

describe('geometry', () => {
  it('limits the bbox to the region span around its centre', () => {
    const wide = { north: 36.2, south: 35.2, east: 52.0, west: 50.8 };
    const { bbox, clipped } = limitBBox(wide, 0.6);
    expect(clipped).toBe(true);
    expect(bbox.north - bbox.south).toBeCloseTo(0.6, 6);
    expect(bbox.east - bbox.west).toBeCloseTo(0.6, 6);
    expect((bbox.east + bbox.west) / 2).toBeCloseTo(51.4, 6);
    expect(limitBBox({ north: 35.8, south: 35.6, east: 51.5, west: 51.3 }, 0.6).clipped).toBe(false);
  });

  it('builds an API viewport with an integer zoom', () => {
    const { viewport } = apiViewport(point, 11.6, { north: 35.8, south: 35.6, east: 51.5, west: 51.3 }, 0.6);
    expect(viewport.zoom).toBe(12);
    expect(viewport.center).toEqual(point);
  });

  it('measures straight-line distances and draws closed radius circles', () => {
    expect(distanceM(point, { lat: 35.7, lng: 51.38897 }) / 1000).toBeCloseTo(1.2, 1);
    const ring = circleRing(point, 10, 24);
    expect(ring).toHaveLength(25);
    expect(ring[0]).toEqual(ring[24]);
    expect(distanceM(point, { lat: ring[6]![1], lng: ring[6]![0] }) / 1000).toBeCloseTo(10, 1);
  });

  it('offers Search this area after a real move', () => {
    const searched = { center: point, zoom: 12, bbox: { north: 35.79, south: 35.59, east: 51.49, west: 51.29 } };
    expect(movedEnough(searched, { center: point, zoom: 12.2 })).toBe(false);
    expect(movedEnough(searched, { center: point, zoom: 13.1 })).toBe(true);
    expect(movedEnough(searched, { center: { lat: point.lat + 0.08, lng: point.lng }, zoom: 12 })).toBe(true);
  });
});

const pin = (o: Partial<MapPin>): MapPin => ({
  pin_id: 'l1',
  organization_id: 'o1',
  roles: ['provider'],
  point,
  visibility: 'exact',
  service_radius_km: null,
  name: 'Reza Auto',
  overall_rating: '4.8',
  badge: null,
  open_now: true,
  matches_filters: true,
  relevant_to_vehicle: null,
  matching_item_count: null,
  rank: 1,
  reason_summary: { text: 'Specialist in Suspension', locale: 'en' },
  ...o,
});

describe('places', () => {
  it('tells kinds by role and radius, never by colour', () => {
    expect(kindOf(['provider'], null)).toBe('shop');
    expect(kindOf(['provider'], 15)).toBe('mobile');
    expect(kindOf(['vendor'], null)).toBe('seller');
    expect(kindOf(['provider', 'vendor'], null)).toBe('hybrid');
  });

  it('numbers ranks 1-3 for best-match orders only', () => {
    expect(rankLabel(2, true)).toBe(2);
    expect(rankLabel(4, true)).toBeNull();
    expect(rankLabel(1, false)).toBeNull();
  });

  it('joins pins with result cards, dims non-matching pins and filters by layer, open now and Hide others', () => {
    const result = { result_id: 'r1', organization: { id: 'o2', roles: ['vendor'], top_badges: [] } } as unknown as ResultCard;
    const places = placesFromPins(
      [pin({}), pin({ pin_id: 'l2', organization_id: 'o2', roles: ['vendor'], matches_filters: false, open_now: false, rank: null })],
      [result],
    );
    expect(places[1]).toMatchObject({ kind: 'seller', dimmed: true, result });
    const all = { shops: true, sellers: true, openNow: false, hideOthers: false };
    expect(visiblePlaces(places, all)).toHaveLength(2);
    expect(visiblePlaces(places, { ...all, sellers: false }).map((p) => p.id)).toEqual(['l1']);
    expect(visiblePlaces(places, { ...all, openNow: true }).map((p) => p.id)).toEqual(['l1']);
    expect(visiblePlaces(places, { ...all, hideOthers: true }).map((p) => p.id)).toEqual(['l1']);
  });

  it('lists every result of the area, also those inside clusters, and orders by rank or by closeness to the centre', () => {
    const card = (id: string, loc: string, rank: number, lat: number) =>
      ({
        result_id: id,
        rank,
        organization: { id: `o-${id}`, name: id, roles: ['provider'], top_badges: [], overall_rating: null },
        location: { location_id: loc, point: { lat, lng: point.lng }, visibility: 'exact', service_radius_km: null, city: 'Tehran' },
        reasons: [],
        open_now: null,
        matching_item_count: null,
        relevant_to_vehicle: null,
      }) as unknown as ResultCard;
    const fromResults = placesFromResults([card('far', 'la', 1, point.lat + 0.05), card('near', 'lb', 2, point.lat + 0.001)]);
    const merged = mergePlaces(
      fromResults,
      placesFromPins([pin({ pin_id: 'lb', organization_id: 'o-near', matches_filters: false, rank: 2 }), pin({ pin_id: 'lc' })]),
    );
    expect(merged.map((p) => p.id)).toEqual(['la', 'lb', 'lc']);
    expect(merged[1]).toMatchObject({ dimmed: true, result: fromResults[1]!.result });
    expect(listOrder(merged.slice(0, 2), point, false).map((p) => p.id)).toEqual(['la', 'lb']);
    expect(listOrder(merged.slice(0, 2), point, true).map((p) => p.id)).toEqual(['lb', 'la']);
  });
});

describe('map style', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses a style URL only when the page CSP allows its origin', () => {
    expect(usableStyleUrl('https://cdn.carpal.app/tiles/ir-pilot/style.json', ['https://cdn.carpal.app'])).toBe(
      'https://cdn.carpal.app/tiles/ir-pilot/style.json',
    );
    expect(usableStyleUrl('https://tiles.example.org/style.json', ['https://cdn.carpal.app'])).toBeNull();
    expect(usableStyleUrl('http://tiles.example.org/style.json', ['http://tiles.example.org'])).toBeNull();
    expect(usableStyleUrl(null, [])).toBeNull();
  });

  it('falls back to the built-in style (background + radius layers, no glyphs or tiles) and remembers a failure', async () => {
    const style = fallbackStyle({ background: 'var-bg', radiusFill: 'a', radiusLine: 'b' });
    expect(style.layers.map((l) => l.id)).toEqual(['background', 'cp-radius-fill', 'cp-radius-line']);
    expect(style.glyphs).toBeUndefined();
    const store = new Map<string, string>();
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
    const failing = vi.fn(async () => new Response('nope', { status: 404 }));
    expect(await loadStyle('https://cdn.carpal.app/s.json', failing as unknown as typeof fetch, 1000)).toBeNull();
    expect(await loadStyle('https://cdn.carpal.app/s.json', failing as unknown as typeof fetch, 2000)).toBeNull();
    expect(failing).toHaveBeenCalledTimes(1);
    const ok = vi.fn(async () => Response.json({ version: 8, sources: {}, layers: [] }));
    expect(await loadStyle('https://cdn.carpal.app/other.json', ok as unknown as typeof fetch, 3000)).toEqual({
      version: 8,
      sources: {},
      layers: [],
    });
  });
});

describe('directions links (S-SHARED-10)', () => {
  it('fills each web app template with the destination only', () => {
    const apps = directionsApps(region, point, { platform: null, remembered: null, deviceLabel: 'This phone' });
    expect(apps.map((a) => a.key)).toEqual(['neshan', 'balad', 'google_maps', 'waze', 'osm']);
    expect(Object.fromEntries(apps.map((a) => [a.key, a.href]))).toEqual({
      neshan: 'https://neshan.org/maps/@35.689198,51.38897,16z',
      balad: 'https://balad.ir/location?latitude=35.689198&longitude=51.38897',
      google_maps: 'https://www.google.com/maps/dir/?api=1&destination=35.689198,51.38897',
      waze: 'https://waze.com/ul?ll=35.689198,51.38897&navigate=yes',
      osm: 'https://www.openstreetmap.org/?mlat=35.689198&mlon=51.38897#map=17/35.689198/51.38897',
    });
    expect(directionsUrl('x={lat}&y={lng}', { lat: 35.1, lng: 51 })).toBe('x=35.1&y=51');
  });

  it('adds the phone map app on Android and iOS and puts the remembered app first', () => {
    expect(devicePlatform('Mozilla/5.0 (Linux; Android 14; Pixel 8)')).toBe('android');
    expect(devicePlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('ios');
    expect(devicePlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)', 5)).toBe('ios');
    expect(devicePlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBeNull();
    const android = directionsApps(region, point, { platform: 'android', remembered: 'waze', deviceLabel: 'This phone' });
    expect(android.map((a) => a.key).slice(0, 2)).toEqual(['waze', 'device']);
    expect(android.find((a) => a.key === 'device')!.href).toBe('geo:35.689198,51.38897?q=35.689198,51.38897');
    const ios = directionsApps(region, point, { platform: 'ios', remembered: null, deviceLabel: 'This phone' });
    expect(ios[0]!.href).toBe('https://maps.apple.com/?daddr=35.689198,51.38897');
  });

  it('remembers only apps of the region list (cookie for guests)', () => {
    expect(rememberedApp(region, 'balad')).toBe('balad');
    expect(rememberedApp(region, 'apple_maps')).toBeNull();
    expect(rememberedApp(region, '<script>')).toBeNull();
    expect(readNavCookie(`cp_theme=dark; ${navCookieString('neshan', true).split(';')[0]}`)).toBe('neshan');
    expect(navCookieString('neshan', true)).toMatch(/^cp_nav=neshan; Path=\/; SameSite=Lax; Secure; Max-Age=\d+$/);
    expect(navCookieString(null, false)).toBe('cp_nav=; Path=/; SameSite=Lax; Max-Age=0');
  });
});
