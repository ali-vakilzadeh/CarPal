// Map and location settings of the console (AC9.T3, Docs/02 §3.5 region config, Docs/40 PinCheck). The region's map
// defaults (centre, zoom, attribution) come from the pilot region file the backend loads (shared/region-config), so
// the console and the apps start their maps at the same place. The pin-versus-address threshold is the backend's
// CARPAL_LOCATION_CHECK_THRESHOLD_M (default 300 m): admin.verifications_queue returns it with each location check
// (PinCheck.threshold_m); StaffOrgView does not, so the organization page shows this default until the admin plane
// serves the region settings (BR-18, D-58). The far/near verdict itself is always the server's
// (Location.location_check_status), never recomputed here.
import region from '@carpal/region-config/ir-pilot.json';

export type GeoPoint = { lat: number; lng: number };

/** The backend's default threshold (backend/libs/config CARPAL_LOCATION_CHECK_THRESHOLD_M). */
export const DEFAULT_LOCATION_THRESHOLD_M = 300;

export const REGION_MAP = {
  center: region.map.default_center as GeoPoint,
  zoom: region.map.default_zoom,
  attribution: region.map.attribution,
} as const;

/** Zoom used when the map shows one location. */
export const LOCATION_ZOOM = 16;
