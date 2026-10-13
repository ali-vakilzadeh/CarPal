// ProviderBooking (interface/booking.ts) under the public RLS policies.
import { Injectable } from '@nestjs/common';
import { textArray } from '#libs/db/index.js';
import type { Locale } from '#libs/i18n/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { toPublicLocation } from '../api/public-projections.js';
import { ProviderBooking, type BookableProvider, type BookingLocation } from '../interface/booking.js';

@Injectable()
export class DbProviderBooking extends ProviderBooking {
  async provider(scope: TxScope, orgId: string): Promise<BookableProvider | null> {
    const p = await scope.db
      .selectFrom('organization.provider_profiles as p')
      .innerJoin('organization.organizations as o', 'o.id', 'p.organization_id')
      .select(['p.service_modes'])
      .where('p.organization_id', '=', orgId)
      .where('p.public_status', '=', 'published')
      .where('p.deleted_at', 'is', null)
      .where('o.status', '=', 'active')
      .where('o.deleted_at', 'is', null)
      .executeTakeFirst();
    if (!p) return null;
    return { orgId, serviceModes: textArray(p.service_modes), locationIds: await this.locationIds(scope, orgId) };
  }

  async locationIds(scope: TxScope, orgId: string): Promise<string[]> {
    const rows = await scope.db
      .selectFrom('organization.organization_locations')
      .select('id')
      .where('organization_id', '=', orgId)
      .where('status', '=', 'active')
      .where('deleted_at', 'is', null)
      .orderBy('is_primary', 'desc')
      .orderBy('id')
      .execute();
    return rows.map((l) => l.id);
  }

  async locations(scope: TxScope, ids: readonly string[], locale: Locale, now = new Date()): Promise<Map<string, BookingLocation>> {
    const unique = [...new Set(ids)].slice(0, 500);
    if (unique.length === 0) return new Map();
    const rows = await scope.db
      .selectFrom('organization.organization_locations')
      .selectAll()
      .where('id', 'in', unique)
      .where('deleted_at', 'is', null)
      .execute();
    return new Map(
      rows.map((l) => [
        l.id,
        {
          id: l.id,
          organizationId: l.organization_id,
          timezone: l.timezone,
          public: toPublicLocation(l, locale, now),
          exact: {
            address_line_1: l.address_line_1,
            address_line_2: l.address_line_2,
            point: { lat: Number(l.latitude), lng: Number(l.longitude) },
          },
        },
      ]),
    );
  }
}
