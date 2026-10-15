// Media operations (40 §17.2, SEC-UP): two-phase upload (upload_init →
// signed PUT → upload_complete → W6 processing), asset reads, signed
// downloads, attachments and redaction. Every operation is USR | ORG(ANY):
// the asset's owner decides the organization, which is authorized like a
// path organization (SEC-AZ-2) before its RLS context is used.
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { writeAudit } from '#libs/audit/index.js';
import { Authorizer } from '#libs/authz/index.js';
import { ApiError, type FieldError } from '#libs/contract/index.js';
import type { AttachedToType, AttachmentRole } from '#libs/contract/generated/enums.js';
import { uuidv7 } from '#libs/crypto/index.js';
import {
  ACK,
  accepted,
  created,
  Operation,
  type OperationContext,
  type OperationHandler,
  type OperationResult,
} from '#libs/http-pipeline/index.js';
import type { Infra } from '#libs/infra/index.js';
import { acceptedJob, JobService } from '#libs/jobs/index.js';
import { InjectInfra } from '#libs/runtime/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { toAttachmentView, toMediaAsset } from '../api/projections.js';
import { encryptedAtRest, mediaTypeOf, PURPOSES, SIZE_LIMIT, type MimeType } from '../domain/purposes.js';
import { displayKeyOf, findVisibleAsset, keys, servableToOwner, type AssetRow, type VisibleAsset } from '../infrastructure/assets.js';
import { AiReferences } from '#modules/ai-mcp/interface/ai.js';
import { AttachmentTargets } from '../interface/media.js';
import { MediaUrls } from './media-service.js';

/** W6 queues (workers/media-processor). */
export const MEDIA_PROCESS_QUEUE = 'media.process';
export const MEDIA_REDACTION_QUEUE = 'media.redaction';

const UPLOAD_TTL_MS = 10 * 60_000;
const CHECKSUM = /^[A-Za-z0-9+/]{43}=$/;

function caller(ctx: OperationContext): string {
  if (ctx.principal.kind !== 'user') throw new ApiError('NOT_FOUND');
  return ctx.principal.userId;
}

/**
 * The asset, owned by the caller or by an organization the caller may act
 * for (SEC-AZ-2 through authorizeOrg). Public assets of others are visible
 * (`owned` false) only where `allowPublic`.
 */
async function asset(
  ctx: OperationContext,
  authorizer: Authorizer,
  scope: TxScope,
  id: string,
  o: { lock?: boolean; allowPublic?: boolean } = {},
) {
  const userId = caller(ctx);
  const v = await findVisibleAsset(scope, authorizer, userId, id, o.lock);
  if (!v || v.row.status === 'pending_upload' || v.row.status === 'removed') throw new ApiError('NOT_FOUND');
  if (v.orgId) await ctx.authorizeOrg(v.orgId, ['ANY']);
  if (!v.owned && !(o.allowPublic && v.row.publicly_servable)) throw new ApiError('NOT_FOUND');
  return v;
}

type UploadInit = {
  purpose: keyof typeof PURPOSES;
  owner: { type: 'user' | 'organization'; id: string };
  mime_type: MimeType;
  file_size_bytes: number;
  checksum_sha256: string;
};

@Injectable()
@Operation('media.upload_init')
export class MediaUploadInitHandler implements OperationHandler {
  constructor(@InjectInfra() private readonly infra: Infra) {}

