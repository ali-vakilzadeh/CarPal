// Organizations on the admin plane (40 §23.2; 52 Organization,
// OrganizationVerification, OrganizationLocation; SEC-ADM). Staff search and
// read organizations (reads of private data with a purpose and a pii.read
// audit entry), suspend, reactivate or archive them (suspension takes the
// public profiles off search and the map), merge duplicates after a second
// approver, decide verification checks (an organization is verified only when
// business identity and location are verified; a far_apart pin is corrected
// first) and correct pins and addresses (geo_source admin_corrected, the
// organization is told through organization.location.corrected).
// Backend S19 (BR-35): search filters (city, plan, open cases, location issue,
// possible duplicate), requests for more information on a check (it stays
// pending and its review clock pauses until the business resubmits), check
// assignment, profile corrections and the profile history.
import { Injectable } from '@nestjs/common';
import { sql, type Expression, type SqlBool } from 'kysely';
import { writeAudit } from '#libs/audit/index.js';
import { Authorizer, MembershipDirectory } from '#libs/authz/index.js';
import { ApiError } from '#libs/contract/index.js';
import { textArray } from '#libs/db/index.js';
import {
  iso,
  isoOrNull,
  Operation,
  type OperationContext,
  type OperationHandler,
  type OperationResult,
} from '#libs/http-pipeline/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { auditStaffRead, ModerationLog, StaffNames, staffOf, type Staff } from '#modules/admin/interface/admin.js';
import { SubscriptionReader } from '#modules/billing/interface/billing.js';
import { OrgMemberships } from '#modules/identity/interface/identity.js';
import { toLocation, toOrganization, toVerification, type OrgRow, type VerificationRow } from '../api/projections.js';
import { ownerRoleFor } from '../domain/roles.js';
import { OrgCards, toOrgSummary } from '../interface/org-cards.js';
import {
  afterId,
  failIf,
  json,
  latestInfoRequests,
  profileDiff,
  profilesFollow,
  profileUpdated,
  recordProfileChange,
  toVerifications,
  type StoredFieldChange,
} from './common.js';
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
      verifications: await toVerifications(scope, verifications),
      subscription,
      member_count: memberCount,
      open_cases: openCases,
    };
  }
}

/**
 * 40 StaffOrgSearchRow (backend S14, admin console BR-35 part 1, DI-31): what a staff queue needs to find an
 * organization, without a purpose. No contact data and no location points: those are admin.org_get (PURP PII).
 */
@Injectable()
export class StaffOrgSearchRows {
  constructor(
    private readonly subscriptions: SubscriptionReader,
    private readonly members: OrgMemberships,
    private readonly moderation: ModerationLog,
  ) {}

  /**
   * S19 (BR-35 part 1): the organizations among `ids` with a location issue (an active pin far_apart from its address,
   * or an open wrong-location report about the organization or one of its locations).
   */
  async locationIssues(scope: TxScope, ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const locations = await scope.db
      .selectFrom('organization.organization_locations')
      .select(['id', 'organization_id', 'status', 'location_check_status'])
      .where('organization_id', 'in', [...ids])
      .where('deleted_at', 'is', null)
      .execute();
    const out = new Set(
      locations.filter((l) => l.status === 'active' && l.location_check_status === 'far_apart').map((l) => l.organization_id),
    );
    const reported = await this.moderation.withOpenReports(
      scope,
      [...ids.map((id) => ({ type: 'organization', id })), ...locations.map((l) => ({ type: 'organization_location', id: l.id }))],
      'wrong_location_or_closed',
    );
    for (const id of ids) if (reported.has(`organization:${id}`)) out.add(id);
    for (const l of locations) if (reported.has(`organization_location:${l.id}`)) out.add(l.organization_id);
    return out;
  }

  /** S19: the organizations among `ids` that may be duplicates (POSSIBLE_DUPLICATE). */
  async duplicates(scope: TxScope, ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await scope.db
      .selectFrom('organization.organizations as o')
      .select('o.id')
      .where('o.id', 'in', [...ids])
      .where(possibleDuplicate())
      .execute();
    return new Set(rows.map((r) => r.id));
  }

