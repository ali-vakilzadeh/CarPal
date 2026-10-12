// Locations and the business location editor (40 §7.2): org.locations_list,
// org.location_create / update / delete, org.location_pin_check, geo.geocode,
// geo.reverse, geo.resolve_map_link. Businesses store their exact point (the
// owner's pin, or a resolved map link confirmed on the map); the server
// geocodes the typed address, records the pin-versus-address check (a
// far_apart result warns, never blocks) and the trigger keeps the public
// point (0.01° for approximate locations, SEC-OUT-4).
import { Inject, Injectable } from '@nestjs/common';
import { writeAudit } from '#libs/audit/index.js';
import type { CarpalConfig } from '#libs/config/index.js';
import { ApiError, type FieldError } from '#libs/contract/index.js';
import { Geocoder, MapLinkResolver, pinCheck, type GeoPoint } from '#libs/geo/index.js';
import { ACK, created, Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import { isTimezone } from '#libs/i18n/index.js';
import { RegionConfigService } from '#libs/region-config/index.js';
import { CARPAL_CONFIG } from '#libs/runtime/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { OrgMemberships } from '#modules/identity/interface/identity.js';
import { toLocation, type LocationRow } from '../api/projections.js';
import { validateHours, type HoursSpec } from '../domain/profile-rules.js';
import { afterId, checkVersion, failIf, json, member, pageOf } from './common.js';

type LocationWrite = {
  name?: string;
  address_line_1: string;
  address_line_2?: string;
  city: string;
  region?: string;
  postal_code?: string;
  country: string;
  pin: GeoPoint;
  public_address_visibility: 'exact' | 'approximate';
  timezone: string;
  service_radius_km?: number;
  phone?: string;
  email?: string;
  primary_contact_user_id?: string;
  access_instructions_translations?: Record<string, string>;
  hours?: HoursSpec;
  is_primary: boolean;
  status?: 'active' | 'inactive';
};

/** Field checks the closed schema cannot express (Tz allowlist, hours order). */
function checkFields(b: Partial<LocationWrite>): void {
  const errors: FieldError[] = [];
  if (b.timezone !== undefined && !isTimezone(b.timezone)) errors.push({ pointer: '/timezone', code: 'enum' });
  if (b.hours) errors.push(...validateHours(b.hours));
  failIf(errors);
}

/** The pin-versus-address check of an address and pin (geocoder of the region). */
@Injectable()
export class LocationChecker {
  constructor(
    private readonly geocoder: Geocoder,
    @Inject(CARPAL_CONFIG) private readonly config: CarpalConfig,
  ) {}

  get thresholdM(): number {
    return this.config.geo.locationCheckThresholdM;
  }

  async check(a: { address_line_1: string; city: string; postal_code?: string | null; country: string }, pin: GeoPoint) {
    const geocoded = await this.geocoder.locate(a);
    return { geocoded, ...pinCheck(pin, geocoded, this.thresholdM) };
  }
}

async function requireMember(memberships: OrgMemberships, scope: TxScope, orgId: string, userId: string | undefined | null) {
  if (!userId) return;
  const m = await memberships.findLive(scope, orgId, { userId });
  if (!m || m.status !== 'active')
    throw ApiError.validation([{ pointer: '/primary_contact_user_id', code: 'reference_not_found' }], 'REFERENCE_NOT_FOUND');
}

/** Active primary location of the organization other than `exceptId`. */
async function otherPrimary(scope: TxScope, orgId: string, exceptId?: string) {
  let q = scope.db
    .selectFrom('organization.organization_locations')
    .select('id')
    .where('organization_id', '=', orgId)
    .where('is_primary', '=', true)
    .where('status', '=', 'active')
    .where('deleted_at', 'is', null);
  if (exceptId) q = q.where('id', '<>', exceptId);
  return q.executeTakeFirst();
}

async function setPrimaryLocation(scope: TxScope, orgId: string, locationId: string | null): Promise<void> {
  await scope.db.updateTable('organization.organizations').set({ primary_location_id: locationId }).where('id', '=', orgId).execute();
}

@Injectable()
@Operation('org.locations_list')
export class OrgLocationsListHandler implements OperationHandler {
  async handle(ctx: OperationContext<undefined, { limit: number }>): Promise<OperationResult> {
    const m = member(ctx);
    const after = afterId(ctx);
    const rows = await ctx.tx(
      (scope) => {
        let q = scope.db
          .selectFrom('organization.organization_locations')
          .selectAll()
          .where('organization_id', '=', m.orgId)
          .where('deleted_at', 'is', null);
        if (after) q = q.where('id', '>', after);
        return q
          .orderBy('id')
          .limit(ctx.query.limit + 1)
          .execute();
      },
      { readOnly: true },
    );
    return { body: pageOf(ctx, rows, toLocation) };
  }
}

@Injectable()
@Operation('org.location_create')
export class OrgLocationCreateHandler implements OperationHandler {
  constructor(
    private readonly checker: LocationChecker,
    private readonly memberships: OrgMemberships,
  ) {}

  async handle(ctx: OperationContext<LocationWrite>): Promise<OperationResult> {
    const m = member(ctx);
    const b = ctx.body;
    checkFields(b);
    const check = await this.checker.check(b, b.pin);
    const row = await ctx.tx(async (scope) => {
      await requireMember(this.memberships, scope, m.orgId, b.primary_contact_user_id);
      const active = (b.status ?? 'active') === 'active';
      const existingPrimary = await otherPrimary(scope, m.orgId);
      if (b.is_primary && active && existingPrimary) throw ApiError.validation([{ pointer: '/is_primary', code: 'not_unique' }]); // 40 VALIDATION_FAILED(primary_conflict)
      // 52: exactly one primary per organization; the first active location becomes it.
      const primary = active && (b.is_primary || !existingPrimary);
      const loc = await scope.db
        .insertInto('organization.organization_locations')
        .values({
          organization_id: m.orgId,
          name: b.name ?? null,
          address_line_1: b.address_line_1,
          address_line_2: b.address_line_2 ?? null,
          city: b.city,
          region: b.region ?? null,
          postal_code: b.postal_code ?? null,
          country: b.country,
          latitude: b.pin.lat,
          longitude: b.pin.lng,
          geo_source: 'user_pin',
          geo_address_distance_m: check.distance_m,
          location_check_status: check.location_check_status,
          public_address_visibility: b.public_address_visibility,
          // Set by the trigger from the exact point; required by the column, overwritten before insert.
          public_latitude: b.pin.lat,
          public_longitude: b.pin.lng,
          timezone: b.timezone,
          service_radius_km: b.service_radius_km ?? null,
          phone: b.phone ?? null,
          email: b.email?.toLowerCase() ?? null,
          primary_contact_user_id: b.primary_contact_user_id ?? null,
          access_instructions_translations: json(b.access_instructions_translations),
          hours: json(b.hours),
          is_primary: primary,
          status: b.status ?? 'active',
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      if (primary) await setPrimaryLocation(scope, m.orgId, loc.id);
      return loc;
    });
    return created(toLocation(row), `/v1/orgs/${m.orgId}/locations/${row.id}`);
  }
}

async function loadLocation(scope: TxScope, orgId: string, id: string, lock = false): Promise<LocationRow> {
  const q = scope.db
    .selectFrom('organization.organization_locations')
    .selectAll()
    .where('id', '=', id)
    .where('organization_id', '=', orgId)
    .where('deleted_at', 'is', null);
  const row = await (lock ? q.forUpdate() : q).executeTakeFirst();
  if (!row) throw new ApiError('NOT_FOUND');
  return row;
}

/** When the primary stops being active, the oldest other active location takes over (or none). */
async function promoteNextPrimary(scope: TxScope, orgId: string, exceptId: string): Promise<void> {
  const next = await scope.db
    .selectFrom('organization.organization_locations')
    .select('id')
    .where('organization_id', '=', orgId)
    .where('status', '=', 'active')
    .where('deleted_at', 'is', null)
    .where('id', '<>', exceptId)
    .orderBy('id')
    .executeTakeFirst();
  if (next) await scope.db.updateTable('organization.organization_locations').set({ is_primary: true }).where('id', '=', next.id).execute();
  await setPrimaryLocation(scope, orgId, next?.id ?? null);
}

@Injectable()
@Operation('org.location_update')
export class OrgLocationUpdateHandler implements OperationHandler {
  constructor(
    private readonly checker: LocationChecker,
    private readonly memberships: OrgMemberships,
  ) {}

  async handle(ctx: OperationContext<Partial<LocationWrite>>): Promise<OperationResult> {
    const m = member(ctx);
    const b = ctx.body;
    checkFields(b);
    const row = await ctx.tx(async (scope) => {
      const loc = await loadLocation(scope, m.orgId, ctx.params.location_id!, true);
      checkVersion(loc.version, ctx.ifMatch);
      await requireMember(this.memberships, scope, m.orgId, b.primary_contact_user_id);
      const status = b.status ?? loc.status;
      const wantsPrimary = b.is_primary ?? loc.is_primary;
      if (wantsPrimary && status === 'active' && !loc.is_primary && (await otherPrimary(scope, m.orgId, loc.id)))
        throw ApiError.validation([{ pointer: '/is_primary', code: 'not_unique' }]);
      if (loc.is_primary && (!wantsPrimary || status !== 'active')) {
        // The primary moves to another active location; the only active one cannot step down.
        const others = await scope.db
          .selectFrom('organization.organization_locations')
          .select('id')
          .where('organization_id', '=', m.orgId)
          .where('status', '=', 'active')
          .where('deleted_at', 'is', null)
          .where('id', '<>', loc.id)
          .executeTakeFirst();
        if (!others) throw new ApiError('INVALID_TRANSITION', { detail: 'primary_location' });
      }
      const pin = b.pin ?? { lat: Number(loc.latitude), lng: Number(loc.longitude) };
      const address = {
        address_line_1: b.address_line_1 ?? loc.address_line_1,
        city: b.city ?? loc.city,
        postal_code: b.postal_code !== undefined ? b.postal_code : loc.postal_code,
        country: b.country ?? loc.country,
      };
      const moved =
        b.pin !== undefined ||
        address.address_line_1 !== loc.address_line_1 ||
        address.city !== loc.city ||
        address.postal_code !== loc.postal_code ||
        address.country !== loc.country;
      const check = moved ? await this.checker.check(address, pin) : null;
      const set = {
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.address_line_1 !== undefined ? { address_line_1: b.address_line_1 } : {}),
        ...(b.address_line_2 !== undefined ? { address_line_2: b.address_line_2 } : {}),
        ...(b.city !== undefined ? { city: b.city } : {}),
        ...(b.region !== undefined ? { region: b.region } : {}),
        ...(b.postal_code !== undefined ? { postal_code: b.postal_code } : {}),
        ...(b.country !== undefined ? { country: b.country } : {}),
        // The owner moved the pin: their point again (a staff correction is admin_corrected, S8).
        ...(b.pin !== undefined ? { latitude: b.pin.lat, longitude: b.pin.lng, geo_source: 'user_pin' } : {}),
        ...(check ? { geo_address_distance_m: check.distance_m, location_check_status: check.location_check_status } : {}),
        ...(b.public_address_visibility !== undefined ? { public_address_visibility: b.public_address_visibility } : {}),
        ...(b.timezone !== undefined ? { timezone: b.timezone } : {}),
        ...(b.service_radius_km !== undefined ? { service_radius_km: b.service_radius_km } : {}),
        ...(b.phone !== undefined ? { phone: b.phone } : {}),
        ...(b.email !== undefined ? { email: b.email.toLowerCase() } : {}),
        ...(b.primary_contact_user_id !== undefined ? { primary_contact_user_id: b.primary_contact_user_id } : {}),
        ...(b.access_instructions_translations !== undefined
          ? { access_instructions_translations: json(b.access_instructions_translations) }
          : {}),
        ...(b.hours !== undefined ? { hours: json(b.hours) } : {}),
        is_primary: wantsPrimary && status === 'active',
        status,
      };
      // The trigger re-derives the public point and clears location_verified_at when the pin or address moved.
      const updated = await scope.db
        .updateTable('organization.organization_locations')
        .set(set)
        .where('id', '=', loc.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (loc.is_primary && !updated.is_primary) await promoteNextPrimary(scope, m.orgId, loc.id);
      if (!loc.is_primary && updated.is_primary) await setPrimaryLocation(scope, m.orgId, loc.id);
      await writeAudit(scope, {
        action: 'organization.location_updated',
        entityType: 'organization_location',
        entityId: loc.id,
        next: Object.keys(b).join(','),
      });
      return updated;
    });
    return { body: toLocation(row) };
  }
}

@Injectable()
@Operation('org.location_delete')
export class OrgLocationDeleteHandler implements OperationHandler {
  async handle(ctx: OperationContext): Promise<OperationResult> {
    const m = member(ctx);
    await ctx.tx(async (scope) => {
      const loc = await loadLocation(scope, m.orgId, ctx.params.location_id!, true);
      if (loc.status === 'inactive' && !loc.is_primary) {
        await writeAudit(scope, { action: 'organization.location_deactivated', entityType: 'organization_location', entityId: loc.id });
        return;
      }
      if (loc.is_primary && loc.status === 'active') {
        const others = await scope.db
          .selectFrom('organization.organization_locations')
          .select('id')
          .where('organization_id', '=', m.orgId)
          .where('status', '=', 'active')
          .where('deleted_at', 'is', null)
          .where('id', '<>', loc.id)
          .executeTakeFirst();
        if (!others) throw new ApiError('INVALID_TRANSITION', { detail: 'primary_location' });
      }
      await scope.db
        .updateTable('organization.organization_locations')
        .set({ status: 'inactive', is_primary: false })
        .where('id', '=', loc.id)
        .execute();
      if (loc.is_primary) await promoteNextPrimary(scope, m.orgId, loc.id);
      await writeAudit(scope, { action: 'organization.location_deactivated', entityType: 'organization_location', entityId: loc.id });
    });
    return { body: ACK };
  }
}

@Injectable()
@Operation('org.location_pin_check')
export class OrgLocationPinCheckHandler implements OperationHandler {
  constructor(private readonly checker: LocationChecker) {}

  async handle(
    ctx: OperationContext<{ address_line_1: string; city: string; postal_code?: string; country: string; pin: GeoPoint }>,
  ): Promise<OperationResult> {
    member(ctx);
    const r = await this.checker.check(ctx.body, ctx.body.pin);
    return {
      body: {
        geocoded_point: r.geocoded,
        distance_m: r.distance_m,
        location_check_status: r.location_check_status,
        threshold_m: this.checker.thresholdM,
      },
    };
  }
}

/** Geocoder output is third-party data (SEC-IN-10): bounded like client input before it is returned. */
const clip = (s: string | null, max: number): string | null => (s === null ? null : [...s].slice(0, max).join(''));
function candidate(c: Awaited<ReturnType<Geocoder['search']>>[number]) {
  return {
    label: clip(c.label, 300) || c.city,
    point: c.point,
    address_line_1: clip(c.address_line_1, 160)!,
    city: clip(c.city, 100)!,
    region: clip(c.region, 100),
    postal_code: clip(c.postal_code, 20),
    country: c.country,
  };
}

@Injectable()
@Operation('geo.geocode')
export class GeoGeocodeHandler implements OperationHandler {
  constructor(private readonly geocoder: Geocoder) {}

  async handle(ctx: OperationContext<{ query: string; country: string }>): Promise<OperationResult> {
    member(ctx);
    const found = await this.geocoder.search(ctx.body.query, ctx.body.country, 5);
    return { body: { candidates: found.slice(0, 5).map(candidate) } };
  }
}

@Injectable()
@Operation('geo.reverse')
export class GeoReverseHandler implements OperationHandler {
  constructor(private readonly geocoder: Geocoder) {}

  async handle(ctx: OperationContext<{ point: GeoPoint }>): Promise<OperationResult> {
    member(ctx);
    const c = await this.geocoder.reverse(ctx.body.point);
    return { body: { candidate: c ? candidate(c) : null } };
  }
}

@Injectable()
@Operation('geo.resolve_map_link')
export class GeoResolveMapLinkHandler implements OperationHandler {
  constructor(
    private readonly resolver: MapLinkResolver,
    private readonly region: RegionConfigService,
    private readonly geocoder: Geocoder,
  ) {}

  async handle(ctx: OperationContext<{ url: string }>): Promise<OperationResult> {
    member(ctx);
    // SEC-IN-9: full URLs parsed locally; short links expanded only for allowlisted hosts, SSRF-guarded.
    const p = await this.resolver.resolve(ctx.body.url, this.region.mapLinkHosts);
    const point = { lat: p.lat, lng: p.lng };
    // The point is only proposed; the owner confirms it on the map. The label is a reverse-geocoded hint.
    const near = await this.geocoder.reverse(point).catch(() => null);
    return { body: { point, provider_key: p.provider_key, label: near ? clip(near.label, 300) : null } };
  }
}