  async handle(ctx: OperationContext<UploadInit>): Promise<OperationResult> {
    const userId = caller(ctx);
    const b = ctx.body;
    const policy = PURPOSES[b.purpose];
    const errors: FieldError[] = [];
    // 40 VALIDATION_FAILED(type_not_allowed_for_purpose); SEC-UP-2 size limits.
    if (!policy || !policy.types.includes(b.mime_type)) errors.push({ pointer: '/mime_type', code: 'enum' });
    else if (b.file_size_bytes > SIZE_LIMIT[b.mime_type])
      errors.push({ pointer: '/file_size_bytes', code: 'out_of_range', limit: String(SIZE_LIMIT[b.mime_type]) });
    if (!CHECKSUM.test(b.checksum_sha256)) errors.push({ pointer: '/checksum_sha256', code: 'pattern' });
    if (b.owner.type === 'user' && b.owner.id !== userId) errors.push({ pointer: '/owner/id', code: 'reference_not_found' });
    if (errors.length)
      throw ApiError.validation(errors, errors.some((e) => e.code === 'reference_not_found') ? 'REFERENCE_NOT_FOUND' : 'VALIDATION_FAILED');
    // ORG(ANY): uploads for an organization need an active membership there.
    const org = b.owner.type === 'organization' ? await ctx.authorizeOrg(b.owner.id, ['ANY']) : null;
    // SEC-RL upload: 2 GB per day per user on top of the pipeline's 60 files per hour.
    await ctx.rateLimit('upload', 'bytes', userId, b.file_size_bytes);
    const id = uuidv7();
    const expiresAt = new Date(Date.now() + UPLOAD_TTL_MS);
    await ctx.tx(async (scope) => {
      if (org) await scope.setOrganization(org.id, org.role);
      await scope.db
        .insertInto('media.media_assets')
        .values({
          id,
          owner_type: b.owner.type,
          owner_id: b.owner.id,
          purpose: b.purpose,
          media_type: mediaTypeOf(b.mime_type),
          mime_type: b.mime_type,
          file_size_bytes: b.file_size_bytes,
          checksum_sha256: b.checksum_sha256,
          storage_reference: keys.upload(id),
          privacy_level: policy.privacy,
          encrypted_at_rest: encryptedAtRest(b.mime_type, policy.privacy),
          uploaded_by: userId,
          upload_expires_at: expiresAt,
          status: 'pending_upload',
        })
        .execute();
    });
    const put = await this.infra.storage.presignPut(keys.upload(id), {
      contentType: b.mime_type,
      contentLength: b.file_size_bytes,
      sha256: b.checksum_sha256,
      expiresInMs: UPLOAD_TTL_MS,
    });
    return created(
      {
        upload_id: id,
        method: 'PUT',
        url: put.url,
        headers: {
          'Content-Type': put.headers['content-type']!,
          'Content-Length': put.headers['content-length']!,
          'x-amz-checksum-sha256': put.headers['x-amz-checksum-sha256']!,
        },
        expires_at: put.expiresAt.toISOString(),
      },
      `/v1/media/${id}`,
    );
  }
}

@Injectable()
@Operation('media.upload_complete')
export class MediaUploadCompleteHandler implements OperationHandler {
  constructor(
    private readonly authorizer: Authorizer,
    private readonly urls: MediaUrls,
    @InjectInfra() private readonly infra: Infra,
  ) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const userId = caller(ctx);
    const row = await ctx.tx(async (scope) => {
      const v = await findVisibleAsset(scope, this.authorizer, userId, ctx.params.upload_id!, true);
      if (!v || !v.owned || v.row.status === 'removed') throw new ApiError('NOT_FOUND');
      if (v.orgId) await ctx.authorizeOrg(v.orgId, ['ANY']);
      const a = v.row;
      // Completed before (another key): report the current state.
      if (a.status !== 'pending_upload') return a;
      if (a.upload_expires_at && new Date(a.upload_expires_at).getTime() < Date.now())
        throw new ApiError('LINK_EXPIRED', { detail: 'ticket' });
      // SEC-UP-1: the stored object must match the declaration (the signed PUT already fixed type, length and checksum).
      const info = await this.infra.storage.head(keys.upload(a.id));
      if (!info || info.size !== Number(a.file_size_bytes) || info.sha256 !== a.checksum_sha256 || info.contentType !== a.mime_type)
        throw new ApiError('UPLOAD_MISMATCH');
      const done = await scope.db
        .updateTable('media.media_assets')
        .set({ status: 'active', scan_status: 'pending' })
        .where('id', '=', a.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      // W6 scans, sniffs, re-encodes and emits media.scan.completed; a lost queue entry is re-queued by its sweep.
      scope.afterCommit(() => this.infra.jobs.enqueue(MEDIA_PROCESS_QUEUE, { jobId: a.id }));
      return done;
    });
    const thumb = servableToOwner(row) && row.thumbnail_reference ? (await this.urls.sign(row.thumbnail_reference, row)).url : null;
    return accepted(toMediaAsset(row, thumb), `/v1/media/${row.id}`);
  }
}