  /** The page's rows with the S19 flags computed for the whole page. */
  async rows(scope: TxScope, page: readonly OrgRow[]) {
    const ids = page.map((o) => o.id);
    const [issues, duplicates] = await Promise.all([this.locationIssues(scope, ids), this.duplicates(scope, ids)]);
    const out = [];
    for (const o of page)
      out.push({ ...(await this.row(scope, o)), location_issue: issues.has(o.id), possible_duplicate: duplicates.has(o.id) });
    return out;
  }

  private async row(scope: TxScope, o: OrgRow) {
    const [locations, pending, subscription, memberCount, openCases] = await Promise.all([
      scope.db
        .selectFrom('organization.organization_locations')
        .select(['id', 'city', 'status'])
        .where('organization_id', '=', o.id)
        .where('deleted_at', 'is', null)
        .orderBy('id')
        .limit(50)
        .execute(),
      scope.db
        .selectFrom('organization.organization_verifications')
        .select(['id', 'verification_type', 'created_at'])
        .where('organization_id', '=', o.id)
        .where('status', '=', 'pending')
        .where('deleted_at', 'is', null)
        .orderBy('created_at')
        .limit(10)
        .execute(),
      this.subscriptions.staffSubscription(scope, { type: 'organization', id: o.id }),
      this.members.countActive(scope, o.id, ORG_ROLES),
      this.moderation.openCases(scope, 'organization', o.id),
    ]);
    const primary = locations.find((l) => l.id === o.primary_location_id) ?? locations.find((l) => l.status !== 'inactive');
    return {
      id: o.id,
      name: o.name,
      organization_type: o.organization_type,
      slug: o.slug,
      status: o.status,
      verification_status: o.verification_status,
      merged_into_organization_id: o.merged_into_organization_id,
      city: primary?.city ?? null,
      plan_key: (subscription as { plan?: { plan_key?: string } } | null)?.plan?.plan_key ?? null,
      member_count: memberCount,
      open_cases: openCases,
      trust_score: o.trust_score,
      pending_verifications: pending.map((v) => ({ id: v.id, verification_type: v.verification_type, created_at: iso(v.created_at) })),
      created_at: iso(o.created_at),
    };
  }
}

/**
 * S19 (BR-35 part 1): another live organization with the same normalized name in a city they share (active
 * locations), or the same contact phone. Merged and archived organizations are never flagged and never match.
 */
function possibleDuplicate(): Expression<SqlBool> {
  // Two EXISTS rather than one with an OR between the phone and the name tests: with the OR in the join filter neither
  // organizations_contact_phone_idx nor organizations_normalized_name_idx can be used and every organization is
  // compared with every other one (backend S26c, BR-36: 840 ms for a page of 12 on 2,700 organizations).
  return sql<SqlBool>`(o.status NOT IN ('merged','archived') AND (
    (o.contact_phone IS NOT NULL AND EXISTS (
      SELECT 1 FROM organization.organizations d
       WHERE d.contact_phone = o.contact_phone AND d.id <> o.id
         AND d.deleted_at IS NULL AND d.status NOT IN ('merged','archived')))
    OR EXISTS (
      SELECT 1 FROM organization.organizations d
       WHERE organization.normalized_name(d.name) = organization.normalized_name(o.name) AND d.id <> o.id
         AND d.deleted_at IS NULL AND d.status NOT IN ('merged','archived')
         AND EXISTS (SELECT 1 FROM organization.organization_locations l1
                       JOIN organization.organization_locations l2 ON lower(btrim(l2.city)) = lower(btrim(l1.city))
                      WHERE l1.organization_id = o.id AND l2.organization_id = d.id
                        AND l1.status = 'active' AND l2.status = 'active'
                        AND l1.deleted_at IS NULL AND l2.deleted_at IS NULL))))`;
}

type OrgSearch = {
  name?: string;
  slug?: string;
  organization_id?: string;
  status?: string;
  verification_status?: string;
  organization_type?: string;
  city?: string;
  plan_key?: string;
  has_open_cases?: boolean;
  location_issue?: boolean;
  possible_duplicate?: boolean;
  limit?: number;
};

