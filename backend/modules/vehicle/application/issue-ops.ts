// Vehicle issues (40 §12.2, 52 VehicleIssue, MVP Module B): issues.list /
// create / get / update / status_change. The shared safety keyword check
// runs on the server (SEC-BF-8): it sets the derived safety_flag and the
// urgency can never be below the level it found (an AI or client value only
// raises it, SEC-AI-7). A fleet driver's report starts the fleet approval
// workflow: the fleet module opens the repair request and publishes
// fleet.approval.requested (status pending), or approves at once when the
// fleet has the approval workflow off (S8).
import { Injectable, Optional } from '@nestjs/common';
import { ApiError, type FieldError } from '#libs/contract/index.js';
import { created, Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import { SafetyCheck, type Urgency } from '#libs/safety-check/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { FleetWorkflow } from '#modules/fleet/interface/fleet.js';
import { UserCards } from '#modules/identity/interface/identity.js';
import { MediaService } from '#modules/media/interface/media.js';
import { toIssue, type IssueRow, type VehicleRow } from '../api/projections.js';
import { issueTransitionAllowed } from '../domain/rules.js';
import { afterId, checkVersion, failIf, loadVehicle, notFoundAt, vehicleAccess, vehiclesPath, type VehicleAccess } from './common.js';
import { displayName } from './vehicle-ops.js';

type IssueWrite = {
  title: string;
  description: string;
  content_locale: string;
  symptom_node_id?: string;
  urgency_level: Urgency;
  media_ids?: string[];
};

/** 52 VehicleIssue.description: 10–3000 characters (40 Text<3000> has no minimum). */
const MIN_DESCRIPTION = 10;

@Injectable()
export class IssueViews {
  constructor(
    private readonly safety: SafetyCheck,
    private readonly media: MediaService,
    private readonly users: UserCards,
  ) {}

  async many(scope: TxScope, rows: readonly IssueRow[]) {
    const attachments = await this.media.attachmentViews(
      scope,
      'vehicle_issue',
      rows.map((r) => r.id),
    );
    const cards = await this.users.cards(
      scope,
      rows.map((r) => r.reported_by_user_id),
    );
    return Promise.all(
      rows.map(async (r) =>
        toIssue(r, {
          mediaIds: (attachments.get(r.id) ?? []).filter((v) => v.role === 'issue_photo').map((v) => v.media_asset_id),
          safetyFlag: (await this.safety.check(`${r.title}\n${r.description}`)).safety_flag,
          reportedByDisplay: displayName(cards.get(r.reported_by_user_id)?.displayName),
        }),
      ),
    );
  }

  async one(scope: TxScope, row: IssueRow) {
    return (await this.many(scope, [row]))[0]!;
  }
}

const RANK: Record<Urgency, number> = { low: 1, medium: 2, high: 3, safety_critical: 4 };

/** The urgency stored: the requested one, raised to what the safety check found (never lowered below it). */
async function urgencyFor(safety: SafetyCheck, title: string, description: string, requested: Urgency): Promise<Urgency> {
  const rule = (await safety.check(`${title}\n${description}`)).urgency;
  return rule && RANK[rule] > RANK[requested] ? rule : requested;
}

async function loadIssue(scope: TxScope, v: VehicleRow, issueId: string, lock = false): Promise<IssueRow> {
  const q = scope.db
    .selectFrom('vehicle.vehicle_issues')
    .selectAll()
    .where('id', '=', issueId)
    .where('vehicle_id', '=', v.id)
    .where('deleted_at', 'is', null);
  const row = await (lock ? q.forUpdate() : q).executeTakeFirst();
  if (!row) throw new ApiError('NOT_FOUND');
  return row;
}

const descriptionErrors = (description: string | undefined): FieldError[] =>
  description !== undefined && [...description].length < MIN_DESCRIPTION
    ? [{ pointer: '/description', code: 'too_short', limit: String(MIN_DESCRIPTION) }]
    : [];

/** Issue photos are media of the vehicle's owner, attached to the issue (purpose issue_photo). */
const photos = (a: VehicleAccess, issueId: string) => ({
  owner: a.owner,
  purposes: ['issue_photo' as const],
  pointer: '/media_ids',
  type: 'vehicle_issue' as const,
  id: issueId,
  role: 'issue_photo' as const,
});

@Injectable()
@Operation('issues.list')
export class IssuesListHandler implements OperationHandler {
  constructor(private readonly views: IssueViews) {}

  async handle(ctx: OperationContext<undefined, { status?: string; limit: number }>): Promise<OperationResult> {
    const a = vehicleAccess(ctx);
    const after = afterId(ctx);
    const body = await ctx.tx(
      async (scope) => {
        const v = await loadVehicle(scope, a, ctx.params.vehicle_id!);
        let q = scope.db.selectFrom('vehicle.vehicle_issues').selectAll().where('vehicle_id', '=', v.id).where('deleted_at', 'is', null);
        if (ctx.query.status) q = q.where('status', '=', ctx.query.status);
        if (after) q = q.where('id', '<', after);
        const rows = await q
          .orderBy('id', 'desc')
          .limit(ctx.query.limit + 1)
          .execute();
        const page = rows.slice(0, ctx.query.limit);
        return ctx.page(await this.views.many(scope, page), rows.length > ctx.query.limit ? { id: page.at(-1)!.id } : null);
      },
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('issues.create')
export class IssuesCreateHandler implements OperationHandler {
  constructor(
    private readonly safety: SafetyCheck,
    private readonly media: MediaService,
    private readonly views: IssueViews,
    @Optional() private readonly fleet?: FleetWorkflow,
  ) {}

  async handle(ctx: OperationContext<IssueWrite>): Promise<OperationResult> {
    const a = vehicleAccess(ctx);
    const b = ctx.body;
    failIf(descriptionErrors(b.description));
    const urgency = await urgencyFor(this.safety, b.title, b.description, b.urgency_level);
    const body = await ctx.tx(async (scope) => {
      const v = await loadVehicle(scope, a, ctx.params.vehicle_id!);
      const row = await scope.db
        .insertInto('vehicle.vehicle_issues')
        .values({
          vehicle_id: v.id,
          title: b.title,
          description: b.description,
          content_locale: b.content_locale,
          symptom_node_id: b.symptom_node_id ?? null,
          urgency_level: urgency,
          source: a.driver ? 'fleet_driver' : 'user',
          reported_by_user_id: a.userId,
          fleet_approval_status: a.driver ? 'pending' : null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      if (b.media_ids?.length) await this.media.syncAttachments(scope, b.media_ids, photos(a, row.id));
      const view = await this.views.one(scope, row);
      await publishEvent(scope, {
        type: 'vehicle.issue.reported',
        aggregateType: 'vehicle_issue',
        aggregateId: row.id,
        payload: { vehicle_id: v.id, urgency_level: urgency, safety_flag: view.safety_flag, source: row.source },
      });
      // A driver's report starts the fleet approval workflow (the fleet module opens the repair request, S8).
      if (a.driver && this.fleet) {
        const status = await this.fleet.driverIssue(scope, { orgId: a.orgId!, vehicleId: v.id, issueId: row.id, driverUserId: a.userId });
        if (status !== 'pending') {
          await scope.db.updateTable('vehicle.vehicle_issues').set({ fleet_approval_status: status }).where('id', '=', row.id).execute();
          return { ...view, fleet_approval_status: status };
        }
      }
      return view;
    });
    return created(body, `${vehiclesPath(a)}/${ctx.params.vehicle_id}/issues/${body.id}`);
  }
}

@Injectable()
@Operation('issues.get')
export class IssuesGetHandler implements OperationHandler {
  constructor(private readonly views: IssueViews) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const a = vehicleAccess(ctx);
    const body = await ctx.tx(
      async (scope) =>
        this.views.one(scope, await loadIssue(scope, await loadVehicle(scope, a, ctx.params.vehicle_id!), ctx.params.issue_id!)),
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('issues.update')
export class IssuesUpdateHandler implements OperationHandler {
  constructor(
    private readonly safety: SafetyCheck,
    private readonly media: MediaService,
    private readonly views: IssueViews,
  ) {}

  async handle(ctx: OperationContext<Partial<IssueWrite>>): Promise<OperationResult> {
    const a = vehicleAccess(ctx);
    const b = ctx.body;
    failIf(descriptionErrors(b.description));
    const body = await ctx.tx(async (scope) => {
      const v = await loadVehicle(scope, a, ctx.params.vehicle_id!);
      const i = await loadIssue(scope, v, ctx.params.issue_id!, true);
      // DRV(own reports): a driver edits only issues they reported (SEC-AZ-2: 404, not 403).
      if (a.driver && i.reported_by_user_id !== a.userId) throw new ApiError('NOT_FOUND');
      checkVersion(i.version, ctx.ifMatch);
      if (i.status === 'resolved' || i.status === 'cancelled') throw new ApiError('INVALID_TRANSITION', { detail: `issue is ${i.status}` });
      const title = b.title ?? i.title;
      const description = b.description ?? i.description;
      const urgency = await urgencyFor(this.safety, title, description, b.urgency_level ?? (i.urgency_level as Urgency));
      const row = await scope.db
        .updateTable('vehicle.vehicle_issues')
        .set({
          ...(b.title !== undefined ? { title: b.title } : {}),
          ...(b.description !== undefined ? { description: b.description } : {}),
          ...(b.content_locale !== undefined ? { content_locale: b.content_locale } : {}),
          ...(b.symptom_node_id !== undefined ? { symptom_node_id: b.symptom_node_id } : {}),
          urgency_level: urgency,
        })
        .where('id', '=', i.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (b.media_ids !== undefined) await this.media.syncAttachments(scope, b.media_ids, photos(a, i.id));
      return this.views.one(scope, row);
    });
    return { body };
  }
}

@Injectable()
@Operation('issues.status_change')
export class IssuesStatusChangeHandler implements OperationHandler {
  constructor(private readonly views: IssueViews) {}

  async handle(
    ctx: OperationContext<{ status: 'investigating' | 'resolved' | 'cancelled'; resolved_by_service_record_id?: string }>,
  ): Promise<OperationResult> {
    const a = vehicleAccess(ctx);
    const b = ctx.body;
    if (b.resolved_by_service_record_id && b.status !== 'resolved')
      failIf([{ pointer: '/resolved_by_service_record_id', code: 'conditional_forbidden' }]);
    const body = await ctx.tx(async (scope) => {
      const v = await loadVehicle(scope, a, ctx.params.vehicle_id!);
      const i = await loadIssue(scope, v, ctx.params.issue_id!, true);
      if (!issueTransitionAllowed(i.status, b.status)) throw new ApiError('INVALID_TRANSITION', { detail: `${i.status} -> ${b.status}` });
      if (b.resolved_by_service_record_id) {
        // The record names the issue it resolved (52 VehicleServiceRecord.resolves_issue_id).
        const r = await scope.db
          .updateTable('vehicle.vehicle_service_records')
          .set({ resolves_issue_id: i.id })
          .where('id', '=', b.resolved_by_service_record_id)
          .where('vehicle_id', '=', v.id)
          .where('status', '<>', 'removed')
          .where('deleted_at', 'is', null)
          .where((eb) => eb.or([eb('resolves_issue_id', 'is', null), eb('resolves_issue_id', '=', i.id)]))
          .executeTakeFirst();
        if (Number(r.numUpdatedRows) === 0) throw notFoundAt('/resolved_by_service_record_id');
      }
      const row = await scope.db
        .updateTable('vehicle.vehicle_issues')
        .set({ status: b.status, ...(b.status === 'resolved' ? { resolved_at: new Date() } : {}) })
        .where('id', '=', i.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return this.views.one(scope, row);
    });
    return { body };
  }
}
