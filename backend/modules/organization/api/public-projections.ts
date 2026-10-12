// Public projections of locations (40 §14.1 PublicLocation, PublicLocationPin;
// SEC-OUT-4): never the exact point of an approximate location, never its
// street line; translations resolved to L10n for the reader's locale.
import { l10n, type Locale } from '#libs/i18n/index.js';
import type { PublicLocation, PublicLocationPin } from '../interface/public-profiles.js';
import { openNow, type HoursSpec } from '../domain/profile-rules.js';
import type { LocationRow } from './projections.js';

const point = (l: LocationRow) => ({ lat: Number(l.public_latitude), lng: Number(l.public_longitude) });

export function toPublicLocation(l: LocationRow, locale: Locale, now: Date): PublicLocation {
  const approximate = l.public_address_visibility === 'approximate';
  return {
    id: l.id,
    name: l.name,
    point: point(l),
    visibility: approximate ? 'approximate' : 'exact',
    // The street address of an approximate location is released only to the requester of a confirmed appointment (S7).
    address: { address_line_1: approximate ? null : l.address_line_1, city: l.city, region: l.region, country: l.country },
    service_radius_km: l.service_radius_km,
    hours: l.hours ?? null,
    open_now: openNow(l.hours as HoursSpec | null, l.timezone, now),
    timezone: l.timezone,
    access_instructions: approximate ? null : l10n(l.access_instructions_translations as Record<string, string> | null, locale),
  };
}

export function toPublicLocationPin(l: LocationRow): PublicLocationPin {
  return {
    location_id: l.id,
    point: point(l),
    visibility: l.public_address_visibility === 'approximate' ? 'approximate' : 'exact',
    service_radius_km: l.service_radius_km,
    city: l.city,
  };
}
