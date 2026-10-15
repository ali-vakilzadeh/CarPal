// Provider work records (40 §8.2): job logs, private customer notes and the
// portfolio. Visits, customers and vehicles belong to other modules and are
// resolved through OrganizationExtensions (fail closed until they register).
// Publishing a portfolio item needs a clean attachment, the customer's
// showcase consent when a customer visit is linked, and moderation approval:
// it waits in pending_review until the moderation queue (S8) approves it and
// emits portfolio.published.
import { Injectable } from '@nestjs/common';
import { writeAudit } from '#libs/audit/index.js';
import { ConsentChecker, requireConsent } from '#libs/consent-gate/index.js';
import { ApiError, type FieldError } from '#libs/contract/index.js';
import {
  ACK,
  accepted,
  created,
  Operation,
  type OperationContext,
  type OperationHandler,
  type OperationResult,
} from '#libs/http-pipeline/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { ConsentRequests } from '#modules/identity/interface/identity.js';
import { AiReferences } from '#modules/ai-mcp/interface/ai.js';
import { MediaService } from '#modules/media/interface/media.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { toCustomerNote, toJobLog, toPortfolioItem, type JobLogRow, type PortfolioRow } from '../api/projections.js';
import { isFutureDate } from '../domain/profile-rules.js';
import { OrganizationExtensions, type JobLogVerification, type VisitKind } from '../interface/extensions.js';
import { afterId, checkChain, checkNodes, checkVersion, failIf, loadOrg, member, pageOf, type MemberAccess } from './common.js';
import { revokeEvidence } from './provider-profile-ops.js';

const notFound = (pointer: string) => ApiError.validation([{ pointer, code: 'reference_not_found' }], 'REFERENCE_NOT_FOUND');

const VERIFICATION_RANK: Record<JobLogVerification, number> = {
  self_reported: 0,
  customer_confirmed: 1,
  appointment_verified: 2,
  invoice_verified: 3,
};

type VisitLinks = { appointment_id?: string | null; service_record_id?: string | null };

/**
 * Linked visits must be visits at this provider (40 JobLogWrite /
 * PortfolioWrite appointment_id, service_record_id): links in `written`
 * must resolve; links kept from `previous` that no longer resolve just stop
 * counting. Returns the strongest verification the resolved visits give a
 * job log (54 §1.1).
 */
async function checkVisits(
  ext: OrganizationExtensions,
  scope: TxScope,
  orgId: string,
  written: VisitLinks,
  previous: VisitLinks = {},
): Promise<JobLogVerification> {
  let best: JobLogVerification = 'self_reported';
  for (const kind of ['appointment', 'service_record'] as VisitKind[]) {
    const key = `${kind}_id` as const;
    const id = written[key] !== undefined ? written[key] : previous[key];
    if (!id) continue;
    const visit = await ext.visit(scope, kind, orgId, id);
    if (!visit) {
      if (written[key] !== undefined) throw notFound(`/${key}`);
      continue;
    }
    const got = visit.jobLogVerification ?? 'self_reported';
    if (VERIFICATION_RANK[got] > VERIFICATION_RANK[best]) best = got;
  }
  return best;
}

/**
 * CNS(vehicle_data_sharing): a customer vehicle is linked only with the
 * owner's consent to this provider (52 ProviderJobLog.vehicle_id). Unknown
 * vehicles and vehicles without a resolvable owner fail closed.
 */
async function requireVehicleConsent(
  ext: OrganizationExtensions,
  consents: ConsentChecker,
  scope: TxScope,
  orgId: string,
  vehicleId: string,
): Promise<string> {
  const owner = await ext.vehicleOwner(scope, vehicleId);
  if (!owner)
    throw new ApiError('CONSENT_REQUIRED', { detail: 'vehicle owner unknown', extensions: { consent_type: 'vehicle_data_sharing' } });
  await requireConsent(consents, scope, {
    consentType: 'vehicle_data_sharing',
    subject: { type: 'user', id: owner },
    scopeEntity: { type: 'vehicle', id: vehicleId },
    grantee: { type: 'organization', id: orgId },
  });
  return owner;
}