@Injectable()
@Operation('media.get')
export class MediaGetHandler implements OperationHandler {
  constructor(
    private readonly authorizer: Authorizer,
    private readonly urls: MediaUrls,
  ) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const v = await ctx.tx((scope) => asset(ctx, this.authorizer, scope, ctx.params.media_id!, { allowPublic: true }), { readOnly: true });
    const a = v.row;
    const servable = v.owned ? servableToOwner(a) : !!a.publicly_servable;
    const thumb = servable && a.thumbnail_reference ? (await this.urls.sign(a.thumbnail_reference, a)).url : null;
    return { body: toMediaAsset(a, thumb) };
  }
}

@Injectable()
@Operation('media.download_url')
export class MediaDownloadUrlHandler implements OperationHandler {
  constructor(
    private readonly authorizer: Authorizer,
    private readonly urls: MediaUrls,
  ) {}

  async handle(ctx: OperationContext<{ variant: 'original' | 'display' | 'thumbnail' }>): Promise<OperationResult> {
    const v = await ctx.tx((scope) => asset(ctx, this.authorizer, scope, ctx.params.media_id!, { allowPublic: true }), { readOnly: true });
    const a = v.row;
    const variant = ctx.body.variant;
    // original: owner only (40); others: owner, or anyone for publicly servable media (52 §15).
    if (variant === 'original' && !v.owned) throw new ApiError('NOT_FOUND');
    if (!(v.owned ? servableToOwner(a) : a.publicly_servable)) throw new ApiError('MEDIA_NOT_READY');
    const key = variant === 'original' ? a.storage_reference : variant === 'display' ? displayKeyOf(a) : a.thumbnail_reference;
    if (!key) throw new ApiError('MEDIA_NOT_READY', { detail: `no ${variant} variant` });
    const signed = await this.urls.sign(key, a);
    return { body: { url: signed.url, expires_at: signed.expiresAt.toISOString() } };
  }
}

type AttachmentWrite = {
  media_asset_id: string;
  attached_to: { type: AttachedToType; id: string };
  role: AttachmentRole;
  pair_group_key?: string;
  display_order: number;
  caption?: string;
};

/** Roles of which a record shows one at a time: attaching a new one replaces the old. */
const SINGLE_ROLES: AttachmentRole[] = ['logo', 'avatar', 'cover'];
const PAIRED: AttachmentRole[] = ['before', 'after'];

@Injectable()
@Operation('media.attach')
export class MediaAttachHandler implements OperationHandler {
  constructor(
    private readonly authorizer: Authorizer,
    private readonly targets: AttachmentTargets,
    private readonly urls: MediaUrls,
  ) {}

