// L19 geo (41 §2.2, §7; 40 SEC-OUT-4, SEC-IN-9, §3.1 BBox): straight-line
// distance identical to core.distance_m(), the 0.01° public point identical to
// the organization_locations trigger, bbox checks, and map-link parsing with
// an SSRF-safe short-link resolver, and the Geocoder port (lite: fixtures).

export {
  parseMapLink,
  MapLinkResolver,
  isBlockedAddress,
  type MapLinkHost,
  type ResolvedPoint,
  type ResolverTransport,
} from './map-link.js';
export {
  Geocoder,
  FixtureGeocoder,
  UnconfiguredGeocoder,
  FIXTURE_ADDRESSES,
  normalizeAddress,
  pinCheck,
  type AddressQuery,
  type GeocodeCandidate,
  type LocationCheckStatus,
} from './geocoder.js';
export * from './points.js';
export { openNow, type HoursSpec } from './hours.js';
