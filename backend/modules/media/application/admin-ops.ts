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
import type { TxScope } from '#libs/tenancy/index.js';
import { ModerationTargets, retentionCutoff, RetentionHandlers, staffOf, type ContentAction } from '#modules/admin/interface/admin.js';
import { PersonalDataRegistry } from '#modules/identity/interface/identity.js';
import { displayKeyOf, keys } from '../infrastructure/assets.js';

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
        next: `${a.purpose} ${ctx.body.variant}`,
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

@Injectable()
export class MediaAdminRegistrations implements OnModuleInit {
  constructor(
    @InjectInfra() private readonly infra: Infra,
    @Optional() private readonly targets?: ModerationTargets,
    @Optional() private readonly retention?: RetentionHandlers,
    @Optional() private readonly personal?: PersonalDataRegistry,
  ) {}

  onModuleInit(): void {
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
              purpose: a.purpose,
              media_type: a.media_type,
              privacy_level: a.privacy_level,
              status: a.status,
              scan_status: a.scan_status,
              moderation_status: a.moderation_status,
              owner_type: a.owner_type,
              owner_id: a.owner_id,
            }
          : null;
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
    this.retention?.register('MediaAsset', async (scope, p) => {
      const status = p.appliesToStatus ?? 'removed';
      const cutoff = retentionCutoff(p);
      const rows = await scope.db
        .selectFrom('media.media_assets')
        .select(['id', 'storage_reference', 'thumbnail_reference'])
        .where('status', '=', status)
        .where(status === 'pending_upload' ? 'upload_expires_at' : 'updated_at', '<', cutoff)
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
    });

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