/** Filters answered by other modules (billing, admin) are applied per batch of this many organizations… */
const SEARCH_BATCH = 200;
/** …up to this many per request; the page then ends early with a cursor (40 admin.orgs_search). */
const SEARCH_SCAN_MAX = 1000;

@Injectable()
@Operation('admin.orgs_search')
export class AdminOrgsSearchHandler implements OperationHandler {
  constructor(
    private readonly rows: StaffOrgSearchRows,
    private readonly subscriptions: SubscriptionReader,
    private readonly moderation: ModerationLog,
  ) {}

  /** The batch's organizations that pass the filters other modules answer (plan, open cases, location issue). */
  private async crossFilter(scope: TxScope, batch: OrgRow[], b: OrgSearch): Promise<OrgRow[]> {
    const ids = batch.map((o) => o.id);
    let keep = batch;
    if (b.plan_key !== undefined) {
      const plans = await this.subscriptions.staffPlanKeys(scope, 'organization', ids);
      keep = keep.filter((o) => plans.get(o.id) === b.plan_key);
    }
    if (b.has_open_cases !== undefined) {
      const open = await this.moderation.withOpenCases(
        scope,
        'organization',
        keep.map((o) => o.id),
      );
      keep = keep.filter((o) => open.has(o.id) === b.has_open_cases);
    }
    if (b.location_issue !== undefined) {
      const issues = await this.rows.locationIssues(
        scope,
        keep.map((o) => o.id),
      );
      keep = keep.filter((o) => issues.has(o.id) === b.location_issue);
    }
    return keep;
  }

