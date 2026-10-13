// Read interface for the appointment module (S7): which providers can be
// booked (published provider of an active organization, its service modes and
// active locations) and the locations of appointments, with the public view
// (SEC-OUT-4) and the exact address the requester of a confirmed appointment
// may see (52 §12 "the exact address becomes visible once confirmed"). Reads
// under the public RLS policies (public_read on profiles and locations).
import type { Locale } from '#libs/i18n/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import type { PublicLocation } from './public-profiles.js';

export interface BookableProvider {
  orgId: string;
  /** 52 ProviderProfile.service_modes (40 AppointmentCreate.service_mode must be one of them). */
  serviceModes: string[];
  /** Active locations, primary first. */
  locationIds: string[];
}

export interface BookingLocation {
  id: string;
  organizationId: string;
  timezone: string;
  public: PublicLocation;
  /** Street address and exact point: shown to the requester only from confirmation (caller's rule). */
  exact: { address_line_1: string; address_line_2: string | null; point: { lat: number; lng: number } };
}

export abstract class ProviderBooking {
  /** A provider that accepts appointments now (published provider profile, active organization), else null. */
  abstract provider(scope: TxScope, orgId: string): Promise<BookableProvider | null>;
  /** Active location ids of an organization, primary first (published or not: calendars, availability rules). */
  abstract locationIds(scope: TxScope, orgId: string): Promise<string[]>;
  /** Locations by id (active or not: an appointment keeps its location), with time zone and both address views. */
  abstract locations(scope: TxScope, ids: readonly string[], locale: Locale, now?: Date): Promise<Map<string, BookingLocation>>;
}
