// Helpers shared by the appointment use cases (40 §16): who the caller is on
// each side, loading an appointment with the side's owner predicate (RLS
// party_all is the second wall), the 40 Appointment view with its derived
// fields, and keyset paging.
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { ApiError, type FieldError } from '#libs/contract/index.js';
import type { OperationContext } from '#libs/http-pipeline/index.js';
import type { L10n, Locale } from '#libs/i18n/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { authorDisplayName, UserCards } from '#modules/identity/interface/identity.js';
import { ProviderBooking } from '#modules/organization/interface/booking.js';
import { OrgCards } from '#modules/organization/interface/org-cards.js';
import { PublicOrgCards, type PublicOrgCard } from '#modules/organization/interface/public-profiles.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { REVIEW_WINDOW_MS, TrustRead } from '#modules/trust/interface/trust.js';
import { VehicleCards } from '#modules/vehicle/interface/vehicles.js';
import { toAppointment, type AppointmentRow, type WindowRow } from '../api/projections.js';
import { PATH1_DELAY_MS, visitTookPlace, type Side } from '../domain/rules.js';

/** The requester of {A} routes: the user ({me}) or the fleet organization ({flt}, FC/F*). */
export interface Requester {
  userId: string;
  orgId: string | null;
  /** A fleet driver (F* includes fleet_driver, DRV): only their own requests until S8 binds assignments (GD-20). */
  driver: boolean;
}

export function requester(ctx: OperationContext): Requester {
  if (ctx.principal.kind !== 'user') throw new ApiError('NOT_FOUND');
  const org = ctx.access.org;
  if (!org) return { userId: ctx.principal.userId, orgId: null, driver: false };
  return { userId: ctx.principal.userId, orgId: org.id, driver: org.role === 'fleet_driver' || ctx.access.matchedGroups.includes('DRV') };
}

export interface ProviderMember {
  userId: string;
  orgId: string;
  role: string;
}

export function providerMember(ctx: OperationContext): ProviderMember {
  const org = ctx.access.org;
  if (ctx.principal.kind !== 'user' || !org) throw new ApiError('NOT_FOUND');
  return { userId: ctx.principal.userId, orgId: org.id, role: org.role };
}

export const basePath = (r: Requester) => (r.orgId ? `/v1/orgs/${r.orgId}/fleet/appointments` : '/v1/me/appointments');

/** The appointment on the requester side (owner predicate on top of RLS party_all). */
export async function loadAsRequester(scope: TxScope, r: Requester, id: string, lock = false): Promise<AppointmentRow> {
  let q = scope.db.selectFrom('appointment.appointments').selectAll().where('id', '=', id).where('deleted_at', 'is', null);
  q = r.orgId
    ? q.where('requester_organization_id', '=', r.orgId)
    : q.where('requester_type', '=', 'user').where('requester_user_id', '=', r.userId);
  if (r.driver) q = q.where('requester_user_id', '=', r.userId);
  const row = await (lock ? q.forUpdate() : q).executeTakeFirst();
  if (!row) throw new ApiError('NOT_FOUND');
  return row;
}

export async function loadAsProvider(scope: TxScope, orgId: string, id: string, lock = false): Promise<AppointmentRow> {
  const q = scope.db
    .selectFrom('appointment.appointments')
    .selectAll()
    .where('id', '=', id)
    .where('provider_organization_id', '=', orgId)
    .where('deleted_at', 'is', null);
  const row = await (lock ? q.forUpdate() : q).executeTakeFirst();
  // Drafts are the requester's own: the provider sees an appointment once it is requested.
  if (!row || row.status === 'draft') throw new ApiError('NOT_FOUND');
  return row;
}

export function failIf(errors: FieldError[]): void {
  if (errors.length) throw ApiError.validation(errors);
}

export const notFoundAt = (pointer: string): ApiError =>
  ApiError.validation([{ pointer, code: 'reference_not_found' }], 'REFERENCE_NOT_FOUND');

type Position = { id?: string } | undefined;
export const afterId = (ctx: OperationContext): string | undefined => (ctx.cursor as Position)?.id;

export function pageOf<R extends { id: string }, T>(ctx: OperationContext<unknown, { limit: number }>, rows: R[], items: T[]) {
  const limit = ctx.query.limit;
  return ctx.page(items.slice(0, limit), rows.length > limit ? { id: rows[limit - 1]!.id } : null);
}

/** Sets the side for the status triggers (appointment.caller_side) when the RLS context cannot tell (a provider member requesting nothing). */
export async function setSide(scope: TxScope, side: Side | 'system', reason?: string | null): Promise<void> {
  await sql`SELECT set_config('app.actor_side', ${side}, true), set_config('app.change_reason', ${reason ?? ''}, true)`.execute(scope.db);
}

/** Path 1 window end of a visit (52 §21): its invitation's expiry, else 7 days after it took place. */
export function reviewWindowEnd(a: AppointmentRow, invitationExpiresAt: Date | null): number | null {
  if (invitationExpiresAt) return invitationExpiresAt.getTime();
  const tookPlace = a.completed_at
    ? new Date(a.completed_at).getTime()
    : a.confirmed_start_at
      ? new Date(a.confirmed_start_at).getTime() + PATH1_DELAY_MS
      : null;
  return tookPlace === null ? null : tookPlace + REVIEW_WINDOW_MS;
}

