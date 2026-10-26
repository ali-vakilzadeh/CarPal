// Map geometry for W-MAP-01, the W-SRCH-01 map pane and the directory map (P6.T3): viewports in the contract's
// MapViewport shape, the region's bbox limit (map.pins answers 422 bbox_too_large above region.map.max_bbox_deg per
// axis), straight-line distances ("about", Docs/22 W-MAP-01) and radius circles for mobile providers. Pure functions.
import type { MapViewport } from '@carpal/api-contracts';

export type Point = { lat: number; lng: number };
export type BBox = MapViewport['bbox'];

const EARTH_RADIUS_M = 6_371_008.8;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in metres. */
export function distanceM(a: Point, b: Point): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Coordinates rounded to 6 decimals (≈ 0.1 m): what the contract's GeoPoint needs, no more. */
export function roundPoint(p: Point, decimals = 6): Point {
  const k = 10 ** decimals;
  return { lat: Math.round(p.lat * k) / k, lng: Math.round(p.lng * k) / k };
}

const clampLat = (v: number) => Math.max(-90, Math.min(90, v));
const clampLng = (v: number) => Math.max(-180, Math.min(180, v));

/**
 * Limits a bbox to `maxDeg` per axis around its centre (the visible area may be larger on wide screens or when zoomed
 * out). Returns the bbox and whether it was cut, so the page can say "Zoom in to see every place".
 */
export function limitBBox(b: BBox, maxDeg: number): { bbox: BBox; clipped: boolean } {
  const cLat = (b.north + b.south) / 2;
  const cLng = (b.east + b.west) / 2;
  const halfLat = Math.min((b.north - b.south) / 2, maxDeg / 2);
  const halfLng = Math.min((b.east - b.west) / 2, maxDeg / 2);
  const bbox = {
    north: clampLat(cLat + halfLat),
    south: clampLat(cLat - halfLat),
    east: clampLng(cLng + halfLng),
    west: clampLng(cLng - halfLng),
  };
  const clipped = b.north - b.south > maxDeg + 1e-9 || b.east - b.west > maxDeg + 1e-9;
  return { bbox: roundBBox(bbox), clipped };
}

export function roundBBox(b: BBox, decimals = 6): BBox {
  const k = 10 ** decimals;
  const r = (v: number) => Math.round(v * k) / k;
  return { north: r(b.north), south: r(b.south), east: r(b.east), west: r(b.west) };
}

/** A viewport for the API (zoom as an integer 0-22, bbox limited to the region's span). */
export function apiViewport(center: Point, zoom: number, bbox: BBox, maxDeg: number): { viewport: MapViewport; clipped: boolean } {
  const limited = limitBBox(bbox, maxDeg);
  return {
    viewport: { center: roundPoint(center), zoom: Math.max(0, Math.min(22, Math.round(zoom))), bbox: limited.bbox },
    clipped: limited.clipped,
  };
}

/** A square-ish bbox of `spanDeg` around a point (used before the map knows its size, and for list-only mode). */
export function bboxAround(p: Point, spanDeg: number): BBox {
  const half = spanDeg / 2;
  return roundBBox({
    north: clampLat(p.lat + half),
    south: clampLat(p.lat - half),
    east: clampLng(p.lng + half),
    west: clampLng(p.lng - half),
  });
}

/** The smallest bbox around points (null for none). */
export function boundsOf(points: readonly Point[]): BBox | null {
  if (!points.length) return null;
  let north = -90,
    south = 90,
    east = -180,
    west = 180;
  for (const p of points) {
    north = Math.max(north, p.lat);
    south = Math.min(south, p.lat);
    east = Math.max(east, p.lng);
    west = Math.min(west, p.lng);
  }
  return { north, south, east, west };
}

/** True when the map moved far enough from the searched area to offer "Search this area" (a quarter of the span, or zoom). */
export function movedEnough(searched: { center: Point; zoom: number; bbox: BBox }, now: { center: Point; zoom: number }): boolean {
  if (Math.abs(searched.zoom - now.zoom) >= 1) return true;
  const spanLat = Math.max(1e-6, searched.bbox.north - searched.bbox.south);
  const spanLng = Math.max(1e-6, searched.bbox.east - searched.bbox.west);
  return Math.abs(now.center.lat - searched.center.lat) / spanLat > 0.25 || Math.abs(now.center.lng - searched.center.lng) / spanLng > 0.25;
}

/** A circle as a closed GeoJSON ring (lng, lat), `steps` segments: the service radius of a mobile provider. */
export function circleRing(center: Point, radiusKm: number, steps = 48): [number, number][] {
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