  async handle(ctx: OperationContext<AttachmentWrite>): Promise<OperationResult> {
    const b = ctx.body;
    if (PAIRED.includes(b.role) && !b.pair_group_key)
      throw ApiError.validation([{ pointer: '/pair_group_key', code: 'conditional_required' }]);
    const view = await ctx.tx(async (scope) => {
      let v: VisibleAsset;
      try {
        v = await asset(ctx, this.authorizer, scope, b.media_asset_id, { lock: true });
      } catch (err) {
        if (err instanceof ApiError && err.code === 'NOT_FOUND')
          throw ApiError.validation([{ pointer: '/media_asset_id', code: 'reference_not_found' }], 'REFERENCE_NOT_FOUND');
        throw err;
      }
      const a = v.row;
      if (!servableToOwner(a)) throw new ApiError('MEDIA_NOT_READY');
      // SEC-AZ-4: the owning module says who owns the record; it must be the asset's owner, and the caller must hold an allowed role.
      const resolve = this.targets.get(b.attached_to.type);
      const target = resolve ? await resolve(scope, b.attached_to.id) : null;
      if (!target || target.owner.type !== a.owner_type || target.owner.id !== a.owner_id)
        throw ApiError.validation([{ pointer: '/attached_to', code: 'reference_not_found' }], 'REFERENCE_NOT_FOUND');
      if (target.owner.type === 'organization') await ctx.authorizeOrg(target.owner.id, target.groups);
      if (SINGLE_ROLES.includes(b.role))
        await scope.db
          .updateTable('media.media_attachments')
          .set({ status: 'removed' })
          .where('attached_to_type', '=', b.attached_to.type)
          .where('attached_to_id', '=', b.attached_to.id)
          .where('role', '=', b.role)
          .where('status', '=', 'active')
          .execute();
      const t = await scope.db
        .insertInto('media.media_attachments')
        .values({
          media_asset_id: a.id,
          attached_to_type: b.attached_to.type,
          attached_to_id: b.attached_to.id,
          role: b.role,
          pair_group_key: b.pair_group_key ?? null,
          display_order: b.display_order,
          caption: b.caption ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toAttachmentView(t, a, await this.urls.forViewer(a, true));
    });
    return created(view, `/v1/media/attachments/${view.attachment_id}`);
  }
}

/** An active attachment of an asset the caller owns (policy owner_all), in that owner's context. */
async function ownedAttachment(ctx: OperationContext, authorizer: Authorizer, scope: TxScope, attachmentId: string) {
  const userId = caller(ctx);
  const find = () =>
    scope.db
      .selectFrom('media.media_attachments')
      .selectAll()
      .where('id', '=', attachmentId)
      .where('status', '=', 'active')
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
  let t = await find();
  let v = t ? await findVisibleAsset(scope, authorizer, userId, t.media_asset_id, true) : null;
  if (!t) {
    for (const m of await authorizer.memberships(userId)) {
      await scope.setOrganization(m.orgId, m.role);
      t = await find();
      if (t) {
        v = await findVisibleAsset(scope, authorizer, userId, t.media_asset_id, true);
        break;
      }
    }
  }
  if (!t || !v?.owned) throw new ApiError('NOT_FOUND');
  if (v.orgId) await ctx.authorizeOrg(v.orgId, ['ANY']);
  return { t, a: v.row };
}

@Injectable()
@Operation('media.attachment_update')
export class MediaAttachmentUpdateHandler implements OperationHandler {
  constructor(
    private readonly authorizer: Authorizer,
    private readonly urls: MediaUrls,
  ) {}

  async handle(
    ctx: OperationContext<{ role?: AttachmentRole; pair_group_key?: string | null; display_order?: number; caption?: string | null }>,
  ): Promise<OperationResult> {
    const b = ctx.body;
    const view = await ctx.tx(async (scope) => {
      const { t, a } = await ownedAttachment(ctx, this.authorizer, scope, ctx.params.attachment_id!);
      const role = b.role ?? t.role;
      const pair = b.pair_group_key !== undefined ? b.pair_group_key : t.pair_group_key;
      if (PAIRED.includes(role as AttachmentRole) && !pair)
        throw ApiError.validation([{ pointer: '/pair_group_key', code: 'conditional_required' }]);
      const row = await scope.db
        .updateTable('media.media_attachments')
        .set({
          ...(b.role !== undefined ? { role: b.role } : {}),
          ...(b.pair_group_key !== undefined ? { pair_group_key: b.pair_group_key } : {}),
          ...(b.display_order !== undefined ? { display_order: b.display_order } : {}),
          ...(b.caption !== undefined ? { caption: b.caption } : {}),
        })
        .where('id', '=', t.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return toAttachmentView(row, a, await this.urls.forViewer(a, servableToOwner(a)));
    });
    return { body: view };
  }
}

@Injectable()
@Operation('media.detach')
export class MediaDetachHandler implements OperationHandler {
  constructor(private readonly authorizer: Authorizer) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    await ctx.tx(async (scope) => {
      const { t } = await ownedAttachment(ctx, this.authorizer, scope, ctx.params.attachment_id!);
      await scope.db.updateTable('media.media_attachments').set({ status: 'removed' }).where('id', '=', t.id).execute();
    });
    return { body: ACK };
  }
}

@Injectable()
@Operation('media.delete')
export class MediaDeleteHandler implements OperationHandler {
  constructor(private readonly authorizer: Authorizer) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    await ctx.tx(async (scope) => {
      const { row: a } = await asset(ctx, this.authorizer, scope, ctx.params.media_id!, { lock: true });
      // The files are purged by the retention rules (S8); the asset stops being servable now.
      await scope.db.updateTable('media.media_assets').set({ status: 'removed' }).where('id', '=', a.id).execute();
      await scope.db
        .updateTable('media.media_attachments')
        .set({ status: 'removed' })
        .where('media_asset_id', '=', a.id)
        .where('status', '=', 'active')
        .execute();
      await writeAudit(scope, { action: 'media.deleted', entityType: 'media_asset', entityId: a.id, previous: a.purpose });
    });
    return { body: ACK };
  }
}

type RedactionRegion = { x: string | number; y: string | number; w: string | number; h: string | number };
type RedactionDecision = {
  decision: 'apply_suggestions' | 'apply_regions' | 'not_needed';
  regions?: RedactionRegion[];
};

@Injectable()
@Operation('media.redaction_decide')
export class MediaRedactionDecideHandler implements OperationHandler {
  constructor(
    private readonly authorizer: Authorizer,
    private readonly jobs: JobService,
    private readonly ai: AiReferences,
  ) {}

