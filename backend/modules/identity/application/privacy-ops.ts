// Data subject requests (40 §6.5) and onboarding (40 §6.6). DSR intake only:
// staff verify, execute and complete requests on the admin plane (S8); the
// export bundle is delivered through DataExportFiles (media, S4/S8).
import { Injectable, Optional } from '@nestjs/common';
import { sql } from 'kysely';
import { writeAudit } from '#libs/audit/index.js';
import { ApiError } from '#libs/contract/index.js';
import { created, iso, Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { toDataSubjectRequest, toOnboarding } from '../api/projections.js';
import { DataExportFiles, NoDataExportFiles, UserCards } from '../interface/identity.js';
import { caller } from './common.js';

type Position = { id?: string } | undefined;

@Injectable()
export class DsrViews {
  readonly #files: DataExportFiles;

  constructor(@Optional() files?: DataExportFiles) {
    this.#files = files ?? new NoDataExportFiles();
  }

  get files(): DataExportFiles {
    return this.#files;
  }

  /** export_available (derived): a completed export whose file is still downloadable. */
  async available(scope: TxScope, d: { request_type: string; status: string; export_media_asset_id: string | null }): Promise<boolean> {
    if (d.request_type !== 'export' || d.status !== 'completed' || !d.export_media_asset_id) return false;
    return this.#files.available(scope, d.export_media_asset_id);
  }
}

@Injectable()
@Operation('dsr.create')
export class DsrCreateHandler implements OperationHandler {
  async handle(ctx: OperationContext<{ request_type: string; details?: string }>): Promise<OperationResult> {
    const { userId } = caller(ctx);
    const row = await ctx.tx(async (scope) => {
      // One open request per type (data_subject_requests_open_uq → 409 DUPLICATE); due date from policy (one month).
      const r = await scope.db
        .insertInto('identity.data_subject_requests')
        .values({ user_id: userId, request_type: ctx.body.request_type, details: ctx.body.details ?? null })
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeAudit(scope, { action: 'dsr.received', entityType: 'data_subject_request', entityId: r.id, next: r.request_type });
      return r;
    });
    return created(toDataSubjectRequest(row, false), `/v1/me/data-requests/${row.id}`);
  }
}

@Injectable()
@Operation('dsr.list')
export class DsrListHandler implements OperationHandler {
  constructor(private readonly views: DsrViews) {}

  async handle(ctx: OperationContext<undefined, { limit: number }>): Promise<OperationResult> {
    const { userId } = caller(ctx);
    const after = (ctx.cursor as Position)?.id;
    const { items, more } = await ctx.tx(
      async (scope) => {
        let q = scope.db
          .selectFrom('identity.data_subject_requests')
          .selectAll()
          .where('user_id', '=', userId)
          .where('deleted_at', 'is', null);
        if (after) q = q.where('id', '<', after);
        const rows = await q
          .orderBy('id', 'desc')
          .limit(ctx.query.limit + 1)
          .execute();
        const page = rows.slice(0, ctx.query.limit);
        return {
          items: await Promise.all(page.map(async (r) => toDataSubjectRequest(r, await this.views.available(scope, r)))),
          more: rows.length > ctx.query.limit,
        };
      },
      { readOnly: true },
    );
    return { body: ctx.page(items, more ? { id: items.at(-1)!.id } : null) };
  }
}

async function ownRequest(scope: TxScope, userId: string, id: string) {
  const r = await scope.db
    .selectFrom('identity.data_subject_requests')
    .selectAll()
    .where('id', '=', id)
    .where('user_id', '=', userId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!r) throw new ApiError('NOT_FOUND');
  return r;
}

@Injectable()
@Operation('dsr.get')
export class DsrGetHandler implements OperationHandler {
  constructor(private readonly views: DsrViews) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const { userId } = caller(ctx);
    const body = await ctx.tx(
      async (scope) => {
        const r = await ownRequest(scope, userId, ctx.params.request_id!);
        return toDataSubjectRequest(r, await this.views.available(scope, r));
      },
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('dsr.export_download')
export class DsrExportDownloadHandler implements OperationHandler {
  constructor(private readonly views: DsrViews) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const { userId } = caller(ctx);
    const body = await ctx.tx(async (scope) => {
      const r = await ownRequest(scope, userId, ctx.params.request_id!);
      if (r.request_type !== 'export' || r.status !== 'completed' || !r.export_media_asset_id)
        throw new ApiError('INVALID_TRANSITION', { detail: 'not_completed' });
      const signed = await this.views.files.signedUrl(scope, r.export_media_asset_id);
      if (!signed) throw new ApiError('LINK_EXPIRED', { detail: 'file_expired' });
      await writeAudit(scope, { action: 'dsr.export_downloaded', entityType: 'data_subject_request', entityId: r.id });
      return { url: signed.url, expires_at: iso(signed.expiresAt) };
    });
    return { body };
  }
}

// ------------------------------------------------------------------ onboarding

async function onboardingViews(scope: TxScope, cards: UserCards, rows: { assisted_by_user_id: string | null }[]) {
  const ids = rows.map((r) => r.assisted_by_user_id).filter((id): id is string => id !== null);
  return cards.cards(scope, ids);
}

@Injectable()
@Operation('onboarding.list')
export class OnboardingListHandler implements OperationHandler {
  constructor(private readonly cards: UserCards) {}

  async handle(ctx: OperationContext<undefined, { limit: number }>): Promise<OperationResult> {
    const { userId } = caller(ctx);
    const after = (ctx.cursor as Position)?.id;
    const { items, more } = await ctx.tx(
      async (scope) => {
        let q = scope.db
          .selectFrom('identity.onboarding_progress')
          .selectAll()
          .where('user_id', '=', userId)
          .where('deleted_at', 'is', null);
        if (after) q = q.where('id', '>', after);
        const rows = await q
          .orderBy('id')
          .limit(ctx.query.limit + 1)
          .execute();
        const page = rows.slice(0, ctx.query.limit);
        const staff = await onboardingViews(scope, this.cards, page);
        return {
          items: page.map((r) => toOnboarding(r, r.assisted_by_user_id ? (staff.get(r.assisted_by_user_id)?.displayName ?? null) : null)),
          more: rows.length > ctx.query.limit,
        };
      },
      { readOnly: true },
    );
    return { body: ctx.page(items, more ? { id: items.at(-1)!.id } : null) };
  }
}

/** The caller's flow row: a personal one (no organization) first, else the most recently changed one. */
async function flowRow(scope: TxScope, userId: string, flowType: string) {
  return scope.db
    .selectFrom('identity.onboarding_progress')
    .selectAll()
    .where('user_id', '=', userId)
    .where('flow_type', '=', flowType)
    .where('deleted_at', 'is', null)
    .orderBy(sql`organization_id IS NULL`, 'desc')
    .orderBy('updated_at', 'desc')
    .forUpdate()
    .executeTakeFirst();
}

@Injectable()
@Operation('onboarding.update')
export class OnboardingUpdateHandler implements OperationHandler {
  constructor(private readonly cards: UserCards) {}

  async handle(
    ctx: OperationContext<{ current_step: string; completed_step?: string; status?: 'in_progress' | 'completed' | 'abandoned' }>,
  ): Promise<OperationResult> {
    const { userId } = caller(ctx);
    const flowType = ctx.params.flow_type!;
    if (!['individual', 'fleet', 'provider', 'vendor'].includes(flowType)) throw new ApiError('NOT_FOUND');
    const b = ctx.body;
    const body = await ctx.tx(async (scope) => {
      const row = await flowRow(scope, userId, flowType);
      // A flow starts with its first save: If-Match "v1" against a flow that does not exist yet creates it (version 1).
      if (!row) {
        if (ctx.ifMatch !== 1) throw new ApiError('VERSION_MISMATCH');
        const steps = b.completed_step ? [b.completed_step] : [];
        const status = b.status ?? 'in_progress';
        const inserted = await scope.db
          .insertInto('identity.onboarding_progress')
          .values({
            user_id: userId,
            flow_type: flowType,
            current_step: b.current_step,
            completed_steps: steps,
            status,
            completed_at: status === 'completed' ? sql`now()` : null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        return toOnboarding(inserted, null);
      }
      if (row.version !== ctx.ifMatch) throw new ApiError('VERSION_MISMATCH');
      if (row.status === 'completed' && b.status !== undefined && b.status !== 'completed')
        throw new ApiError('INVALID_TRANSITION', { detail: 'flow already completed' });
      // An assisted business flow completes only after the owner accepted the terms (52 OnboardingProgress).
      if (b.status === 'completed' && row.assisted && !row.terms_accepted_at)
        throw new ApiError('INVALID_TRANSITION', { detail: 'terms not accepted' });
      const steps =
        b.completed_step && !row.completed_steps.includes(b.completed_step)
          ? [...row.completed_steps, b.completed_step]
          : row.completed_steps;
      if (steps.length > 50) throw ApiError.validation([{ pointer: '/completed_step', code: 'too_long', limit: '50' }]);
      const status = b.status ?? row.status;
      const updated = await scope.db
        .updateTable('identity.onboarding_progress')
        .set({
          current_step: b.current_step,
          completed_steps: steps,
          status,
          completed_at: status === 'completed' ? (row.completed_at ?? sql`now()`) : null,
        })
        .where('id', '=', row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      const staff = await onboardingViews(scope, this.cards, [updated]);
      if (updated.assisted)
        await writeAudit(scope, {
          action: 'onboarding.step_saved',
          entityType: 'onboarding_progress',
          entityId: updated.id,
          next: b.current_step,
        });
      return toOnboarding(updated, updated.assisted_by_user_id ? (staff.get(updated.assisted_by_user_id)?.displayName ?? null) : null);
    });
    return { body };
  }
}

@Injectable()
@Operation('onboarding.accept_terms')
export class OnboardingAcceptTermsHandler implements OperationHandler {
  constructor(private readonly cards: UserCards) {}

  async handle(ctx: OperationContext<{ terms_version: string }>): Promise<OperationResult> {
    const { userId } = caller(ctx);
    const body = await ctx.tx(async (scope) => {
      const row = await flowRow(scope, userId, ctx.params.flow_type!);
      if (!row) throw new ApiError('NOT_FOUND');
      // Only the owner's own call sets terms_accepted_at (staff cannot accept for the owner: USR on the api host).
      const updated = await scope.db
        .updateTable('identity.onboarding_progress')
        .set({ terms_version: ctx.body.terms_version, terms_accepted_at: sql`now()` })
        .where('id', '=', row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeAudit(scope, {
        action: 'onboarding.terms_accepted',
        entityType: 'onboarding_progress',
        entityId: row.id,
        next: ctx.body.terms_version,
      });
      const staff = await onboardingViews(scope, this.cards, [updated]);
      return toOnboarding(updated, updated.assisted_by_user_id ? (staff.get(updated.assisted_by_user_id)?.displayName ?? null) : null);
    });
    return { body };
  }
}
