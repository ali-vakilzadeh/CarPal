// Media on the admin plane and in S8 platform flows (40 admin.media_download_url;
// 52 §15 MediaAsset moderation; DataRetentionPolicy MediaAsset). Staff get a
// 5-minute signed URL to a private file only with a purpose and an audit
// entry; moderators approve or remove public media (publicly_servable needs
// moderation approved); removed and abandoned files are purged by retention;
// a user's own files are part of their DSR export and removed on deletion.
import { Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import { writeAudit } from '#libs/audit/index.js';
import { ApiError } from '#libs/contract/index.js';
import { Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import type { Infra } from '#libs/infra/index.js';
import { InjectInfra } from '#libs/runtime/index.js';
import { JobService } from '#libs/jobs/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import {
  failureCounts,
  ModerationTargets,
  PurposeBindings,
  retentionCutoff,
  RetentionHandlers,
  staffOf,
  SystemHealthSignals,
  type ContentAction,
  type TargetAction,
  type TargetActionInput,
  type TargetActionResult,
} from '#modules/admin/interface/admin.js';
import { PersonalDataRegistry } from '#modules/identity/interface/identity.js';
import { displayKeyOf, keys } from '../infrastructure/assets.js';
import { OrganizationReferences } from '#modules/organization/interface/org-references.js';
import { MEDIA_REDACTION_QUEUE } from './media-ops.js';
import { mediaOrgReferences } from './org-references.js';

const URL_TTL_MS = 300_000;

@Injectable()
@Operation('admin.media_download_url')
export class AdminMediaDownloadUrlHandler implements OperationHandler {
  constructor(@InjectInfra() private readonly infra: Infra) {}

  async handle(ctx: OperationContext<{ variant: 'display' | 'original' }>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const body = await ctx.tx(async (scope) => {
      const a = await scope.db
        .selectFrom('media.media_assets')
        .selectAll()
        .where('id', '=', ctx.params.media_id!)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      // Never serve a file that was not scanned clean (52 MediaAsset), even to staff.
      if (!a || a.status !== 'active' || a.scan_status !== 'clean' || !a.storage_reference) throw new ApiError('NOT_FOUND');
      const key = ctx.body.variant === 'display' ? displayKeyOf(a) : a.storage_reference;
      if (!key) throw new ApiError('NOT_FOUND');
      await writeAudit(scope, {
        action: 'media.staff_download',
        entityType: 'media_asset',
        entityId: a.id,
        next: `${a.purpose} ${ctx.body.variant}${s.bound ? `; subject ${s.bound}` : ''}`,
        accessPurpose: s.purpose,
      });
      const url = await this.infra.storage.presignGet(key, { expiresInMs: URL_TTL_MS, disposition: 'attachment' });
      return { url, expires_at: new Date(Math.floor((Date.now() + URL_TTL_MS) / 1000) * 1000).toISOString() };
    });
    return { body };
  }
}

/** Purposes whose assets are moderated with their record (a portfolio item approves its own media). */
const MODERATED_WITH_RECORD = ['portfolio'];

async function applyToAsset(scope: TxScope, id: string, action: ContentAction): Promise<boolean> {
  const a = await scope.db
    .selectFrom('media.media_assets')
    .selectAll()
    .where('id', '=', id)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  if (!a) return false;
  if (action === 'approve') {
    if (a.status !== 'active' || a.moderation_status === 'approved') return false;
    await scope.db.updateTable('media.media_assets').set({ moderation_status: 'approved' }).where('id', '=', a.id).execute();
    return true;
  }
  if (action === 'hide' || action === 'remove') {
    if (a.status === 'removed') return false;
    await scope.db
      .updateTable('media.media_assets')
      .set({ moderation_status: 'rejected', status: 'removed' })
      .where('id', '=', a.id)
      .execute();
    return true;
  }
  if (action === 'restore') {
    if (a.status !== 'removed' || a.scan_status !== 'clean' || !a.storage_reference) return false;
    await scope.db
      .updateTable('media.media_assets')
      .set({ status: 'active', moderation_status: 'approved' })
      .where('id', '=', a.id)
      .execute();
    return true;
  }
  return false;
}

/**
 * case_action apply_redaction (backend S22, BR-15, Docs/23 A-CON-02): staff draw boxes on an image; the asset leaves
 * public serving at once (redaction_status pending, so publicly_servable is false) and the W6 worker fills the boxes on
 * the display variant and rebuilds the thumbnail (the public copy). A failed redaction keeps it off public serving.
 * The processed original stays under its owner-only and purpose-bound staff access until retention removes it.
 */
async function applyRedaction(
  scope: TxScope,
  jobs: JobService,
  id: string,
  action: TargetAction,
  input: TargetActionInput,
): Promise<TargetActionResult> {
  if (action !== 'apply_redaction') return { ok: false, transition: `${action} does not apply to a file` };
  const regions = input.params.redaction_regions;
  if (!regions?.length) return { ok: false, invalid: { pointer: '/params/redaction_regions', code: 'conditional_required' } };
  for (const [i, r] of regions.entries()) {
    const [x, y, w, h] = [r.x, r.y, r.w, r.h].map(Number) as [number, number, number, number];
    if ([x, y, w, h].some((n) => !Number.isFinite(n) || n < 0 || n > 1) || x + w > 1 || y + h > 1 || w === 0 || h === 0)
      return { ok: false, invalid: { pointer: `/params/redaction_regions/${i}`, code: 'out_of_range' } };
  }
  const a = await scope.db
    .selectFrom('media.media_assets')
    .selectAll()
    .where('id', '=', id)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  if (!a) return { ok: false, transition: 'file gone' };
  if (a.media_type !== 'image' || a.status !== 'active' || a.scan_status !== 'clean' || !a.storage_reference)
    return { ok: false, transition: 'only a processed image can be redacted' };
  if (a.redaction_status === 'pending') return { ok: false, transition: 'a redaction is already running' };
  await scope.db.updateTable('media.media_assets').set({ redaction_status: 'pending' }).where('id', '=', a.id).execute();
  const job = await jobs.create(scope, {
    kind: 'redaction',
    ownerUserId: input.staffUserId,
    organizationId: a.owner_type === 'organization' ? a.owner_id : null,
    owningModule: 'media',
    // Relative coordinates only; the worker fills them as opaque boxes.
    inputSummary: {
      media_asset_id: a.id,
      decision: 'apply_regions',
      style: 'box',
      source: 'moderation',
      case_id: input.caseId,
      regions: regions.map(({ x, y, w, h }) => ({ x: String(x), y: String(y), w: String(w), h: String(h) })),
    },
    queue: MEDIA_REDACTION_QUEUE,
  });
  return { ok: true, params: { job_id: job.id, regions: regions.length, previous_redaction_status: a.redaction_status } };
}

/** The files a MediaAsset retention policy applies to: removed files by their last change, abandoned uploads by their expiry. */
function mediaRetentionScope(p: { appliesToStatus: string | null }): { status: string; column: 'upload_expires_at' | 'updated_at' } {
  const status = p.appliesToStatus ?? 'removed';
  return { status, column: status === 'pending_upload' ? 'upload_expires_at' : 'updated_at' };
}

@Injectable()
export class MediaAdminRegistrations implements OnModuleInit {
  constructor(
    @InjectInfra() private readonly infra: Infra,
    private readonly jobs: JobService,
    @Optional() private readonly targets?: ModerationTargets,
    @Optional() private readonly retention?: RetentionHandlers,
    @Optional() private readonly personal?: PersonalDataRegistry,
    @Optional() private readonly bindings?: PurposeBindings,
    @Optional() private readonly health?: SystemHealthSignals,
    @Optional() private readonly orgRefs?: OrganizationReferences,
  ) {}

  onModuleInit(): void {
    // Backend S22 (BR-08): what an organization merge does to this module's references.
    this.orgRefs?.register('media', mediaOrgReferences());
    // Backend S21 (BR-17): files the virus scan could not check (scan_status failed; infected files are found, not failures).
    this.health?.register('media_scan_failures', (scope, now) =>
      failureCounts(scope, sql`FROM media.media_assets WHERE scan_status = 'failed'`, sql`updated_at`, now),
    );
    // S14 (BR-09): a file is about itself, the records it is attached to, and the organization that owns it
    // (verification documents). A user's own files are reached only through a record they are attached to, and a
    // system_export file (a DSR bundle, a fleet export) never through its owner.
    this.bindings?.register('admin.media_download_url', async (scope, params) => {
      const id = params.media_id;
      if (!id) return [];
      const a = await scope.db
        .selectFrom('media.media_assets')
        .select(['owner_type', 'owner_id', 'purpose'])
        .where('id', '=', id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!a) return [];
      const attached = await scope.db
        .selectFrom('media.media_attachments')
        .select(['attached_to_type', 'attached_to_id'])
        .where('media_asset_id', '=', id)
        .where('deleted_at', 'is', null)
        .limit(50)
        .execute();
      return [
        { type: 'media_asset', id },
        ...attached.map((x) => ({ type: x.attached_to_type, id: x.attached_to_id })),
        ...(a.owner_type === 'organization' && a.purpose !== 'system_export' ? [{ type: 'organization', id: a.owner_id }] : []),
      ];
    });
    this.targets?.register('media_asset', {
      exists: async (scope, id) =>
        !!(await scope.db
          .selectFrom('media.media_assets')
          .select('id')
          .where('id', '=', id)
          .where('deleted_at', 'is', null)
          .executeTakeFirst()),
      snapshot: async (scope, id) => {
        const a = await scope.db.selectFrom('media.media_assets').selectAll().where('id', '=', id).executeTakeFirst();
        return a
          ? {
              type: 'media_asset',
              id: a.id,
              available: true,
              purpose: a.purpose,
              media_type: a.media_type,
              privacy_level: a.privacy_level,
              status: a.status,
              scan_status: a.scan_status,
              moderation_status: a.moderation_status,
              redaction_status: a.redaction_status,
              owner_type: a.owner_type,
              owner_id: a.owner_id,
              created_at: a.created_at.toISOString(),
            }
          : null;
      },
      // S18 (BR-27): files have no excerpt in a list read without a purpose.
      summaries: async (scope, ids) => {
        const rows = ids.length
          ? await scope.db
              .selectFrom('media.media_assets')
              .select('id')
              .where('id', 'in', [...ids])
              .where('deleted_at', 'is', null)
              .execute()
          : [];
        return new Map(rows.map((r) => [r.id, { excerpt: null, rating: null }]));
      },
      // S18 (BR-33): the uploader, the organization owning the file, and the uploader's files live and taken down.
      authorOf: async (scope, id) => {
        const a = await scope.db
          .selectFrom('media.media_assets')
          .select(['uploaded_by', 'owner_type', 'owner_id'])
          .where('id', '=', id)
          .executeTakeFirst();
        if (!a?.uploaded_by) return null;
        const h = await scope.db
          .selectFrom('media.media_assets')
          .select([
            sql<string>`count(*) FILTER (WHERE status = 'active' AND moderation_status <> 'rejected')`.as('published'),
            sql<string>`count(*) FILTER (WHERE status <> 'active' OR moderation_status = 'rejected')`.as('removed'),
          ])
          .where('uploaded_by', '=', a.uploaded_by)
          .where('deleted_at', 'is', null)
          .executeTakeFirstOrThrow();
        return {
          userId: a.uploaded_by,
          organizationId: a.owner_type === 'organization' ? a.owner_id : null,
          published: Number(h.published),
          removed: Number(h.removed),
        };
      },
      subjectOrganization: async (scope, id) => {
        const a = await scope.db
          .selectFrom('media.media_assets')
          .select(['owner_type', 'owner_id'])
          .where('id', '=', id)
          .executeTakeFirst();
        return a?.owner_type === 'organization' ? a.owner_id : null;
      },
      author: async (scope, id) =>
        (await scope.db.selectFrom('media.media_assets').select('uploaded_by').where('id', '=', id).executeTakeFirst())?.uploaded_by ??
        null,
      apply: applyToAsset,
      act: (scope, id, action, input) => applyRedaction(scope, this.jobs, id, action, input),
      // Public media waiting for a moderator (logos, covers, inventory, post and Q&A images).
      pending: async (scope, limit) =>
        (
          await scope.db
            .selectFrom('media.media_assets')
            .select('id')
            .where('privacy_level', '=', 'public')
            .where('status', '=', 'active')
            .where('scan_status', '=', 'clean')
            .where('moderation_status', '=', 'pending')
            .where('purpose', 'not in', MODERATED_WITH_RECORD)
            .where('created_at', '<', new Date(Date.now() - 60_000))
            .where('deleted_at', 'is', null)
            .orderBy('id')
            .limit(limit)
            .execute()
        ).map((r) => r.id),
    });

    // MediaAsset removed / pending_upload (52 DataRetentionPolicy): stored objects are deleted, the row keeps no reference.
    this.retention?.register(
      'MediaAsset',
      async (scope, p) => {
        const { status, column } = mediaRetentionScope(p);
        const cutoff = retentionCutoff(p);
        const rows = await scope.db
          .selectFrom('media.media_assets')
          .select(['id', 'storage_reference', 'thumbnail_reference'])
          .where('status', '=', status)
          .where(column, '<', cutoff)
          .where('deleted_at', 'is', null)
          .limit(1000)
          .execute();
        for (const r of rows) {
          for (const key of new Set([
            keys.upload(r.id),
            keys.original(r.id),
            keys.display(r.id),
            keys.thumbnail(r.id),
            r.storage_reference,
            r.thumbnail_reference,
          ]))
            if (key) await this.infra.storage.delete(key).catch(() => undefined);
        }
        if (rows.length === 0) return 0;
        await scope.db
          .updateTable('media.media_assets')
          .set({ deleted_at: sql<Date>`now()`, deletion_reason: 'retention' })
          .where(
            'id',
            'in',
            rows.map((r) => r.id),
          )
          .execute();
        return rows.length;
      },
      async (scope, p) => {
        // Backend S21 (BR-25): every due file; the daily run handles at most 1,000 of them per day.
        const { status, column } = mediaRetentionScope(p);
        const r = await scope.db
          .selectFrom('media.media_assets')
          .select(sql<string>`count(*)`.as('n'))
          .where('status', '=', status)
          .where(column, '<', retentionCutoff(p))
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        const n = Number(r?.n ?? 0);
        return { affected: n, byStatus: [{ status, count: n }] };
      },
    );

    this.personal?.register('media', {
      async export(scope, userId) {
        const rows = await scope.db
          .selectFrom('media.media_assets')
          .select(['id', 'purpose', 'media_type', 'mime_type', 'status', 'created_at'])
          .where('owner_type', '=', 'user')
          .where('owner_id', '=', userId)
          .where('deleted_at', 'is', null)
          .execute();
        return [
          {
            section: 'media',
            records: rows.map((r) => ({
              id: r.id,
              fields: {
                purpose: r.purpose,
                media_type: r.media_type,
                mime_type: r.mime_type,
                status: r.status,
                created_at: r.created_at.toISOString(),
              },
            })),
          },
        ];
      },
      // The user's own files leave service at once; retention purges the stored objects.
      async erase(scope, userId) {
        const r = await scope.db
          .updateTable('media.media_assets')
          .set({ status: 'removed' })
          .where('owner_type', '=', 'user')
          .where('owner_id', '=', userId)
          .where('status', 'in', ['active', 'quarantined', 'pending_upload'])
          .where('purpose', '<>', 'system_export')
          .executeTakeFirst();
        return Number(r.numUpdatedRows);
      },
    });
  }
}