  async handle(ctx: OperationContext<RedactionDecision>): Promise<OperationResult> {
    const userId = caller(ctx);
    const b = ctx.body;
    const errors: FieldError[] = [];
    if (b.decision === 'apply_regions' && !b.regions?.length) errors.push({ pointer: '/regions', code: 'conditional_required' });
    if (b.decision !== 'apply_regions' && b.regions) errors.push({ pointer: '/regions', code: 'conditional_forbidden' });
    for (const [i, r] of (b.regions ?? []).entries()) {
      const [x, y, w, h] = [r.x, r.y, r.w, r.h].map(Number) as [number, number, number, number];
      if ([x, y, w, h].some((n) => n > 1) || x + w > 1 || y + h > 1 || w === 0 || h === 0)
        errors.push({ pointer: `/regions/${i}`, code: 'out_of_range' });
    }
    if (errors.length) throw ApiError.validation(errors);
    const job = await ctx.tx(async (scope) => {
      const { row: a, orgId } = await asset(ctx, this.authorizer, scope, ctx.params.media_id!, { lock: true });
      if (a.media_type !== 'image' || !servableToOwner(a)) throw new ApiError('MEDIA_NOT_READY');
      // AI suggestions (plates, faces) of an insight the caller may use (ai-mcp, S9); applying them is the human decision.
      let regions = b.regions;
      if (b.decision === 'apply_suggestions') {
        const insight = a.redaction_insight_id
          ? await this.ai.usable(scope, a.redaction_insight_id, { types: ['redaction_suggestion'] })
          : null;
        const suggested = ((insight?.payload?.media as { media_asset_id: string; regions: RedactionRegion[] }[] | undefined) ?? []).find(
          (m) => m.media_asset_id === a.id,
        );
        if (!insight || !suggested?.regions.length) throw ApiError.validation([{ pointer: '/decision', code: 'enum' }]);
        regions = suggested.regions.map(({ x, y, w, h }) => ({ x, y, w, h }));
        await this.ai.approveUse(scope, insight.id);
      }
      await scope.db
        .updateTable('media.media_assets')
        .set({ redaction_status: b.decision === 'not_needed' ? 'not_needed' : 'pending' })
        .where('id', '=', a.id)
        .execute();
      return this.jobs.create(scope, {
        kind: 'redaction',
        ownerUserId: userId,
        organizationId: orgId,
        owningModule: 'media',
        // Relative coordinates only; the worker reads them from the job row.
        inputSummary: { media_asset_id: a.id, decision: b.decision, ...(regions ? { regions } : {}) },
        queue: MEDIA_REDACTION_QUEUE,
      });
    });
    return acceptedJob(job);
  }
}

/** Lost W6 queue entries and abandoned uploads (W15 rules in workers/media-processor). */
export async function pendingScans(scope: TxScope, olderThanMs: number, limit = 100): Promise<string[]> {
  const rows = await scope.db
    .selectFrom('media.media_assets')
    .select('id')
    .where('status', '=', 'active')
    .where('scan_status', '=', 'pending')
    .where('updated_at', '<', sql<Date>`now() - make_interval(secs => ${olderThanMs / 1000})`)
    .orderBy('created_at')
    .limit(limit)
    .execute();
  return rows.map((r) => r.id);
}

export type { AssetRow };
