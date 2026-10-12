// Points, distances, public points and bboxes (40 §3.1, SEC-OUT-4), shared by
// the geo helpers and the geocoder.
import type { FieldError } from '#libs/contract/index.js';

export interface GeoPoint {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_M = 6_371_008.8;
const rad = (d: number): number => (d * Math.PI) / 180;

/** Great-circle distance in whole metres, as core.distance_m(). */
export function distanceMeters(a: GeoPoint, b: GeoPoint): number {
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h)));
}

/** Distances shown to users: straight-line, rounded to 0.1 km, labelled approximate (SEC-OUT-4). */
export const distanceKm = (a: GeoPoint, b: GeoPoint): number => Math.round(distanceMeters(a, b) / 100) / 10;

/**
 * numeric round(x, 2) of PostgreSQL (half away from zero) on a value with at
 * most 6 decimals, computed on integer micro-degrees to avoid binary drift.
 */
export function round2(value: number): number {
  const micro = Math.round(Math.abs(value) * 1e6);
  const rounded = Math.floor((micro + 5_000) / 10_000);
  return (Math.sign(value) || 1) * (rounded / 100);
}

/** Public point of a location: exact, or rounded to 0.01° for approximate locations. */
export function publicPoint(p: GeoPoint, visibility: 'exact' | 'approximate'): GeoPoint {
  return visibility === 'approximate' ? { lat: round2(p.lat), lng: round2(p.lng) } : { lat: p.lat, lng: p.lng };
}

export interface BBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** BBox rules (40 §3.1): south ≤ north, west ≤ east, span ≤ map.max_bbox_deg per axis. */
export function validateBBox(b: BBox, maxDeg: number, pointer = '/bbox'): FieldError[] {
  const errors: FieldError[] = [];
  if (b.south > b.north) errors.push({ pointer: `${pointer}/north`, code: 'order' });
  if (b.west > b.east) errors.push({ pointer: `${pointer}/east`, code: 'order' });
  if (b.north - b.south > maxDeg) errors.push({ pointer: `${pointer}/north`, code: 'out_of_range', limit: String(maxDeg) });
  if (b.east - b.west > maxDeg) errors.push({ pointer: `${pointer}/east`, code: 'out_of_range', limit: String(maxDeg) });
  return errors;
}

export const inBBox = (p: GeoPoint, b: BBox): boolean => p.lat >= b.south && p.lat <= b.north && p.lng >= b.west && p.lng <= b.east;