// ------------------------------------------------------------ job logs

type JobLogWrite = {
  job_date: string;
  brand_node_id?: string;
  model_node_id?: string;
  series_node_id?: string;
  service_system_node_id: string;
  service_task_node_id?: string;
  description?: string;
  vehicle_id?: string;
  appointment_id?: string;
  service_record_id?: string;
};

async function loadJobLog(scope: TxScope, orgId: string, id: string, lock = false): Promise<JobLogRow> {
  const q = scope.db
    .selectFrom('organization.provider_job_logs')
    .selectAll()
    .where('id', '=', id)
    .where('provider_organization_id', '=', orgId)
    .where('status', '=', 'active')
    .where('deleted_at', 'is', null);
  const row = await (lock ? q.forUpdate() : q).executeTakeFirst();
  if (!row) throw new ApiError('NOT_FOUND');
  return row;
}

@Injectable()
@Operation('provider.job_logs_list')
export class ProviderJobLogsListHandler implements OperationHandler {
  async handle(
    ctx: OperationContext<undefined, { from?: string; to?: string; service_system_node_id?: string; limit: number }>,
  ): Promise<OperationResult> {
    const m = member(ctx);
    const after = afterId(ctx);
    const rows = await ctx.tx(
      (scope) => {
        let q = scope.db
          .selectFrom('organization.provider_job_logs')
          .selectAll()
          .where('provider_organization_id', '=', m.orgId)
          .where('status', '=', 'active')
          .where('deleted_at', 'is', null);
        if (ctx.query.from) q = q.where('job_date', '>=', ctx.query.from);
        if (ctx.query.to) q = q.where('job_date', '<=', ctx.query.to);
        if (ctx.query.service_system_node_id) q = q.where('service_system_node_id', '=', ctx.query.service_system_node_id);
        if (after) q = q.where('id', '<', after);
        return q
          .orderBy('id', 'desc')
          .limit(ctx.query.limit + 1)
          .execute();
      },
      { readOnly: true },
    );
    return { body: pageOf(ctx, rows, toJobLog) };
  }
}

@Injectable()
export class JobLogRules {
  constructor(
    private readonly taxonomy: TaxonomyResolver,
    private readonly ext: OrganizationExtensions,
    private readonly consents: ConsentChecker,
  ) {}

  /** Checks a write; returns the verification the linked visits give the job log (system-set, 54 §1.1). */
  async check(scope: TxScope, m: MemberAccess, j: Partial<JobLogWrite>, previous?: JobLogRow): Promise<JobLogVerification> {
    if (j.job_date !== undefined && isFutureDate(j.job_date)) failIf([{ pointer: '/job_date', code: 'in_future' }]);
    const merged = { ...previous, ...j };
    await checkChain(this.taxonomy, merged);
    const verification = await checkVisits(this.ext, scope, m.orgId, j, previous);
    if (j.vehicle_id && j.vehicle_id !== previous?.vehicle_id)
      await requireVehicleConsent(this.ext, this.consents, scope, m.orgId, j.vehicle_id);
    return verification;
  }
}

@Injectable()
@Operation('provider.job_log_create')
export class ProviderJobLogCreateHandler implements OperationHandler {
  constructor(private readonly rules: JobLogRules) {}