@Injectable()
export class AppointmentViews {
  constructor(
    private readonly cards: PublicOrgCards,
    private readonly orgCards: OrgCards,
    private readonly users: UserCards,
    private readonly booking: ProviderBooking,
    private readonly vehicles: VehicleCards,
    private readonly taxonomy: TaxonomyResolver,
    private readonly trust: TrustRead,
  ) {}

  /** Public cards, with a minimal card for providers no longer published (the appointment stays visible to both sides). */
  async providerCards(scope: TxScope, ids: readonly string[], locale: Locale): Promise<Map<string, PublicOrgCard>> {
    const unique = [...new Set(ids)];
    const out = await this.cards.cards(scope, unique, locale);
    const missing = unique.filter((id) => !out.has(id));
    if (missing.length)
      for (const c of (await this.orgCards.cards(scope, missing)).values())
        out.set(c.id, {
          id: c.id,
          slug: c.slug,
          name: c.name,
          organization_type: c.organizationType,
          roles: [],
          verified: c.verificationStatus === 'verified',
          overall_rating: null,
          review_count: 0,
          top_badges: [],
          price_tier: null,
          measured_response_time_minutes: null,
          logo_url: c.logoUrl,
          portfolio_thumbnail_url: null,
        });
    return out;
  }

  /** Display names of requesters (fleet: organization name; user: display name), Str<2,120>. */
  async requesterNames(scope: TxScope, rows: readonly AppointmentRow[], locale: Locale): Promise<Map<string, string>> {
    const orgs = await this.orgCards.cards(
      scope,
      rows.map((r) => r.requester_organization_id).filter((x): x is string => !!x),
    );
    const users = await this.users.cards(
      scope,
      rows.filter((r) => !r.requester_organization_id).map((r) => r.requester_user_id),
    );
    return new Map(
      rows.map((r) => {
        const org = r.requester_organization_id ? orgs.get(r.requester_organization_id)?.name?.trim() : undefined;
        const name = org && org.length >= 2 ? org.slice(0, 120) : authorDisplayName(users.get(r.requester_user_id), locale);
        return [r.id, name];
      }),
    );
  }

  async labels(ids: (string | null | undefined)[], locale: Locale): Promise<Map<string, L10n>> {
    return this.taxonomy.labels(
      ids.filter((x): x is string => !!x),
      locale,
    );
  }

  async many(scope: TxScope, rows: readonly AppointmentRow[], side: Side, locale: Locale, o: { contact?: boolean } = {}) {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const [providers, locations, vehicles, names, windows, records, reviewState] = await Promise.all([
      this.providerCards(
        scope,
        rows.map((r) => r.provider_organization_id),
        locale,
      ),
      this.booking.locations(
        scope,
        rows.map((r) => r.provider_location_id).filter((x): x is string => !!x),
        locale,
      ),
      this.vehicles.cards(
        scope,
        rows.map((r) => r.vehicle_id),
      ),
      this.requesterNames(scope, rows, locale),
      scope.db
        .selectFrom('appointment.appointment_time_windows')
        .selectAll()
        .where('appointment_id', 'in', ids)
        .where('deleted_at', 'is', null)
        .orderBy('priority')
        .orderBy('start_at')
        .execute(),
      this.vehicles.appointmentRecords(scope, ids),
      side === 'requester' && scope.context.userId
        ? this.trust.appointmentReviewState(scope, scope.context.userId, ids)
        : Promise.resolve(new Map<string, { reviewed: boolean; invitationExpiresAt: Date | null }>()),
    ]);
    const labels = await this.labels(
      [
        ...rows.flatMap((r) => [r.service_system_node_id, r.service_task_node_id, r.symptom_node_id]),
        ...[...vehicles.values()].flatMap((v) => [v.brandNodeId, v.modelNodeId, v.seriesNodeId]),
      ],
      locale,
    );
    const now = Date.now();
    const out = [];
    for (const r of rows) {
      const provider = providers.get(r.provider_organization_id);
      if (!provider) throw new ApiError('INTERNAL', { detail: `appointment ${r.id}: provider card missing` });
      let contact: { channel: string; value: string } | null = null;
      if (side === 'provider' && o.contact) {
        const { rows: c } = await sql<{ channel: string; value: string }>`
          SELECT channel, value FROM appointment.requester_contact(${r.id}::uuid)`.execute(scope.db);
        contact = c[0] ?? null;
      }
      const state = reviewState.get(r.id);
      const windowEnd = reviewWindowEnd(r, state?.invitationExpiresAt ?? null);
      out.push(
        toAppointment(r, {
          side,
          provider,
          location: r.provider_location_id ? locations.get(r.provider_location_id) : undefined,
          vehicle: vehicles.get(r.vehicle_id),
          labels,
          requesterDisplay: names.get(r.id) ?? 'CarPal user',
          windows: windows.filter((w) => w.appointment_id === r.id) as WindowRow[],
          serviceRecordId: records.get(r.id) ?? null,
          canReview:
            side === 'requester' &&
            r.requester_user_id === scope.context.userId &&
            visitTookPlace(r, now) &&
            !state?.reviewed &&
            windowEnd !== null &&
            now <= windowEnd,
          contact,
        }),
      );
    }
    return out;
  }

  async one(scope: TxScope, row: AppointmentRow, side: Side, locale: Locale, o: { contact?: boolean } = {}) {
    return (await this.many(scope, [row], side, locale, o))[0]!;
  }
}