  async handle(ctx: OperationContext<OrgSearch>): Promise<OperationResult> {
    staffOf(ctx);
    const b = ctx.body;
    const limit = b.limit ?? 20;
    const cross = b.plan_key !== undefined || b.has_open_cases !== undefined || b.location_issue !== undefined;
    const body = await ctx.tx(
      async (scope) => {
        const base = (after: string | undefined) => {
          let q = scope.db.selectFrom('organization.organizations as o').selectAll('o').where('o.deleted_at', 'is', null);
          if (b.name) q = q.where('o.name', 'ilike', `%${b.name.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
          if (b.slug) q = q.where('o.slug', '=', b.slug);
          if (b.organization_id) q = q.where('o.id', '=', b.organization_id);
          if (b.status) q = q.where('o.status', '=', b.status);
          if (b.verification_status) q = q.where('o.verification_status', '=', b.verification_status);
          if (b.organization_type) q = q.where('o.organization_type', '=', b.organization_type);
          if (b.city)
            q = q.where(
              sql<SqlBool>`EXISTS (SELECT 1 FROM organization.organization_locations l
                 WHERE l.organization_id = o.id AND l.status = 'active' AND l.deleted_at IS NULL
                   AND lower(btrim(l.city)) = lower(btrim(${b.city})))`,
            );
          if (b.possible_duplicate !== undefined)
            q = q.where(b.possible_duplicate ? possibleDuplicate() : sql<SqlBool>`NOT ${possibleDuplicate()}`);
          if (after) q = q.where('o.id', '>', after);
          return q.orderBy('o.id');
        };
        // Without the cross-module filters one query answers the page; with them, batches up to SEARCH_SCAN_MAX.
        const matched: OrgRow[] = [];
        let position = afterId(ctx);
        let scanned = 0;
        let exhausted = false;
        while (matched.length <= limit) {
          if (cross && scanned >= SEARCH_SCAN_MAX) break;
          const size = cross ? SEARCH_BATCH : limit + 1 - matched.length;
          const batch = await base(position).limit(size).execute();
          scanned += batch.length;
          if (batch.length > 0) position = batch.at(-1)!.id;
          matched.push(...(cross ? await this.crossFilter(scope, batch, b) : batch));
          if (batch.length < size) {
            exhausted = true;
            break;
          }
        }
        const page = matched.slice(0, limit);
        const next = matched.length > limit ? page.at(-1)!.id : exhausted ? null : position;
        return ctx.page(await this.rows.rows(scope, page), next ? { id: next } : null);
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

/** 40 StaffVerificationItem: a verification check with what the A-VER-01 queue and A-VER-02 review show (S19 additions). */
@Injectable()
export class StaffVerificationItems {
  constructor(
    private readonly orgs: OrgCards,
    private readonly moderation: ModerationLog,
    private readonly checker: LocationChecker,
    private readonly names: StaffNames,
    private readonly members: OrgMemberships,
    private readonly search: StaffOrgSearchRows,
  ) {}

  /**
   * One page of items. Everything that belongs to the organization rather than to the check is read once per kind for
   * the whole page, never per row (backend S26c, BR-36: a page of 50 took 8-10 s on the E2E-heavy database, from the
   * per-row reads and from the possible-duplicate test, see possibleDuplicate).
   */
  async items(scope: TxScope, page: readonly VerificationRow[], locale: string) {
    const orgIds = [...new Set(page.map((r) => r.organization_id))];
    const [cards, requests, duplicates, phones, primaries, locations] = await Promise.all([
      this.orgs.cards(scope, orgIds),
      latestInfoRequests(
        scope,
        page.map((r) => r.id),
      ),
      this.search.duplicates(scope, orgIds),
      // The latest phone check of each organization: the call-back result (Docs/23 A-VER-02 "contact verified").
      orgIds.length
        ? scope.db
            .selectFrom('organization.organization_verifications')
            .select(['organization_id', 'status'])
            .distinctOn('organization_id')
            .where('organization_id', 'in', orgIds)
            .where('verification_type', '=', 'phone')
            .where('deleted_at', 'is', null)
            .orderBy('organization_id')
            .orderBy('id', 'desc')
            .execute()
        : Promise.resolve([]),
      // The active primary location of each organization (a primary pin first, then the lowest id).
      orgIds.length
        ? scope.db
            .selectFrom('organization.organization_locations')
            .select(['organization_id', 'geo_address_distance_m', 'location_check_status'])
            .distinctOn('organization_id')
            .where('organization_id', 'in', orgIds)
            .where('status', '=', 'active')
            .where('deleted_at', 'is', null)
            .orderBy('organization_id')
            .orderBy('is_primary', 'desc')
            .orderBy('id')
            .execute()
        : Promise.resolve([]),
      // Every location id of each organization (wrong-location reports count against all of them).
      orgIds.length
        ? scope.db
            .selectFrom('organization.organization_locations')
            .select(['id', 'organization_id'])
            .where('organization_id', 'in', orgIds)
            .execute()
        : Promise.resolve([]),
    ]);
    const callback = new Map(phones.map((p) => [p.organization_id, p.status]));
    const primary = new Map(primaries.map((p) => [p.organization_id, p]));
    const known = orgIds.filter((id) => cards.has(id));
    const [owners, reports] = await Promise.all([
      this.members.firstActiveByRole(
        scope,
        known.map((orgId) => ({ orgId, role: ownerRoleFor(cards.get(orgId)!.organizationType) })),
      ),
      this.moderation.reportCounts(
        scope,
        [
          ...known.map((id) => ({ type: 'organization', id })),
          ...locations.filter((l) => cards.has(l.organization_id)).map((l) => ({ type: 'organization_location', id: l.id })),
        ],
        'wrong_location_or_closed',
      ),
    ]);
    const wrongByOrg = new Map<string, number>();
    for (const id of known) wrongByOrg.set(id, reports.get(`organization:${id}`) ?? 0);
    for (const l of locations)
      if (wrongByOrg.has(l.organization_id))
        wrongByOrg.set(l.organization_id, wrongByOrg.get(l.organization_id)! + (reports.get(`organization_location:${l.id}`) ?? 0));
    const names = await this.names.names(scope, [...page.map((r) => r.assigned_to), ...owners.values()], locale);
    const items = [];
    for (const r of page) {
      const card = cards.get(r.organization_id);
      if (!card) continue;
      const loc = primary.get(r.organization_id);
      const wrong = wrongByOrg.get(r.organization_id) ?? 0;
      const owner = owners.get(r.organization_id) ?? null;
      items.push({
        ...toVerification(r, requests.get(r.id) ?? null),
        organization: toOrgSummary(card),
        location_check:
          (r.verification_type === 'location' || r.verification_type === 'address') && loc
            ? {
                geocoded_point: null,
                distance_m: loc.geo_address_distance_m,
                location_check_status: loc.location_check_status,
                threshold_m: this.checker.thresholdM,
              }
            : null,
        wrong_location_reports: Math.min(10_000, wrong),
        assignee: r.assigned_to ? { user_id: r.assigned_to, display_name: names.get(r.assigned_to)! } : null,
        assigned_at: isoOrNull(r.assigned_at),
        sla_started_at: iso(r.sla_started_at),
        sla_paused_since: isoOrNull(r.sla_paused_at),
        ai_precheck: precheck(r.ai_precheck),
        owner: owner ? { user_id: owner, display_name: names.get(owner)! } : null,
        callback_result: callback.get(r.organization_id) ?? 'not_requested',
        possible_duplicate: duplicates.has(r.organization_id),
      });
    }
    return items;
  }
}

/** 40 VerificationPrecheck from the stored pre-check (none in the MVP: no AI pre-check runs yet). */
function precheck(v: unknown) {
  if (!v || typeof v !== 'object') return null;
  const p = v as Record<string, unknown>;
  const bool = (x: unknown) => (typeof x === 'boolean' ? x : null);
  const risk = ['low', 'medium', 'high'].includes(String(p.duplicate_risk)) ? (p.duplicate_risk as 'low' | 'medium' | 'high') : null;
  const at = typeof p.checked_at === 'string' ? new Date(p.checked_at) : null;
  if (!at || Number.isNaN(at.getTime())) return null;
  return { documents_readable: bool(p.documents_readable), name_match: bool(p.name_match), duplicate_risk: risk, checked_at: iso(at) };
}

type QueueQuery = {
  status?: string;
  verification_type?: string;
  assignee?: 'me' | 'unassigned';
  info_requested?: boolean;
  organization_id?: string;
  verification_id?: string;
  limit: number;
};

@Injectable()
@Operation('admin.verifications_queue')
export class AdminVerificationsQueueHandler implements OperationHandler {
  constructor(private readonly views: StaffVerificationItems) {}

  async handle(ctx: OperationContext<undefined, QueueQuery>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const q = ctx.query;
    const after = afterId(ctx);
    const body = await ctx.tx(
      async (scope) => {
        let v = scope.db.selectFrom('organization.organization_verifications').selectAll().where('deleted_at', 'is', null);
        // A link to one check (verification_id) finds it in any state; without one the queue lists pending checks.
        const status = q.status ?? (q.verification_id ? undefined : 'pending');
        if (status) v = v.where('status', '=', status);
        if (q.verification_id) v = v.where('id', '=', q.verification_id);
        if (q.organization_id) v = v.where('organization_id', '=', q.organization_id);
        if (q.verification_type) v = v.where('verification_type', '=', q.verification_type);
        if (q.assignee === 'me') v = v.where('assigned_to', '=', s.userId);
        if (q.assignee === 'unassigned') v = v.where('assigned_to', 'is', null);
        if (q.info_requested !== undefined) v = v.where('sla_paused_at', q.info_requested ? 'is not' : 'is', null);
        if (after) v = v.where('id', '>', after);
        const rows = await v
          .orderBy('id')
          .limit(q.limit + 1)
          .execute();
        const page = rows.slice(0, q.limit);
        return ctx.page(await this.views.items(scope, page, ctx.locale), rows.length > q.limit ? { id: page.at(-1)!.id } : null);
      },
      { readOnly: true },
    );
    return { body };
  }
}

/** A pending check, locked (verification_decide, verification_assign). */
async function loadPendingCheck(scope: TxScope, id: string): Promise<VerificationRow> {
  const v = await scope.db
    .selectFrom('organization.organization_verifications')
    .selectAll()
    .where('id', '=', id)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  if (!v) throw new ApiError('NOT_FOUND');
  return v;
}

@Injectable()
@Operation('admin.verification_assign')
export class AdminVerificationAssignHandler implements OperationHandler {
  constructor(
    private readonly views: StaffVerificationItems,
    private readonly directory: MembershipDirectory,
  ) {}

  async handle(ctx: OperationContext<{ assignee_user_id?: string; reason: string }>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const assignee = ctx.body.assignee_user_id ?? s.userId;
    // Only those who may decide a check (STF(ADM, MOD) of admin.verification_decide) can be given one.
    if (assignee !== s.userId) {
      const roles = await this.directory.platformRoles(assignee);
      if (!roles.some((r) => r === 'platform_moderator' || r === 'platform_admin'))
        throw ApiError.validation([{ pointer: '/assignee_user_id', code: 'reference_not_found' }], 'REFERENCE_NOT_FOUND');
    }
    const body = await ctx.tx(async (scope) => {
      const v = await loadPendingCheck(scope, ctx.params.verification_id!);
      if (v.status !== 'pending') throw new ApiError('INVALID_TRANSITION', { detail: 'not_pending' });
      const row = await scope.db
        .updateTable('organization.organization_verifications')
        .set({ assigned_to: assignee, assigned_at: sql<Date>`now()` })
        .where('id', '=', v.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeAudit(scope, {
        action: 'organization.verification_assigned',
        entityType: 'organization_verification',
        entityId: v.id,
        reason: ctx.body.reason,
        previous: v.assigned_to ?? 'unassigned',
        next: assignee,
      });
      const [item] = await this.views.items(scope, [row], ctx.locale);
      if (!item) throw new ApiError('NOT_FOUND');
      return item;
    });
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

type InfoRequestWrite = { missing_items: string[]; template_key: string; message: string };
type VerificationDecision = {
  decision: 'verified' | 'rejected' | 'info_requested';
  rejection_reason?: string;
  info_request?: InfoRequestWrite;
  reason: string;
};

@Injectable()
@Operation('admin.verification_decide')
export class AdminVerificationDecideHandler implements OperationHandler {
  constructor(private readonly moderation: ModerationLog) {}

  /**
   * S19 (BR-35 part 2, R-25): asks the business for more information. The check stays pending, its review clock
   * pauses (sla_paused_at), it is assigned to the caller when unassigned, and the business is notified.
   */
  private async requestInfo(scope: TxScope, s: Staff, v: VerificationRow, w: InfoRequestWrite, reason: string) {
    const open = await scope.db
      .selectFrom('organization.verification_info_requests')
      .select('id')
      .where('verification_id', '=', v.id)
      .where('status', '=', 'open')
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (open) throw new ApiError('INVALID_TRANSITION', { detail: 'awaiting_business' });
    const request = await scope.db
      .insertInto('organization.verification_info_requests')
      .values({
        verification_id: v.id,
        organization_id: v.organization_id,
        requested_by: s.userId,
        missing_items: [...new Set(w.missing_items)],
        template_key: w.template_key,
        message: w.message,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const row = await scope.db
      .updateTable('organization.organization_verifications')
      .set({
        sla_paused_at: sql<Date>`now()`,
        assigned_to: v.assigned_to ?? s.userId,
        assigned_at: v.assigned_at ?? sql<Date>`now()`,
      })
      .where('id', '=', v.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.moderation.record(scope, {
      targetType: 'organization',
      targetId: v.organization_id,
      actionType: 'request_verification_info',
      reason,
      params: { verification_id: v.id, verification_type: v.verification_type, missing_items: request.missing_items },
      actorUserId: s.userId,
    });
    await writeAudit(scope, {
      action: 'organization.verification_info_requested',
      entityType: 'organization_verification',
      entityId: v.id,
      reason,
      previous: `${v.verification_type} pending`,
      next: `pending, info requested: ${textArray(request.missing_items).join(',')}`,
      accessPurpose: s.purpose,
    });
    await publishEvent(scope, {
      type: 'organization.verification.info_requested',
      aggregateType: 'organization_verification',
      aggregateId: v.id,
      payload: { organization_id: v.organization_id, verification_id: v.id, verification_type: v.verification_type },
    });
    return toVerification(row, request);
  }

  async handle(ctx: OperationContext<VerificationDecision>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const b = ctx.body;
    failIf([
      ...(b.decision === 'rejected' && !b.rejection_reason
        ? [{ pointer: '/rejection_reason', code: 'conditional_required' as const }]
        : []),
      ...(b.decision !== 'rejected' && b.rejection_reason
        ? [{ pointer: '/rejection_reason', code: 'conditional_forbidden' as const }]
        : []),
      ...(b.decision === 'info_requested' && !b.info_request ? [{ pointer: '/info_request', code: 'conditional_required' as const }] : []),
      ...(b.decision !== 'info_requested' && b.info_request ? [{ pointer: '/info_request', code: 'conditional_forbidden' as const }] : []),
    ]);
    const body = await ctx.tx(async (scope) => {
      const v = await loadPendingCheck(scope, ctx.params.verification_id!);
      if (v.status !== 'pending') throw new ApiError('INVALID_TRANSITION', { detail: v.status });
      if (b.decision === 'info_requested') return this.requestInfo(scope, s, v, b.info_request!, b.reason);
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
        .set({
          status: b.decision,
          reviewed_by: s.userId,
          reviewed_at: sql<Date>`now()`,
          rejection_reason: b.rejection_reason ?? null,
          sla_paused_at: null,
        })
        .where('id', '=', v.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      // S19: a decision closes a request for more information the business has not answered.
      await scope.db
        .updateTable('organization.verification_info_requests')
        .set({ status: 'closed', closed_at: sql<Date>`now()` })
        .where('verification_id', '=', v.id)
        .where('status', '=', 'open')
        .execute();
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
      // S25a.T3 (Docs/23 A-VER-02): the owners and managers learn of a rejection and what to fix (the reason written for
      // the business; OrganizationVerification.rejection_reason is theirs to read). Never the reviewer's name.
      if (b.decision === 'rejected')
        await publishEvent(scope, {
          type: 'organization.verification.rejected',
          aggregateType: 'organization_verification',
          aggregateId: v.id,
          payload: {
            organization_id: v.organization_id,
            verification_id: v.id,
            verification_type: v.verification_type,
            rejection_reason: b.rejection_reason!,
          },
        });
      return toVerification(row, (await latestInfoRequests(scope, [v.id])).get(v.id) ?? null);
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

type OrgCorrection = {
  name?: string;
  legal_name?: string | null;
  website?: string | null;
  description_translations?: Record<string, string> | null;
  reason: string;
};
const CORRECTABLE = ['name', 'legal_name', 'website', 'description_translations'] as const;

/** 40 OrgProfileChange of a stored history row (actor display resolved by the caller). */
function toProfileChange(
  r: { id: string; created_at: Date; actor_kind: string; actor_user_id: string; source: string; reason: string | null; changes: unknown },
  names: Map<string, string>,
) {
  const changes = (Array.isArray(r.changes) ? r.changes : []) as StoredFieldChange[];
  const text = (v: unknown) => (v === null || v === undefined ? null : String(v));
  const translations = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, string>) : null);
  return {
    id: r.id,
    changed_at: iso(r.created_at),
    actor: r.actor_kind as 'member' | 'staff',
    actor_display: names.get(r.actor_user_id)!,
    source: r.source as 'org.update' | 'admin.org_correct',
    reason: r.reason,
    changes: changes.map((c) =>
      c.field === 'description_translations'
        ? {
            field: c.field,
            previous: null,
            next: null,
            previous_translations: translations(c.previous),
            next_translations: translations(c.next),
          }
        : { field: c.field, previous: text(c.previous), next: text(c.next), previous_translations: null, next_translations: null },
    ),
  };
}

/**
 * 40 admin.org_correct (backend S19, BR-35 part 3, DI-32): staff correct obvious errors in the public profile with a
 * reason. Contact data and the slug stay the organization's own. The change enters the profile history, the search
 * index is refreshed and the organization's owners and managers are notified.
 */
@Injectable()
@Operation('admin.org_correct')
export class AdminOrgCorrectHandler implements OperationHandler {
  constructor(
    private readonly moderation: ModerationLog,
    private readonly names: StaffNames,
  ) {}

  async handle(ctx: OperationContext<OrgCorrection>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const b = ctx.body;
    if (!CORRECTABLE.some((f) => b[f] !== undefined)) failIf([{ pointer: '/name', code: 'conditional_required' }]);
    const body = await ctx.tx(async (scope) => {
      const o = await loadOrgRow(scope, ctx.params.org_id!, true);
      if (['merged', 'archived'].includes(o.status)) throw new ApiError('INVALID_TRANSITION', { detail: o.status });
      const patch = {
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.legal_name !== undefined ? { legal_name: b.legal_name } : {}),
        ...(b.website !== undefined ? { website: b.website } : {}),
        ...(b.description_translations !== undefined ? { description_translations: json(b.description_translations) } : {}),
      };
      const row = await scope.db
        .updateTable('organization.organizations')
        .set(patch)
        .where('id', '=', o.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      const after = Object.fromEntries(Object.keys(patch).map((k) => [k, row[k as keyof OrgRow]]));
      const changes = profileDiff(o, after);
      if (changes.length === 0) throw new ApiError('INVALID_TRANSITION', { detail: 'no_change' });
      await recordProfileChange(scope, { orgId: o.id, actor: 'staff', userId: s.userId, changes, reason: b.reason });
      await this.moderation.record(scope, {
        targetType: 'organization',
        targetId: o.id,
        actionType: 'correct_profile',
        reason: b.reason,
        params: { fields: changes.map((c) => c.field) },
        actorUserId: s.userId,
      });
      await writeAudit(scope, {
        action: 'organization.profile_corrected',
        entityType: 'organization',
        entityId: o.id,
        reason: b.reason,
        previous: JSON.stringify(Object.fromEntries(changes.map((c) => [c.field, c.previous]))).slice(0, 2000),
        next: JSON.stringify(Object.fromEntries(changes.map((c) => [c.field, c.next]))).slice(0, 2000),
      });
      await profileUpdated(scope, o.id, 'organization');
      await publishEvent(scope, {
        type: 'organization.profile.corrected',
        aggregateType: 'organization',
        aggregateId: o.id,
        payload: { organization_id: o.id, fields: changes.map((c) => c.field) },
      });
      const stored = await scope.db
        .selectFrom('organization.organization_profile_changes')
        .selectAll()
        .where('organization_id', '=', o.id)
        .orderBy('id', 'desc')
        .limit(1)
        .executeTakeFirstOrThrow();
      return toProfileChange(stored, await this.names.names(scope, [s.userId], ctx.locale));
    });
    return { body };
  }
}

/** 40 admin.org_history (backend S19, BR-35 part 3): the profile's edit history, newest first, under a purpose. */
@Injectable()
@Operation('admin.org_history')
export class AdminOrgHistoryHandler implements OperationHandler {
  constructor(private readonly names: StaffNames) {}

  async handle(ctx: OperationContext<undefined, { limit: number }>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const after = afterId(ctx);
    const body = await ctx.tx(async (scope) => {
      const o = await loadOrgRow(scope, ctx.params.org_id!);
      // Member edits name contact data before and after: a staff read of personal data (SEC-LOG-4).
      await auditStaffRead(scope, s, 'organization', o.id, 'organization profile history');
      let q = scope.db.selectFrom('organization.organization_profile_changes').selectAll().where('organization_id', '=', o.id);
      if (after) q = q.where('id', '<', after);
      const rows = await q
        .orderBy('id', 'desc')
        .limit(ctx.query.limit + 1)
        .execute();
      const page = rows.slice(0, ctx.query.limit);
      const names = await this.names.names(
        scope,
        page.map((r) => r.actor_user_id),
        ctx.locale,
      );
      return ctx.page(
        page.map((r) => toProfileChange(r, names)),
        rows.length > ctx.query.limit ? { id: page.at(-1)!.id } : null,
      );
    });
    return { body };
  }
}