  async handle(ctx: OperationContext<JobLogWrite>): Promise<OperationResult> {
    const m = member(ctx);
    const b = ctx.body;
    const row = await ctx.tx(async (scope) => {
      const verification = await this.rules.check(scope, m, b);
      return scope.db
        .insertInto('organization.provider_job_logs')
        .values({
          provider_organization_id: m.orgId,
          job_date: b.job_date,
          brand_node_id: b.brand_node_id ?? null,
          model_node_id: b.model_node_id ?? null,
          series_node_id: b.series_node_id ?? null,
          service_system_node_id: b.service_system_node_id,
          service_task_node_id: b.service_task_node_id ?? null,
          description: b.description ?? null,
          vehicle_id: b.vehicle_id ?? null,
          appointment_id: b.appointment_id ?? null,
          service_record_id: b.service_record_id ?? null,
          logged_by_user_id: m.userId,
          // System-set from the linked visit: a job log counts as evidence only once verified (54 §1.1).
          verification_status: verification,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    return created(toJobLog(row), `/v1/orgs/${m.orgId}/provider/job-logs/${row.id}`);
  }
}

@Injectable()
@Operation('provider.job_log_update')
export class ProviderJobLogUpdateHandler implements OperationHandler {
  constructor(private readonly rules: JobLogRules) {}

  async handle(ctx: OperationContext<Partial<JobLogWrite>>): Promise<OperationResult> {
    const m = member(ctx);
    const b = ctx.body;
    const row = await ctx.tx(async (scope) => {
      const j = await loadJobLog(scope, m.orgId, ctx.params.job_log_id!, true);
      checkVersion(j.version, ctx.ifMatch);
      const verification = await this.rules.check(scope, m, b, j);
      return scope.db
        .updateTable('organization.provider_job_logs')
        .set({ ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)), verification_status: verification })
        .where('id', '=', j.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    return { body: toJobLog(row) };
  }
}

@Injectable()
@Operation('provider.job_log_delete')
export class ProviderJobLogDeleteHandler implements OperationHandler {
  async handle(ctx: OperationContext): Promise<OperationResult> {
    const m = member(ctx);
    await ctx.tx(async (scope) => {
      const j = await loadJobLog(scope, m.orgId, ctx.params.job_log_id!, true);
      await scope.db.updateTable('organization.provider_job_logs').set({ status: 'removed' }).where('id', '=', j.id).execute();
      await revokeEvidence(scope, 'job_log', j.id);
      await writeAudit(scope, { action: 'provider.job_log_removed', entityType: 'provider_job_log', entityId: j.id });
    });
    return { body: ACK };
  }
}

// ------------------------------------------------------------ customer notes

@Injectable()
@Operation('provider.customer_notes_list')
export class ProviderCustomerNotesListHandler implements OperationHandler {
  async handle(ctx: OperationContext<undefined, { customer_user_id: string; limit: number }>): Promise<OperationResult> {
    const m = member(ctx);
    const after = afterId(ctx);
    const rows = await ctx.tx(
      (scope) => {
        let q = scope.db
          .selectFrom('organization.provider_customer_notes')
          .selectAll()
          .where('provider_organization_id', '=', m.orgId)
          .where('customer_user_id', '=', ctx.query.customer_user_id)
          .where('status', '=', 'active')
          .where('deleted_at', 'is', null);
        if (after) q = q.where('id', '<', after);
        return q
          .orderBy('id', 'desc')
          .limit(ctx.query.limit + 1)
          .execute();
      },
      { readOnly: true },
    );
    return { body: pageOf(ctx, rows, toCustomerNote) };
  }
}

@Injectable()
@Operation('provider.customer_note_create')
export class ProviderCustomerNoteCreateHandler implements OperationHandler {
  constructor(private readonly ext: OrganizationExtensions) {}

  async handle(ctx: OperationContext<{ customer_user_id: string; vehicle_id?: string; body: string }>): Promise<OperationResult> {
    const m = member(ctx);
    const b = ctx.body;
    const row = await ctx.tx(async (scope) => {
      // 52 ProviderCustomerNote: the customer has an appointment or service record with this provider.
      if (!(await this.ext.hasCustomer(scope, m.orgId, b.customer_user_id))) throw notFound('/customer_user_id');
      if (b.vehicle_id && (await this.ext.vehicleOwner(scope, b.vehicle_id)) !== b.customer_user_id) throw notFound('/vehicle_id');
      return scope.db
        .insertInto('organization.provider_customer_notes')
        .values({
          provider_organization_id: m.orgId,
          customer_user_id: b.customer_user_id,
          vehicle_id: b.vehicle_id ?? null,
          body: b.body,
          author_user_id: m.userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    return created(toCustomerNote(row), `/v1/orgs/${m.orgId}/provider/customer-notes/${row.id}`);
  }
}

async function loadNote(scope: TxScope, orgId: string, id: string) {
  const row = await scope.db
    .selectFrom('organization.provider_customer_notes')
    .selectAll()
    .where('id', '=', id)
    .where('provider_organization_id', '=', orgId)
    .where('status', '=', 'active')
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw new ApiError('NOT_FOUND');
  return row;
}

@Injectable()
@Operation('provider.customer_note_update')
export class ProviderCustomerNoteUpdateHandler implements OperationHandler {
  async handle(ctx: OperationContext<{ body: string }>): Promise<OperationResult> {
    const m = member(ctx);
    const row = await ctx.tx(async (scope) => {
      const n = await loadNote(scope, m.orgId, ctx.params.note_id!);
      checkVersion(n.version, ctx.ifMatch);
      return scope.db
        .updateTable('organization.provider_customer_notes')
        .set({ body: ctx.body.body })
        .where('id', '=', n.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    return { body: toCustomerNote(row) };
  }
}

@Injectable()
@Operation('provider.customer_note_delete')
export class ProviderCustomerNoteDeleteHandler implements OperationHandler {
  async handle(ctx: OperationContext): Promise<OperationResult> {
    const m = member(ctx);
    await ctx.tx(async (scope) => {
      const n = await loadNote(scope, m.orgId, ctx.params.note_id!);
      await scope.db.updateTable('organization.provider_customer_notes').set({ status: 'removed' }).where('id', '=', n.id).execute();
    });
    return { body: ACK };
  }
}

// ------------------------------------------------------------ portfolio

type PortfolioWrite = {
  title: string;
  description?: string;
  content_locale: string;
  brand_node_id?: string;
  model_node_id?: string;
  series_node_id?: string;
  service_system_node_id: string;
  service_task_node_id?: string;
  tag_node_ids?: string[];
  job_date?: string;
  job_log_id?: string;
  service_record_id?: string;
  appointment_id?: string;
  caption?: string;
  caption_source?: 'manual' | 'ai_approved';
  ai_caption_insight_id?: string;
  visibility: string;
};

@Injectable()
export class PortfolioRules {
  constructor(
    private readonly taxonomy: TaxonomyResolver,
    private readonly ext: OrganizationExtensions,
    private readonly media: MediaService,
    private readonly ai: AiReferences,
  ) {}

  async check(scope: TxScope, orgId: string, p: Partial<PortfolioWrite>, previous?: PortfolioRow): Promise<void> {
    const errors: FieldError[] = [];
    if (p.job_date !== undefined && isFutureDate(p.job_date)) errors.push({ pointer: '/job_date', code: 'in_future' });
    const caption = p.caption !== undefined ? p.caption : previous?.caption;
    const source = p.caption_source !== undefined ? p.caption_source : previous?.caption_source;
    if (caption && !source) errors.push({ pointer: '/caption_source', code: 'conditional_required' });
    const insightId = p.ai_caption_insight_id !== undefined ? p.ai_caption_insight_id : (previous?.ai_caption_insight_id ?? undefined);
    if (source === 'ai_approved' && !insightId) errors.push({ pointer: '/ai_caption_insight_id', code: 'conditional_required' });
    if (p.ai_caption_insight_id && p.caption_source === 'manual')
      errors.push({ pointer: '/ai_caption_insight_id', code: 'conditional_forbidden' });
    failIf(errors);
    // An ai_approved caption cites the organization's own showcase insight (ai.showcase_compose, S9); saving it is the
    // human decision (SEC-AI-3). A staff member's draft waits for its approval request first (53 §14.2).
    if (p.ai_caption_insight_id) {
      const i = await this.ai.usable(scope, p.ai_caption_insight_id, {
        types: ['showcase_caption', 'showcase_draft'],
        ...(previous ? { subject: { type: 'portfolio_item', id: previous.id } } : {}),
      });
      if (!i || i.organizationId !== orgId) throw notFound('/ai_caption_insight_id');
      if (await this.ai.awaitingApproval(scope, i.id)) throw new ApiError('INVALID_TRANSITION', { detail: 'approval_pending' });
      await this.ai.approveUse(scope, i.id);
    }
    await checkChain(this.taxonomy, { ...previous, ...p });
    await checkNodes(
      this.taxonomy,
      p.tag_node_ids,
      ['vehicle_brand', 'vehicle_model', 'vehicle_series', 'service_system', 'service_task', 'symptom', 'part_category'],
      '/tag_node_ids',
    );
    await checkVisits(this.ext, scope, orgId, p);
    if (p.job_log_id) {
      const j = await scope.db
        .selectFrom('organization.provider_job_logs')
        .select('id')
        .where('id', '=', p.job_log_id)
        .where('provider_organization_id', '=', orgId)
        .where('status', '=', 'active')
        .executeTakeFirst();
      if (!j) throw notFound('/job_log_id');
    }
  }

  async view(scope: TxScope, rows: PortfolioRow[]) {
    const media = await this.media.attachmentViews(
      scope,
      'portfolio_item',
      rows.map((r) => r.id),
    );
    return rows.map((r) => toPortfolioItem(r, media.get(r.id) ?? []));
  }
}

async function loadItem(scope: TxScope, orgId: string, id: string, lock = false): Promise<PortfolioRow> {
  const q = scope.db
    .selectFrom('organization.portfolio_items')
    .selectAll()
    .where('id', '=', id)
    .where('provider_organization_id', '=', orgId)
    .where('deleted_at', 'is', null);
  const row = await (lock ? q.forUpdate() : q).executeTakeFirst();
  if (!row) throw new ApiError('NOT_FOUND');
  return row;
}

@Injectable()
@Operation('provider.portfolio_list')
export class ProviderPortfolioListHandler implements OperationHandler {
  constructor(private readonly rules: PortfolioRules) {}

  async handle(ctx: OperationContext<undefined, { status?: string; limit: number }>): Promise<OperationResult> {
    const m = member(ctx);
    const after = afterId(ctx);
    const { items, more } = await ctx.tx(
      async (scope) => {
        let q = scope.db
          .selectFrom('organization.portfolio_items')
          .selectAll()
          .where('provider_organization_id', '=', m.orgId)
          .where('deleted_at', 'is', null);
        if (ctx.query.status) q = q.where('status', '=', ctx.query.status);
        if (after) q = q.where('id', '<', after);
        const rows = await q
          .orderBy('id', 'desc')
          .limit(ctx.query.limit + 1)
          .execute();
        return { items: await this.rules.view(scope, rows.slice(0, ctx.query.limit)), more: rows.length > ctx.query.limit };
      },
      { readOnly: true },
    );
    return { body: ctx.page(items, more ? { id: items.at(-1)!.id } : null) };
  }
}

@Injectable()
@Operation('provider.portfolio_create')
export class ProviderPortfolioCreateHandler implements OperationHandler {
  constructor(private readonly rules: PortfolioRules) {}

  async handle(ctx: OperationContext<PortfolioWrite>): Promise<OperationResult> {
    const m = member(ctx);
    const b = ctx.body;
    const body = await ctx.tx(async (scope) => {
      await this.rules.check(scope, m.orgId, b);
      const row = await scope.db
        .insertInto('organization.portfolio_items')
        .values({
          provider_organization_id: m.orgId,
          title: b.title,
          description: b.description ?? null,
          content_locale: b.content_locale,
          brand_node_id: b.brand_node_id ?? null,
          model_node_id: b.model_node_id ?? null,
          series_node_id: b.series_node_id ?? null,
          service_system_node_id: b.service_system_node_id,
          service_task_node_id: b.service_task_node_id ?? null,
          tag_node_ids: b.tag_node_ids ?? [],
          job_date: b.job_date ?? null,
          job_log_id: b.job_log_id ?? null,
          service_record_id: b.service_record_id ?? null,
          appointment_id: b.appointment_id ?? null,
          caption: b.caption ?? null,
          caption_source: b.caption_source ?? null,
          ai_caption_insight_id: b.ai_caption_insight_id ?? null,
          visibility: b.visibility,
          status: 'draft',
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return (await this.rules.view(scope, [row]))[0]!;
    });
    return created(body, `/v1/orgs/${m.orgId}/provider/portfolio/${body.id}`);
  }
}

@Injectable()
@Operation('provider.portfolio_update')
export class ProviderPortfolioUpdateHandler implements OperationHandler {
  constructor(private readonly rules: PortfolioRules) {}

  async handle(ctx: OperationContext<Partial<PortfolioWrite>>): Promise<OperationResult> {
    const m = member(ctx);
    const b = ctx.body;
    const body = await ctx.tx(async (scope) => {
      const p = await loadItem(scope, m.orgId, ctx.params.item_id!, true);
      checkVersion(p.version, ctx.ifMatch);
      if (p.status === 'archived') throw new ApiError('INVALID_TRANSITION', { detail: 'archived' });
      await this.rules.check(scope, m.orgId, b, p);
      // Editing a published item returns it to review; a rejected item back to draft.
      const status = p.status === 'published' ? 'pending_review' : p.status === 'rejected' ? 'draft' : p.status;
      const row = await scope.db
        .updateTable('organization.portfolio_items')
        .set({
          ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)),
          status,
          ...(status !== p.status ? { moderation_status: 'pending' } : {}),
        })
        .where('id', '=', p.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return (await this.rules.view(scope, [row]))[0]!;
    });
    return { body };
  }
}

/** Showcase consent of a customer visit (52 PortfolioItem: consent granted if the customer is identifiable). */
const SHOWCASE = 'showcase_publishing';

@Injectable()
@Operation('provider.portfolio_consent_request')
export class ProviderPortfolioConsentRequestHandler implements OperationHandler {
  constructor(
    private readonly ext: OrganizationExtensions,
    private readonly requests: ConsentRequests,
  ) {}

  async handle(ctx: OperationContext<{ appointment_id?: string; service_record_id?: string }>): Promise<OperationResult> {
    const m = member(ctx);
    const b = ctx.body;
    // C: exactly one visit; the server derives the customer from it (no arbitrary targets).
    if (!b.appointment_id === !b.service_record_id)
      throw ApiError.validation([
        {
          pointer: b.appointment_id ? '/service_record_id' : '/appointment_id',
          code: b.appointment_id ? 'conditional_forbidden' : 'conditional_required',
        },
      ]);
    const kind: VisitKind = b.appointment_id ? 'appointment' : 'service_record';
    const visitId = (b.appointment_id ?? b.service_record_id)!;
    await ctx.tx(async (scope) => {
      const item = await loadItem(scope, m.orgId, ctx.params.item_id!, true);
      if (item.status === 'archived') throw new ApiError('INVALID_TRANSITION', { detail: 'archived' });
      const visit = await this.ext.visit(scope, kind, m.orgId, visitId);
      if (!visit) throw notFound(`/${kind}_id`);
      const org = await loadOrg(scope, m.orgId);
      await this.requests.create(scope, {
        organizationId: m.orgId,
        requestedByUserId: m.userId,
        subjectUserId: visit.customerUserId,
        consentType: SHOWCASE,
        scope: { type: 'portfolio_item', id: item.id },
        sourceVisit: { type: kind, id: visitId },
        purposeI18nKey: 'consent.purpose.portfolio_showcase',
        organizationName: org.name,
      });
      await scope.db
        .updateTable('organization.portfolio_items')
        .set({
          customer_consent_status: 'requested',
          consent_reference_id: null,
          ...(kind === 'appointment' ? { appointment_id: visitId } : { service_record_id: visitId }),
        })
        .where('id', '=', item.id)
        .execute();
    });
    return accepted({ ok: true });
  }
}

@Injectable()
@Operation('provider.portfolio_publish')
export class ProviderPortfolioPublishHandler implements OperationHandler {
  constructor(
    private readonly rules: PortfolioRules,
    private readonly media: MediaService,
    private readonly requests: ConsentRequests,
    private readonly consents: ConsentChecker,
    private readonly ext: OrganizationExtensions,
  ) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const m = member(ctx);
    const body = await ctx.tx(async (scope) => {
      const p = await loadItem(scope, m.orgId, ctx.params.item_id!, true);
      if (p.status === 'archived' || p.status === 'pending_review' || p.status === 'published')
        throw new ApiError('INVALID_TRANSITION', { detail: p.status });
      const assets = await this.media.attachedAssets(scope, 'portfolio_item', p.id);
      if (assets.length === 0)
        throw new ApiError('PUBLISH_REQUIREMENTS_UNMET', { detail: 'media', extensions: { requirements: ['media'] } });
      if (assets.some((a) => !a.ready)) throw new ApiError('MEDIA_NOT_READY');
      let consent: { status: string; ref: string | null } = { status: p.customer_consent_status, ref: p.consent_reference_id };
      // A linked customer visit makes the customer identifiable: their showcase consent to this provider is required.
      if (p.appointment_id || p.service_record_id) {
        const req = await this.requests.latest(scope, m.orgId, SHOWCASE, { type: 'portfolio_item', id: p.id });
        const customer = await this.#customer(scope, m.orgId, p);
        // The request's answer is re-checked against the live consent (a withdrawal counts at once, SEC-AZ-8).
        const live =
          req?.status === 'granted' &&
          !!req.resultingConsentId &&
          !!customer &&
          (await this.consents.isGranted(scope, {
            consentType: SHOWCASE,
            subject: { type: 'user', id: customer },
            scopeEntity: { type: 'portfolio_item', id: p.id },
            grantee: { type: 'organization', id: m.orgId },
          }));
        if (!live)
          throw new ApiError('CONSENT_REQUIRED', {
            detail: `showcase consent ${req?.status ?? 'not requested'}`,
            extensions: { consent_type: SHOWCASE },
          });
        consent = { status: 'granted', ref: req!.resultingConsentId };
      }
      // Moderation decides (S8 queue); portfolio.published is emitted when it approves.
      const row = await scope.db
        .updateTable('organization.portfolio_items')
        .set({
          status: 'pending_review',
          moderation_status: 'pending',
          customer_consent_status: consent.status,
          consent_reference_id: consent.ref,
        })
        .where('id', '=', p.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return (await this.rules.view(scope, [row]))[0]!;
    });
    return { body };
  }

  /** The customer of the item's linked visit (subject of the consent). */
  async #customer(scope: TxScope, orgId: string, p: PortfolioRow): Promise<string | null> {
    const kind: VisitKind = p.appointment_id ? 'appointment' : 'service_record';
    const visit = await this.ext.visit(scope, kind, orgId, (p.appointment_id ?? p.service_record_id)!);
    return visit?.customerUserId ?? null;
  }
}

@Injectable()
@Operation('provider.portfolio_archive')
export class ProviderPortfolioArchiveHandler implements OperationHandler {
  constructor(private readonly rules: PortfolioRules) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const m = member(ctx);
    const body = await ctx.tx(async (scope) => {
      const p = await loadItem(scope, m.orgId, ctx.params.item_id!, true);
      if (p.status === 'archived') throw new ApiError('INVALID_TRANSITION', { detail: 'archived' });
      const row = await scope.db
        .updateTable('organization.portfolio_items')
        .set({ status: 'archived' })
        .where('id', '=', p.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await revokeEvidence(scope, 'portfolio_item', p.id);
      return (await this.rules.view(scope, [row]))[0]!;
    });
    return { body };
  }
}
