// Organizations on the admin plane (40 §23.2; 52 Organization,
// OrganizationVerification, OrganizationLocation; SEC-ADM). Staff search and
// read organizations (reads of private data with a purpose and a pii.read
// audit entry), suspend, reactivate or archive them (suspension takes the
// public profiles off search and the map), merge duplicates after a second
// approver, decide verification checks (an organization is verified only when
// business identity and location are verified; a far_apart pin is corrected
// first) and correct pins and addresses (geo_source admin_corrected, the
// organization is told through organization.location.corrected).
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { writeAudit } from '#libs/audit/index.js';
import { Authorizer } from '#libs/authz/index.js';
import { ApiError } from '#libs/contract/index.js';
import { Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { auditStaffRead, FourEyes, ModerationLog, staffOf, type Staff } from '#modules/admin/interface/admin.js';
import { SubscriptionReader } from '#modules/billing/interface/billing.js';
import { OrgMemberships } from '#modules/identity/interface/identity.js';
import { toLocation, toOrganization, toVerification, type OrgRow, type VerificationRow } from '../api/projections.js';
import { OrgCards, toOrgSummary } from '../interface/org-cards.js';
import { afterId, failIf, publicationChanged } from './common.js';
import { LocationChecker } from './location-ops.js';

const ORG_ROLES = [
  'provider_owner',
  'provider_manager',
  'provider_staff',
  'vendor_owner',
  'vendor_staff',
  'fleet_owner',
  'fleet_manager',
  'fleet_maintenance_coordinator',
  'fleet_driver',
  'fleet_viewer',
];

async function loadOrgRow(scope: TxScope, id: string, lock = false): Promise<OrgRow> {
  const q = scope.db.selectFrom('organization.organizations').selectAll().where('id', '=', id).where('deleted_at', 'is', null);
  const o = await (lock ? q.forUpdate() : q).executeTakeFirst();
  if (!o) throw new ApiError('NOT_FOUND');
  return o;
}

/** 40 StaffOrgView. */
@Injectable()
export class StaffOrgViews {
  constructor(
    private readonly subscriptions: SubscriptionReader,
    private readonly members: OrgMemberships,
    private readonly moderation: ModerationLog,
  ) {}

  async view(scope: TxScope, o: OrgRow, s: Staff) {
    const [locations, verifications, subscription, memberCount, openCases] = await Promise.all([
      scope.db
        .selectFrom('organization.organization_locations')
        .selectAll()
        .where('organization_id', '=', o.id)
        .where('deleted_at', 'is', null)
        .orderBy('id')
        .limit(50)
        .execute(),
      scope.db
        .selectFrom('organization.organization_verifications')
        .selectAll()
        .where('organization_id', '=', o.id)
        .where('deleted_at', 'is', null)
        .orderBy('id', 'desc')
        .limit(50)
        .execute(),
      this.subscriptions.staffSubscription(scope, { type: 'organization', id: o.id }),
      this.members.countActive(scope, o.id, ORG_ROLES),
      this.moderation.openCases(scope, 'organization', o.id),
    ]);
    if (!subscription) throw new ApiError('INTERNAL', { detail: `organization ${o.id} has no subscription` });
    return {
      ...toOrganization(o, s.roles[0] ?? 'platform_support'),
      locations: locations.map(toLocation),
      verifications: verifications.map(toVerification),
      subscription,
      member_count: memberCount,
      open_cases: openCases,
    };
  }
}

type OrgSearch = {
  name?: string;
  slug?: string;
  organization_id?: string;
  status?: string;
  verification_status?: string;
  organization_type?: string;
  limit?: number;
};

@Injectable()
@Operation('admin.orgs_search')
export class AdminOrgsSearchHandler implements OperationHandler {
  constructor(private readonly views: StaffOrgViews) {}

  async handle(ctx: OperationContext<OrgSearch>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const b = ctx.body;
    const limit = b.limit ?? 20;
    const after = afterId(ctx);
    const body = await ctx.tx(
      async (scope) => {
        let q = scope.db.selectFrom('organization.organizations').selectAll().where('deleted_at', 'is', null);
        if (b.name) q = q.where('name', 'ilike', `%${b.name.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
        if (b.slug) q = q.where('slug', '=', b.slug);
        if (b.organization_id) q = q.where('id', '=', b.organization_id);
        if (b.status) q = q.where('status', '=', b.status);
        if (b.verification_status) q = q.where('verification_status', '=', b.verification_status);
        if (b.organization_type) q = q.where('organization_type', '=', b.organization_type);
        if (after) q = q.where('id', '>', after);
        const rows = await q
          .orderBy('id')
          .limit(limit + 1)
          .execute();
        const page = rows.slice(0, limit);
        const items = [];
        for (const o of page) items.push(await this.views.view(scope, o, s));
        return ctx.page(items, rows.length > limit ? { id: page.at(-1)!.id } : null);
      },
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('admin.org_get')
export class AdminOrgGetHandler implements OperationHandler {
  constructor(private readonly views: StaffOrgViews) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const s = staffOf(ctx);
    const body = await ctx.tx(async (scope) => {
      const o = await loadOrgRow(scope, ctx.params.org_id!);
      await auditStaffRead(scope, s, 'organization', o.id, 'organization view');
      return this.views.view(scope, o, s);
    });
    return { body };
  }
}

const STATUS_FROM: Record<string, string[]> = {
  active: ['draft', 'pending_verification', 'suspended', 'archived'],
  suspended: ['draft', 'pending_verification', 'active'],
  archived: ['draft', 'pending_verification', 'active', 'suspended'],
};

/** Moves both public profiles with the organization (suspension leaves search and the map; reactivation restores them). */
async function profilesFollow(scope: TxScope, orgId: string, from: string, to: string): Promise<void> {
  for (const side of ['provider', 'vendor'] as const) {
    const table = side === 'provider' ? 'organization.provider_profiles' : 'organization.vendor_profiles';
    const rows = await scope.db
      .updateTable(table)
      .set({ public_status: to })
      .where('organization_id', '=', orgId)
      .where('public_status', '=', from)
      .returning('id')
      .execute();
    for (const r of rows) await publicationChanged(scope, orgId, side, to === 'published' ? 'published' : 'unpublished', r.id);
  }
}

@Injectable()
@Operation('admin.org_status')
export class AdminOrgStatusHandler implements OperationHandler {
  constructor(
    private readonly views: StaffOrgViews,
    private readonly moderation: ModerationLog,
    private readonly authorizer: Authorizer,
  ) {}

  async handle(ctx: OperationContext<{ status: 'active' | 'suspended' | 'archived'; reason: string }>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const b = ctx.body;
    const body = await ctx.tx(async (scope) => {
      const o = await loadOrgRow(scope, ctx.params.org_id!, true);
      if (!STATUS_FROM[b.status]!.includes(o.status)) throw new ApiError('INVALID_TRANSITION', { detail: `${o.status} → ${b.status}` });
      const row = await scope.db
        .updateTable('organization.organizations')
        .set({ status: b.status })
        .where('id', '=', o.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (b.status === 'active') await profilesFollow(scope, o.id, 'suspended', 'published');
      else await profilesFollow(scope, o.id, 'published', 'suspended');
      const actionType = b.status === 'active' ? 'reactivate_account' : 'suspend_account';
      const id = await this.moderation.record(scope, {
        targetType: 'organization',
        targetId: o.id,
        actionType,
        reason: b.reason,
        params: { status: b.status, previous: o.status },
        actorUserId: s.userId,
      });
      await writeAudit(scope, {
        action: 'organization.status_changed',
        entityType: 'organization',
        entityId: o.id,
        reason: b.reason,
        previous: o.status,
        next: b.status,
      });
      await publishEvent(scope, {
        type: 'moderation.action.taken',
        aggregateType: 'moderation_action',
        aggregateId: id,
        payload: { action_type: actionType, target_type: 'organization', target_id: o.id, organization_id: o.id, status: b.status },
      });
      scope.afterCommit(() => this.authorizer.invalidateOrganization(o.id));
      return this.views.view(scope, row, s);
    });
    return { body };
  }
}

@Injectable()
@Operation('admin.org_merge')
export class AdminOrgMergeHandler implements OperationHandler {
  constructor(private readonly fourEyes: FourEyes) {}

  async handle(ctx: OperationContext<{ into_organization_id: string; reason: string }>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const b = ctx.body;
    const body = await ctx.tx(async (scope) => {
      const [from, into] = await mergePair(scope, ctx.params.org_id!, b.into_organization_id);
      return this.fourEyes.request(
        scope,
        s.userId,
        {
          opId: 'admin.org_merge',
          targetType: 'organization',
          targetId: from.id,
          payload: { org_id: from.id, into_organization_id: into.id },
          summary: `Merge "${from.name}" (${from.id}) into "${into.name}" (${into.id})`,
          reason: b.reason,
          requiredRole: 'platform_admin',
        },
        ctx.locale,
      );
    });
    return { status: 202, body };
  }
}

/** The organizations of a merge: distinct, same kind of business, neither merged nor archived. */
async function mergePair(scope: TxScope, fromId: string, intoId: string): Promise<[OrgRow, OrgRow]> {
  const from = await loadOrgRow(scope, fromId, true);
  if (fromId === intoId) failIf([{ pointer: '/into_organization_id', code: 'conditional_forbidden' }]);
  const into = await scope.db
    .selectFrom('organization.organizations')
    .selectAll()
    .where('id', '=', intoId)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  if (!into) throw ApiError.validation([{ pointer: '/into_organization_id', code: 'reference_not_found' }], 'REFERENCE_NOT_FOUND');
  for (const o of [from, into])
    if (['merged', 'archived'].includes(o.status)) throw new ApiError('INVALID_TRANSITION', { detail: `${o.id} ${o.status}` });
  const kind = (t: string) => (t === 'fleet' ? 'fleet' : 'business');
  if (kind(from.organization_type) !== kind(into.organization_type))
    throw new ApiError('INVALID_TRANSITION', { detail: 'different organization kinds' });
  return [from, into];
}

/** Four-eyes executor of admin.org_merge: the duplicate becomes merged and leaves publication; references resolve through merged_into_organization_id. */
export async function mergeOrganization(
  scope: TxScope,
  authorizer: Authorizer,
  fromId: string,
  intoId: string,
  reason: string,
): Promise<void> {
  const [from, into] = await mergePair(scope, fromId, intoId);
  await scope.db
    .updateTable('organization.organizations')
    .set({ status: 'merged', merged_into_organization_id: into.id })
    .where('id', '=', from.id)
    .execute();
  await profilesFollow(scope, from.id, 'published', 'draft');
  await writeAudit(scope, {
    action: 'organization.merged',
    entityType: 'organization',
    entityId: from.id,
    reason,
    previous: from.status,
    next: `merged into ${into.id}`,
  });
  await publishEvent(scope, {
    type: 'moderation.action.taken',
    aggregateType: 'organization',
    aggregateId: from.id,
    payload: {
      action_type: 'merge_duplicate',
      target_type: 'organization',
      target_id: from.id,
      organization_id: from.id,
      merged_into_organization_id: into.id,
    },
  });
  scope.afterCommit(() => authorizer.invalidateOrganization(from.id));
}

@Injectable()
@Operation('admin.verifications_queue')
export class AdminVerificationsQueueHandler implements OperationHandler {
  constructor(
    private readonly orgs: OrgCards,
    private readonly moderation: ModerationLog,
    private readonly checker: LocationChecker,
  ) {}

  async handle(ctx: OperationContext<undefined, { status?: string; verification_type?: string; limit: number }>): Promise<OperationResult> {
    staffOf(ctx);
    const q = ctx.query;
    const after = afterId(ctx);
    const body = await ctx.tx(
      async (scope) => {
        let v = scope.db.selectFrom('organization.organization_verifications').selectAll().where('deleted_at', 'is', null);
        v = v.where('status', '=', q.status ?? 'pending');
        if (q.verification_type) v = v.where('verification_type', '=', q.verification_type);
        if (after) v = v.where('id', '>', after);
        const rows = await v
          .orderBy('id')
          .limit(q.limit + 1)
          .execute();
        const page = rows.slice(0, q.limit);
        const cards = await this.orgs.cards(
          scope,
          page.map((r) => r.organization_id),
        );
        const items = [];
        for (const r of page) {
          const card = cards.get(r.organization_id);
          if (!card) continue;
          const primary = await scope.db
            .selectFrom('organization.organization_locations')
            .select(['geo_address_distance_m', 'location_check_status'])
            .where('organization_id', '=', r.organization_id)
            .where('status', '=', 'active')
            .where('deleted_at', 'is', null)
            .orderBy('is_primary', 'desc')
            .orderBy('id')
            .executeTakeFirst();
          const locationIds = (
            await scope.db
              .selectFrom('organization.organization_locations')
              .select('id')
              .where('organization_id', '=', r.organization_id)
              .execute()
          ).map((l) => l.id);
          let wrong = await this.moderation.reportsAgainst(scope, 'organization', r.organization_id, 'wrong_location_or_closed');
          for (const id of locationIds)
            wrong += await this.moderation.reportsAgainst(scope, 'organization_location', id, 'wrong_location_or_closed');
          items.push({
            ...toVerification(r),
            organization: toOrgSummary(card),
            location_check:
              (r.verification_type === 'location' || r.verification_type === 'address') && primary
                ? {
                    geocoded_point: null,
                    distance_m: primary.geo_address_distance_m,
                    location_check_status: primary.location_check_status,
                    threshold_m: this.checker.thresholdM,
                  }
                : null,
            wrong_location_reports: Math.min(10_000, wrong),
          });
        }
        return ctx.page(items, rows.length > q.limit ? { id: page.at(-1)!.id } : null);
      },
      { readOnly: true },
    );
    return { body };
  }
}

/** 52 §21 / 54 §4: verified when business identity and location are verified and unexpired. */
async function recomputeVerification(scope: TxScope, orgId: string): Promise<{ previous: string; next: string }> {
  const o = await loadOrgRow(scope, orgId, true);
  const rows = await scope.db
    .selectFrom('organization.organization_verifications')
    .select(['verification_type', 'status', 'expires_at'])
    .where('organization_id', '=', orgId)
    .where('deleted_at', 'is', null)
    .execute();
  const live = (t: string) =>
    rows.some((r) => r.verification_type === t && r.status === 'verified' && (!r.expires_at || r.expires_at > new Date()));
  let next: string;
  if (live('business_identity') && live('location')) next = 'verified';
  else if (rows.some((r) => r.status === 'pending')) next = 'pending';
  else if (rows.some((r) => r.verification_type === 'business_identity' && r.status === 'rejected')) next = 'rejected';
  else next = 'unverified';
  if (next !== o.verification_status)
    await scope.db.updateTable('organization.organizations').set({ verification_status: next }).where('id', '=', orgId).execute();
  return { previous: o.verification_status, next };
}

@Injectable()
@Operation('admin.verification_decide')
export class AdminVerificationDecideHandler implements OperationHandler {
  constructor(private readonly moderation: ModerationLog) {}

  async handle(
    ctx: OperationContext<{ decision: 'verified' | 'rejected'; rejection_reason?: string; reason: string }>,
  ): Promise<OperationResult> {
    const s = staffOf(ctx);
    const b = ctx.body;
    if (b.decision === 'rejected' && !b.rejection_reason) failIf([{ pointer: '/rejection_reason', code: 'conditional_required' }]);
    if (b.decision === 'verified' && b.rejection_reason) failIf([{ pointer: '/rejection_reason', code: 'conditional_forbidden' }]);
    const body = await ctx.tx(async (scope) => {
      const v = (await scope.db
        .selectFrom('organization.organization_verifications')
        .selectAll()
        .where('id', '=', ctx.params.verification_id!)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst()) as VerificationRow | undefined;
      if (!v) throw new ApiError('NOT_FOUND');
      if (v.status !== 'pending') throw new ApiError('INVALID_TRANSITION', { detail: v.status });
      const location = v.verification_type === 'location' || v.verification_type === 'address';
      if (location && b.decision === 'verified') {
        const far = await scope.db
          .selectFrom('organization.organization_locations')
          .select('id')
          .where('organization_id', '=', v.organization_id)
          .where('status', '=', 'active')
          .where('location_check_status', '=', 'far_apart')
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        if (far) throw new ApiError('INVALID_TRANSITION', { detail: 'far_apart' });
      }
      const row = await scope.db
        .updateTable('organization.organization_verifications')
        .set({ status: b.decision, reviewed_by: s.userId, reviewed_at: sql<Date>`now()`, rejection_reason: b.rejection_reason ?? null })
        .where('id', '=', v.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (location && b.decision === 'verified')
        await scope.db
          .updateTable('organization.organization_locations')
          .set({ location_verified_at: sql<Date>`now()` })
          .where('organization_id', '=', v.organization_id)
          .where('status', '=', 'active')
          .where('deleted_at', 'is', null)
          .execute();
      const change = await recomputeVerification(scope, v.organization_id);
      await this.moderation.record(scope, {
        targetType: 'organization',
        targetId: v.organization_id,
        actionType: b.decision === 'verified' ? 'verify_organization' : 'reject_verification',
        reason: b.reason,
        params: { verification_id: v.id, verification_type: v.verification_type },
        actorUserId: s.userId,
      });
      await writeAudit(scope, {
        action: 'organization.verification_decided',
        entityType: 'organization_verification',
        entityId: v.id,
        reason: b.reason,
        previous: `${v.verification_type} pending; organization ${change.previous}`,
        next: `${b.decision}; organization ${change.next}`,
        accessPurpose: s.purpose,
      });
      if (change.next === 'verified' && change.previous !== 'verified')
        await publishEvent(scope, {
          type: 'organization.verified',
          aggregateType: 'organization',
          aggregateId: v.organization_id,
          payload: { organization_id: v.organization_id },
        });
      return toVerification(row);
    });
    return { body };
  }
}

type LocationCorrection = {
  pin?: { lat: number; lng: number };
  address_line_1?: string;
  address_line_2?: string | null;
  city?: string;
  region?: string | null;
  postal_code?: string | null;
  reason: string;
};

@Injectable()
@Operation('admin.location_correct')
export class AdminLocationCorrectHandler implements OperationHandler {
  constructor(
    private readonly checker: LocationChecker,
    private readonly moderation: ModerationLog,
  ) {}

  async handle(ctx: OperationContext<LocationCorrection>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const b = ctx.body;
    const fields = ['pin', 'address_line_1', 'address_line_2', 'city', 'region', 'postal_code'] as const;
    if (!fields.some((f) => b[f] !== undefined)) failIf([{ pointer: '/pin', code: 'conditional_required' }]);
    const body = await ctx.tx(async (scope) => {
      const loc = await scope.db
        .selectFrom('organization.organization_locations')
        .selectAll()
        .where('id', '=', ctx.params.location_id!)
        .where('organization_id', '=', ctx.params.org_id!)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!loc) throw new ApiError('NOT_FOUND');
      const pin = b.pin ?? { lat: Number(loc.latitude), lng: Number(loc.longitude) };
      const check = await this.checker.check(
        {
          address_line_1: b.address_line_1 ?? loc.address_line_1,
          city: b.city ?? loc.city,
          postal_code: b.postal_code !== undefined ? b.postal_code : loc.postal_code,
          country: loc.country,
        },
        pin,
      );
      const row = await scope.db
        .updateTable('organization.organization_locations')
        .set({
          ...(b.pin ? { latitude: b.pin.lat, longitude: b.pin.lng } : {}),
          ...(b.address_line_1 !== undefined ? { address_line_1: b.address_line_1 } : {}),
          ...(b.address_line_2 !== undefined ? { address_line_2: b.address_line_2 } : {}),
          ...(b.city !== undefined ? { city: b.city } : {}),
          ...(b.region !== undefined ? { region: b.region } : {}),
          ...(b.postal_code !== undefined ? { postal_code: b.postal_code } : {}),
          geo_source: 'admin_corrected',
          geo_address_distance_m: check.distance_m,
          // Staff confirmed the point: the pin-versus-address check is resolved (52 OrganizationLocation).
          location_check_status: 'consistent',
        })
        .where('id', '=', loc.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.moderation.record(scope, {
        targetType: 'organization_location',
        targetId: loc.id,
        actionType: 'correct_location',
        reason: b.reason,
        params: { subject_organization_id: loc.organization_id, fields: fields.filter((f) => b[f] !== undefined) },
        actorUserId: s.userId,
      });
      await writeAudit(scope, {
        action: 'organization.location_corrected',
        entityType: 'organization_location',
        entityId: loc.id,
        reason: b.reason,
        previous: `${loc.city} (${loc.geo_source})`,
        next: `${row.city} (admin_corrected)`,
      });
      await publishEvent(scope, {
        type: 'organization.location.corrected',
        aggregateType: 'organization_location',
        aggregateId: loc.id,
        payload: { organization_id: loc.organization_id, location_id: loc.id },
      });
      return toLocation(row);
    });
    return { body };
  }
}
