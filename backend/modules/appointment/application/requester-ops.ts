// Requester operations (40 §16.2) under {me}/appointments (individuals) and
// {flt}/appointments (fleets, FC writes and F* reads). A request carries the
// user's own description when there is no Help Me triage (triage_status
// not_provided); the server runs the safety check on it (SEC-BF-8) and
// enforces the open-request caps and the no-show cooldown (SEC-BF-3).
// Transitions follow the 40 §16.1 requester column (checked here and by the
// appointments_status trigger). Sending the request approves the previewed
// pre-visit report (40 Appendix D).
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { ApiError, type FieldError } from '#libs/contract/index.js';
import { uuidv7 } from '#libs/crypto/index.js';
import { created, Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import type { Locale } from '#libs/i18n/index.js';
import { LinkTokens } from '#libs/link-tokens/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import { SafetyCheck } from '#libs/safety-check/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { MatchResults } from '#modules/discovery/interface/match-results.js';
import { AccountFacts, ConsentGrants, UserCards } from '#modules/identity/interface/identity.js';
import { MediaService } from '#modules/media/interface/media.js';
import { Messenger } from '#modules/notification/interface/messenger.js';
import { ProviderBooking } from '#modules/organization/interface/booking.js';
import { VehicleCards, VehicleService } from '#modules/vehicle/interface/vehicles.js';
import { toHistory, toNote, type AppointmentRow } from '../api/projections.js';
import {
  CHECK_IN_LINK_GRACE_MS,
  MAX_OPEN_PER_PROVIDER,
  MAX_OPEN_TOTAL,
  NO_SHOW_COOLDOWN_MS,
  OPEN_REQUEST_STATUSES,
  REQUESTER_EDITABLE,
  REQUESTER_GROUPS,
  transitionAllowed,
  windowErrors,
  withinCheckInWindow,
  type TimeWindowInput,
} from '../domain/rules.js';
import { Capacity } from './capacity.js';
import {
  afterId,
  AppointmentViews,
  basePath,
  failIf,
  loadAsRequester,
  notFoundAt,
  pageOf,
  requester,
  setSide,
  type Requester,
} from './common.js';
import { PreVisitReports } from './pre-visit.js';

type AppointmentCreate = {
  provider_organization_id: string;
  provider_location_id?: string;
  vehicle_id: string;
  source: string;
  match_result_id?: string;
  related_issue_id?: string;
  triage_session_id?: string;
  fleet_approval_id?: string;
  appointment_type: string;
  service_mode: string;
  service_system_node_id?: string;
  service_task_node_id?: string;
  symptom_node_id?: string;
  description: string;
  content_locale: string;
  urgency_level: string;
  customer_expectations?: string;
  preferred_contact_channel?: string;
  time_windows: TimeWindowInput[];
  share_history?: { policy_version: string };
  media_ids?: string[];
  submit: boolean;
};

const PHOTO_PURPOSES = ['appointment_photo', 'issue_photo', 'vehicle_photo'] as const;

/** 52 Appointment.description: 10–3000 characters (40 Text<3000> carries no minimum). */
function descriptionErrors(text: string | undefined, pointer = '/description'): FieldError[] {
  return text !== undefined && [...text.trim()].length < 10 ? [{ pointer, code: 'too_short', limit: '10' }] : [];
}

async function replaceWindows(scope: TxScope, appointmentId: string, windows: readonly TimeWindowInput[]): Promise<void> {
  await scope.db
    .updateTable('appointment.appointment_time_windows')
    .set({ deleted_at: sql`now()`, deletion_reason: 'replaced' })
    .where('appointment_id', '=', appointmentId)
    .where('deleted_at', 'is', null)
    .execute();
  if (windows.length)
    await scope.db
      .insertInto('appointment.appointment_time_windows')
      .values(
        windows.map((w) => ({
          appointment_id: appointmentId,
          start_at: new Date(w.start_at),
          end_at: new Date(w.end_at),
          priority: w.priority,
        })),
      )
      .execute();
}

async function windowCount(scope: TxScope, appointmentId: string): Promise<number> {
  const r = await scope.db
    .selectFrom('appointment.appointment_time_windows')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('appointment_id', '=', appointmentId)
    .where('deleted_at', 'is', null)
    .executeTakeFirstOrThrow();
  return Number(r.n);
}

/** SEC-BF-3: open-request caps per provider and in total, and a cooldown after a no-show at this provider. */
async function checkRequestCaps(scope: TxScope, r: Requester, providerOrgId: string, excludeId: string | null): Promise<void> {
  const mine = scope.db
    .selectFrom('appointment.appointments')
    .where('deleted_at', 'is', null)
    .where((eb) =>
      r.orgId
        ? eb('requester_organization_id', '=', r.orgId)
        : eb.and([eb('requester_type', '=', 'user'), eb('requester_user_id', '=', r.userId)]),
    )
    .where('id', '<>', excludeId ?? '00000000-0000-0000-0000-000000000000');
  const open = await mine
    .select([
      (eb) => eb.fn.countAll<string>().as('total'),
      sql<string>`count(*) FILTER (WHERE provider_organization_id = ${providerOrgId}::uuid)`.as('here'),
    ])
    .where('status', 'in', [...OPEN_REQUEST_STATUSES])
    .executeTakeFirstOrThrow();
  const noShow = await mine
    .select('id')
    .where('provider_organization_id', '=', providerOrgId)
    .where('status', '=', 'no_show')
    .where('updated_at', '>', new Date(Date.now() - NO_SHOW_COOLDOWN_MS))
    .executeTakeFirst();
  if (Number(open.here) >= MAX_OPEN_PER_PROVIDER || Number(open.total) >= MAX_OPEN_TOTAL || noShow)
    throw new ApiError('RATE_LIMITED', { detail: noShow ? 'no-show cooldown' : 'open request limit', headers: { 'retry-after': '3600' } });
}

/** appointment.requested (draft → requested or created submitted): ids and plain facts only. */
async function requested(scope: TxScope, a: AppointmentRow): Promise<void> {
  await publishEvent(scope, {
    type: 'appointment.requested',
    aggregateType: 'appointment',
    aggregateId: a.id,
    payload: {
      provider_organization_id: a.provider_organization_id,
      requester_type: a.requester_type,
      requester_user_id: a.requester_user_id,
      requester_organization_id: a.requester_organization_id,
      source: a.source,
      urgency_level: a.urgency_level,
      safety_flag: a.safety_flag,
    },
  });
}

/** appointment.status_changed after any status change (the trigger already wrote the history row). */
export async function statusChanged(scope: TxScope, before: AppointmentRow, after: AppointmentRow, side: string): Promise<void> {
  if (before.status === after.status) return;
  await publishEvent(scope, {
    type: 'appointment.status_changed',
    aggregateType: 'appointment',
    aggregateId: after.id,
    payload: {
      old_status: before.status,
      new_status: after.status,
      changed_by_side: side,
      provider_organization_id: after.provider_organization_id,
      requester_user_id: after.requester_user_id,
      requester_organization_id: after.requester_organization_id,
    },
  });
}

/**
 * Confirmation shared by both sides: capacity in the same transaction, the
 * confirmed window, the ci check-in link (SEC-LT-3: until confirmed_end_at
 * + 12 h, only its HMAC stored) mailed to the requester after commit, and
 * appointment.confirmed.
 */
@Injectable()
export class Confirmation {
  constructor(
    private readonly capacity: Capacity,
    private readonly links: LinkTokens,
    private readonly messenger: Messenger,
  ) {}

  async confirm(
    scope: TxScope,
    a: AppointmentRow,
    w: { start: Date; end: Date | null; duration: number | null },
    side: 'requester' | 'provider',
  ): Promise<AppointmentRow> {
    const end = w.end ?? new Date(w.start.getTime() + (w.duration ?? a.estimated_duration_minutes ?? 60) * 60_000);
    const locationId = await this.capacity.require(scope, a, w.start, end);
    const link = this.links.issue('ci', Date.now(), new Date(end.getTime() + CHECK_IN_LINK_GRACE_MS));
    const row = await scope.db
      .updateTable('appointment.appointments')
      .set({
        status: 'confirmed',
        confirmed_start_at: w.start,
        confirmed_end_at: end,
        ...(w.duration ? { estimated_duration_minutes: w.duration } : {}),
        provider_location_id: locationId ?? a.provider_location_id,
        proposed_start_at: null,
        proposed_end_at: null,
        check_in_token_hash: link.hash,
        check_in_token_expires_at: link.expiresAt,
      })
      .where('id', '=', a.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    const { rows } = await sql<{ email: string; locale: string }>`
      SELECT email, locale FROM appointment.check_in_contact(${row.id}::uuid)`.execute(scope.db);
    const to = rows[0];
    if (to)
      scope.afterCommit(() =>
        this.messenger.email(to.email, 'appointment.check_in_link', to.locale, {
          link: this.links.link('ci', link.token),
          start_at: row.confirmed_start_at ? new Date(row.confirmed_start_at).toISOString() : '',
        }),
      );
    await statusChanged(scope, a, row, side);
    await publishEvent(scope, {
      type: 'appointment.confirmed',
      aggregateType: 'appointment',
      aggregateId: row.id,
      payload: {
        provider_organization_id: row.provider_organization_id,
        provider_location_id: row.provider_location_id,
        requester_user_id: row.requester_user_id,
        requester_organization_id: row.requester_organization_id,
        confirmed_start_at: new Date(row.confirmed_start_at!).toISOString(),
        confirmed_by_side: side,
      },
    });
    return row;
  }
}

@Injectable()
@Operation('appointments.create')
export class AppointmentsCreateHandler implements OperationHandler {
  constructor(
    private readonly facts: AccountFacts,
    private readonly booking: ProviderBooking,
    private readonly vehicles: VehicleCards,
    private readonly grants: ConsentGrants,
    private readonly media: MediaService,
    private readonly safety: SafetyCheck,
    private readonly matches: MatchResults,
    private readonly reports: PreVisitReports,
    private readonly views: AppointmentViews,
    private readonly issues: VehicleService,
  ) {}

  /** The request is sent: the issue it came from is scheduled (requester context: the provider cannot see issues). */
  private async submitted(scope: TxScope, a: AppointmentRow): Promise<void> {
    if (a.related_issue_id) await this.issues.markIssueScheduled(scope, a.related_issue_id, a.id);
    await requested(scope, a);
  }

  async handle(ctx: OperationContext<AppointmentCreate>): Promise<OperationResult> {
    const r = requester(ctx);
    const b = ctx.body;
    const errors: FieldError[] = [...descriptionErrors(b.description), ...windowErrors(b.time_windows, Date.now())];
    if (b.submit && b.time_windows.length === 0) errors.push({ pointer: '/time_windows', code: 'conditional_required' });
    if ((b.source === 'ai_match' || b.source === 'fleet_workflow') && !b.service_system_node_id)
      errors.push({ pointer: '/service_system_node_id', code: 'conditional_required' });
    if (b.source === 'fleet_workflow' && !r.orgId) errors.push({ pointer: '/source', code: 'enum' });
    failIf(errors);
    // Help Me triage sessions (S9) and fleet approvals (S8) do not exist yet: such references cannot resolve.
    if (b.triage_session_id) throw notFoundAt('/triage_session_id');
    if (b.fleet_approval_id) throw notFoundAt('/fleet_approval_id');
    const body = await ctx.tx(async (scope) => {
      if (!(await this.facts.hasVerifiedContact(scope, r.userId))) throw new ApiError('VERIFIED_CONTACT_REQUIRED');
      const provider = await this.booking.provider(scope, b.provider_organization_id);
      if (!provider) throw notFoundAt('/provider_organization_id');
      if (!provider.serviceModes.includes(b.service_mode)) failIf([{ pointer: '/service_mode', code: 'enum' }]);
      if (b.provider_location_id && !provider.locationIds.includes(b.provider_location_id)) throw notFoundAt('/provider_location_id');
      const vehicle = await this.vehicles.visible(scope, b.vehicle_id);
      if (!vehicle || !['active', 'in_repair'].includes(vehicle.status)) throw notFoundAt('/vehicle_id');
      if (b.related_issue_id) {
        const issue = await this.vehicles.issue(scope, b.related_issue_id);
        if (!issue || issue.vehicleId !== b.vehicle_id || !['open', 'investigating'].includes(issue.status))
          throw notFoundAt('/related_issue_id');
      }
      if (b.submit) await checkRequestCaps(scope, r, provider.orgId, null);
      const id = uuidv7();
      let consentId: string | null = null;
      // share_history: two consents scoped to this appointment and granted to the provider, atomically (40 AppointmentCreate).
      // Fleet vehicles have no personal consent subject (DI-38): fleets do not share history through appointments yet.
      if (b.share_history && !r.orgId) {
        for (const consentType of ['vehicle_data_sharing', 'service_history_sharing'] as const)
          consentId = await this.grants.grantScoped(scope, {
            subjectUserId: r.userId,
            consentType,
            scope: { type: 'appointment', id },
            grantee: { type: 'organization', id: provider.orgId },
            policyVersion: b.share_history.policy_version,
          });
      }
      const safety = await this.safety.check(b.description);
      const row = await scope.db
        .insertInto('appointment.appointments')
        .values({
          id,
          requester_type: r.orgId ? 'fleet' : 'user',
          requester_user_id: r.userId,
          requester_organization_id: r.orgId,
          provider_organization_id: provider.orgId,
          provider_location_id: b.provider_location_id ?? provider.locationIds[0] ?? null,
          vehicle_id: b.vehicle_id,
          source: b.source,
          match_result_id: null,
          related_issue_id: b.related_issue_id ?? null,
          appointment_type: b.appointment_type,
          service_mode: b.service_mode,
          service_system_node_id: b.service_system_node_id ?? null,
          service_task_node_id: b.service_task_node_id ?? null,
          symptom_node_id: b.symptom_node_id ?? null,
          safety_flag: safety.safety_flag,
          description: b.description,
          content_locale: b.content_locale,
          urgency_level: b.urgency_level,
          customer_expectations: b.customer_expectations ?? null,
          preferred_contact_channel: b.preferred_contact_channel ?? null,
          consent_to_share_history: consentId !== null,
          consent_reference_id: consentId,
          status: b.submit ? 'requested' : 'draft',
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await replaceWindows(scope, id, b.time_windows);
      await scope.db
        .insertInto('appointment.appointment_participants')
        .values({ appointment_id: id, user_id: r.userId, organization_id: r.orgId, participant_role: participantRole(ctx) })
        .execute();
      if (b.media_ids?.length)
        await this.media.syncAttachments(scope, b.media_ids, {
          type: 'appointment',
          id,
          role: 'gallery',
          owner: r.orgId ? { type: 'organization', id: r.orgId } : { type: 'user', id: r.userId },
          purposes: PHOTO_PURPOSES,
          pointer: '/media_ids',
        });
      let current = row;
      if (b.match_result_id) {
        // Only a result of the caller's own session that ranked this provider (RLS via_session).
        if (!(await this.matches.linkAppointment(scope, b.match_result_id, provider.orgId, id))) throw notFoundAt('/match_result_id');
        current = await scope.db
          .updateTable('appointment.appointments')
          .set({ match_result_id: b.match_result_id })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();
      }
      await this.reports.generate(scope, current, ctx.locale);
      if (b.submit) await this.submitted(scope, current);
      return this.views.one(scope, current, 'requester', ctx.locale);
    });
    return created(body, `${basePath(r)}/${body.id}`);
  }
}

/** 52 AppointmentParticipant.participant_role of the requester side. */
function participantRole(ctx: OperationContext): 'requester' | 'fleet_manager' | 'fleet_maintenance_coordinator' {
  const role = ctx.access.org?.role;
  if (role === 'fleet_maintenance_coordinator') return 'fleet_maintenance_coordinator';
  if (role === 'fleet_owner' || role === 'fleet_manager') return 'fleet_manager';
  return 'requester';
}

@Injectable()
@Operation('appointments.list')
export class AppointmentsListHandler implements OperationHandler {
  constructor(private readonly views: AppointmentViews) {}

  async handle(ctx: OperationContext<undefined, { group?: keyof typeof REQUESTER_GROUPS; vehicle_id?: string; limit: number }>) {
    const r = requester(ctx);
    const after = afterId(ctx);
    const body = await ctx.tx(
      async (scope) => {
        let q = scope.db.selectFrom('appointment.appointments').selectAll().where('deleted_at', 'is', null);
        q = r.orgId
          ? q.where('requester_organization_id', '=', r.orgId)
          : q.where('requester_type', '=', 'user').where('requester_user_id', '=', r.userId);
        if (r.driver) q = q.where('requester_user_id', '=', r.userId);
        if (ctx.query.group) q = q.where('status', 'in', [...REQUESTER_GROUPS[ctx.query.group]]);
        if (ctx.query.vehicle_id) q = q.where('vehicle_id', '=', ctx.query.vehicle_id);
        if (after) q = q.where('id', '<', after);
        const rows = await q
          .orderBy('id', 'desc')
          .limit(ctx.query.limit + 1)
          .execute();
        return pageOf(ctx, rows, await this.views.many(scope, rows.slice(0, ctx.query.limit), 'requester', ctx.locale));
      },
      { readOnly: true },
    );
    return { body } satisfies OperationResult;
  }
}

@Injectable()
@Operation('appointments.get')
export class AppointmentsGetHandler implements OperationHandler {
  constructor(private readonly views: AppointmentViews) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const r = requester(ctx);
    const body = await ctx.tx(
      async (scope) => this.views.one(scope, await loadAsRequester(scope, r, ctx.params.appointment_id!), 'requester', ctx.locale),
      { readOnly: true },
    );
    return { body };
  }
}

type AppointmentUpdate = {
  description?: string;
  customer_expectations?: string | null;
  time_windows?: TimeWindowInput[];
  urgency_level?: string;
  preferred_contact_channel?: string;
  service_system_node_id?: string | null;
  media_ids?: string[];
};

@Injectable()
@Operation('appointments.update')
export class AppointmentsUpdateHandler implements OperationHandler {
  constructor(
    private readonly media: MediaService,
    private readonly safety: SafetyCheck,
    private readonly reports: PreVisitReports,
    private readonly views: AppointmentViews,
  ) {}

  async handle(ctx: OperationContext<AppointmentUpdate>): Promise<OperationResult> {
    const r = requester(ctx);
    const b = ctx.body;
    const errors = [...descriptionErrors(b.description), ...(b.time_windows ? windowErrors(b.time_windows, Date.now()) : [])];
    failIf(errors);
    const body = await ctx.tx(async (scope) => {
      const a = await loadAsRequester(scope, r, ctx.params.appointment_id!, true);
      if (ctx.ifMatch !== a.version) throw new ApiError('VERSION_MISMATCH');
      if (!(REQUESTER_EDITABLE as readonly string[]).includes(a.status))
        throw new ApiError('INVALID_TRANSITION', { detail: 'not_editable' });
      if (a.status === 'requested' && b.time_windows && b.time_windows.length === 0)
        failIf([{ pointer: '/time_windows', code: 'conditional_required' }]);
      if (b.service_system_node_id === null && (a.source === 'ai_match' || a.source === 'fleet_workflow'))
        failIf([{ pointer: '/service_system_node_id', code: 'conditional_required' }]);
      const set: Record<string, unknown> = {};
      if (b.description !== undefined) {
        set.description = b.description;
        set.safety_flag = (await this.safety.check(b.description)).safety_flag;
      }
      if (b.customer_expectations !== undefined) set.customer_expectations = b.customer_expectations;
      if (b.urgency_level !== undefined) set.urgency_level = b.urgency_level;
      if (b.preferred_contact_channel !== undefined) set.preferred_contact_channel = b.preferred_contact_channel;
      if (b.service_system_node_id !== undefined) set.service_system_node_id = b.service_system_node_id;
      if (b.time_windows) await replaceWindows(scope, a.id, b.time_windows);
      if (b.media_ids)
        await this.media.syncAttachments(scope, b.media_ids, {
          type: 'appointment',
          id: a.id,
          role: 'gallery',
          owner: r.orgId ? { type: 'organization', id: r.orgId } : { type: 'user', id: r.userId },
          purposes: PHOTO_PURPOSES,
          pointer: '/media_ids',
        });
      // Every accepted edit moves the version (one write, one ETag), also when only windows or media changed.
      const row = await scope.db
        .updateTable('appointment.appointments')
        .set({ ...set, updated_at: sql`now()` })
        .where('id', '=', a.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.reports.generate(scope, row, ctx.locale);
      return this.views.one(scope, row, 'requester', ctx.locale);
    });
    return { body };
  }
}

type Transition =
  | { to: 'requested'; time_windows?: TimeWindowInput[] }
  | { to: 'confirmed'; confirmed_start_at?: string; confirmed_end_at?: string; estimated_duration_minutes?: number }
  | { to: 'cancelled'; cancellation_reason: string }
  | { to: string };

@Injectable()
@Operation('appointments.transition')
export class AppointmentsTransitionHandler implements OperationHandler {
  constructor(
    private readonly confirmation: Confirmation,
    private readonly reports: PreVisitReports,
    private readonly views: AppointmentViews,
    private readonly issues: VehicleService,
  ) {}

  async handle(ctx: OperationContext<Transition>): Promise<OperationResult> {
    const r = requester(ctx);
    const b = ctx.body;
    if (!['requested', 'confirmed', 'cancelled'].includes(b.to))
      throw new ApiError('INVALID_TRANSITION', { detail: `requester cannot set ${b.to}` });
    if (b.to === 'confirmed') {
      const c = b as { confirmed_start_at?: string; confirmed_end_at?: string; estimated_duration_minutes?: number };
      // Accepting an alternative: the provider's proposal is the confirmed time (40 §16.1 "requester accepting: omitted").
      failIf(
        (['confirmed_start_at', 'confirmed_end_at', 'estimated_duration_minutes'] as const)
          .filter((k) => c[k] !== undefined)
          .map((k) => ({ pointer: `/${k}`, code: 'conditional_forbidden' as const })),
      );
    }
    const windows = b.to === 'requested' ? (b as { time_windows?: TimeWindowInput[] }).time_windows : undefined;
    if (windows) failIf(windowErrors(windows, Date.now()));
    const body = await ctx.tx(async (scope) => {
      const a = await loadAsRequester(scope, r, ctx.params.appointment_id!, true);
      if (!transitionAllowed('requester', a.status, b.to)) throw new ApiError('INVALID_TRANSITION', { detail: `${a.status} -> ${b.to}` });
      let row: AppointmentRow;
      if (b.to === 'confirmed') {
        if (!a.proposed_start_at) throw new ApiError('INVALID_TRANSITION', { detail: 'no proposal' });
        await setSide(scope, 'requester', 'alternative accepted');
        row = await this.confirmation.confirm(
          scope,
          a,
          { start: new Date(a.proposed_start_at), end: a.proposed_end_at ? new Date(a.proposed_end_at) : null, duration: null },
          'requester',
        );
      } else if (b.to === 'requested') {
        if (windows) await replaceWindows(scope, a.id, windows);
        if ((await windowCount(scope, a.id)) === 0) failIf([{ pointer: '/time_windows', code: 'conditional_required' }]);
        await checkRequestCaps(scope, r, a.provider_organization_id, a.id);
        await setSide(scope, 'requester', a.status === 'alternative_proposed' ? 'counter proposal' : null);
        row = await scope.db
          .updateTable('appointment.appointments')
          .set({ status: 'requested', proposed_start_at: null, proposed_end_at: null })
          .where('id', '=', a.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await this.reports.generate(scope, row, ctx.locale);
        await statusChanged(scope, a, row, 'requester');
        if (a.status === 'draft') {
          if (row.related_issue_id) await this.issues.markIssueScheduled(scope, row.related_issue_id, row.id);
          await requested(scope, row);
        }
      } else {
        const reason = (b as { cancellation_reason: string }).cancellation_reason;
        await setSide(scope, 'requester', reason);
        row = await scope.db
          .updateTable('appointment.appointments')
          .set({ status: 'cancelled', cancelled_by: 'requester', cancellation_reason: reason, check_in_token_hash: null })
          .where('id', '=', a.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await statusChanged(scope, a, row, 'requester');
      }
      return this.views.one(scope, row, 'requester', ctx.locale);
    });
    return { body };
  }
}

@Injectable()
@Operation('appointments.delay')
export class AppointmentsDelayHandler implements OperationHandler {
  constructor(private readonly views: AppointmentViews) {}

  async handle(ctx: OperationContext<{ customer_delay_minutes: number }>): Promise<OperationResult> {
    const r = requester(ctx);
    const body = await ctx.tx(async (scope) => {
      const a = await loadAsRequester(scope, r, ctx.params.appointment_id!, true);
      if (a.status !== 'confirmed') throw new ApiError('INVALID_TRANSITION', { detail: 'not_confirmed' });
      const row = await scope.db
        .updateTable('appointment.appointments')
        .set({ customer_delay_minutes: ctx.body.customer_delay_minutes })
        .where('id', '=', a.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await publishEvent(scope, {
        type: 'appointment.delay_reported',
        aggregateType: 'appointment',
        aggregateId: a.id,
        payload: { provider_organization_id: a.provider_organization_id, customer_delay_minutes: ctx.body.customer_delay_minutes },
      });
      return this.views.one(scope, row, 'requester', ctx.locale);
    });
    return { body };
  }
}

@Injectable()
@Operation('appointments.check_in')
export class AppointmentsCheckInHandler implements OperationHandler {
  constructor(private readonly views: AppointmentViews) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const r = requester(ctx);
    const body = await ctx.tx(async (scope) => {
      const a = await loadAsRequester(scope, r, ctx.params.appointment_id!, true);
      if (a.status === 'checked_in') return this.views.one(scope, a, 'requester', ctx.locale);
      if (a.status !== 'confirmed' || !withinCheckInWindow(a.confirmed_start_at, Date.now()))
        throw new ApiError('INVALID_TRANSITION', { detail: 'outside_window' });
      await setSide(scope, 'requester', 'checked in by the requester');
      const row = await scope.db
        .updateTable('appointment.appointments')
        .set({ status: 'checked_in', checked_in_at: sql`now()` })
        .where('id', '=', a.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await statusChanged(scope, a, row, 'requester');
      return this.views.one(scope, row, 'requester', ctx.locale);
    });
    return { body };
  }
}

@Injectable()
@Operation('appointments.check_in_link')
export class AppointmentsCheckInLinkHandler implements OperationHandler {
  constructor(private readonly links: LinkTokens) {}

  async handle(ctx: OperationContext<{ token: string }>): Promise<OperationResult> {
    const { hash } = this.links.parse(ctx.body.token, 'ci');
    // appointment.check_in_by_token: atomic, ±2 h window, LINK_EXPIRED for unknown or expired links (no oracle).
    const body = await ctx.tx(async (scope) => {
      const { rows } = await sql<{ appointment_id: string; status: string }>`
        SELECT appointment_id, status FROM appointment.check_in_by_token(${hash})`.execute(scope.db);
      const row = rows[0];
      if (!row) throw new ApiError('LINK_EXPIRED');
      return { appointment_id: row.appointment_id, status: row.status };
    });
    return { body };
  }
}

@Injectable()
@Operation('appointments.history')
export class AppointmentsHistoryHandler implements OperationHandler {
  async handle(ctx: OperationContext<undefined, { limit: number }>): Promise<OperationResult> {
    const r = requester(ctx);
    const after = afterId(ctx);
    const body = await ctx.tx(
      async (scope) => {
        const a = await loadAsRequester(scope, r, ctx.params.appointment_id!);
        let q = scope.db.selectFrom('appointment.appointment_status_history').selectAll().where('appointment_id', '=', a.id);
        if (after) q = q.where('id', '>', after);
        const rows = await q
          .orderBy('id')
          .limit(ctx.query.limit + 1)
          .execute();
        return pageOf(ctx, rows, rows.slice(0, ctx.query.limit).map(toHistory));
      },
      { readOnly: true },
    );
    return { body };
  }
}

/** Notes as one side sees them; the provider's members are shown by the organization's name to the requester. */
@Injectable()
export class NoteViews {
  constructor(
    private readonly users: UserCards,
    private readonly views: AppointmentViews,
  ) {}

  async many(
    scope: TxScope,
    a: AppointmentRow,
    rows: Awaited<ReturnType<typeof listNotes>>,
    viewer: 'requester' | 'provider',
    locale: Locale,
  ) {
    const users = await this.users.cards(
      scope,
      rows.map((n) => n.author_user_id),
    );
    const provider = (await this.views.providerCards(scope, [a.provider_organization_id], locale)).get(a.provider_organization_id);
    const requesterName = (await this.views.requesterNames(scope, [a], locale)).get(a.id) ?? 'CarPal user';
    const clip = (s: string) => ([...s].length >= 2 ? [...s].slice(0, 50).join('') : 'CarPal');
    return rows.map((n) => {
      const display =
        n.author_side === 'provider'
          ? viewer === 'requester'
            ? clip(provider?.name ?? 'CarPal')
            : clip(users.get(n.author_user_id)?.displayName ?? provider?.name ?? 'CarPal')
          : clip(viewer === 'provider' ? requesterName : (users.get(n.author_user_id)?.displayName ?? requesterName));
      return toNote(n, display);
    });
  }
}

export async function listNotes(
  scope: TxScope,
  appointmentId: string,
  customerVisibleOnly: boolean,
  after: string | undefined,
  limit: number,
) {
  let q = scope.db
    .selectFrom('appointment.appointment_notes')
    .selectAll()
    .where('appointment_id', '=', appointmentId)
    .where('deleted_at', 'is', null);
  // Internal notes never reach the requester (52 AppointmentNote; RLS requester_visible is the second wall).
  if (customerVisibleOnly) q = q.where('note_type', '=', 'customer_visible');
  if (after) q = q.where('id', '>', after);
  return q
    .orderBy('id')
    .limit(limit + 1)
    .execute();
}

@Injectable()
@Operation('appointments.notes_list')
export class AppointmentsNotesListHandler implements OperationHandler {
  constructor(private readonly notes: NoteViews) {}

  async handle(ctx: OperationContext<undefined, { limit: number }>): Promise<OperationResult> {
    const r = requester(ctx);
    const body = await ctx.tx(
      async (scope) => {
        const a = await loadAsRequester(scope, r, ctx.params.appointment_id!);
        const rows = await listNotes(scope, a.id, true, afterId(ctx), ctx.query.limit);
        return pageOf(ctx, rows, await this.notes.many(scope, a, rows.slice(0, ctx.query.limit), 'requester', ctx.locale));
      },
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('appointments.note_create')
export class AppointmentsNoteCreateHandler implements OperationHandler {
  constructor(
    private readonly notes: NoteViews,
    private readonly safety: SafetyCheck,
  ) {}

  async handle(ctx: OperationContext<{ body: string; content_locale: string }>): Promise<OperationResult> {
    const r = requester(ctx);
    const body = await ctx.tx(async (scope) => {
      const a = await loadAsRequester(scope, r, ctx.params.appointment_id!);
      if (
        a.status === 'draft' ||
        (['completed', 'cancelled', 'no_show'].includes(a.status) && a.updated_at < new Date(Date.now() - 30 * 86_400_000))
      )
        throw new ApiError('INVALID_TRANSITION', { detail: 'notes closed' });
      const n = await scope.db
        .insertInto('appointment.appointment_notes')
        .values({
          appointment_id: a.id,
          author_user_id: r.userId,
          author_side: 'requester',
          note_type: 'customer_visible',
          body: ctx.body.body,
          content_locale: ctx.body.content_locale,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      // 52 Appointment.safety_flag: also set by a note that matches the shared safety check.
      if (!a.safety_flag && (await this.safety.check(ctx.body.body)).safety_flag)
        await scope.db.updateTable('appointment.appointments').set({ safety_flag: true }).where('id', '=', a.id).execute();
      await publishEvent(scope, {
        type: 'appointment.note_added',
        aggregateType: 'appointment',
        aggregateId: a.id,
        payload: { author_side: 'requester', note_type: 'customer_visible', provider_organization_id: a.provider_organization_id },
      });
      return (await this.notes.many(scope, a, [n], 'requester', ctx.locale))[0]!;
    });
    return created(body, `${basePath(r)}/${ctx.params.appointment_id}/notes`);
  }
}

@Injectable()
@Operation('pre_visit.requester_get')
export class PreVisitRequesterGetHandler implements OperationHandler {
  constructor(private readonly reports: PreVisitReports) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const r = requester(ctx);
    const body = await ctx.tx(async (scope) => {
      const a = await loadAsRequester(scope, r, ctx.params.appointment_id!);
      let view = await this.reports.view(scope, a, 'requester', ctx.locale);
      if (!view) {
        await this.reports.generate(scope, a, ctx.locale);
        view = await this.reports.view(scope, a, 'requester', ctx.locale);
      }
      return view!;
    });
    return { body };
  }
}
