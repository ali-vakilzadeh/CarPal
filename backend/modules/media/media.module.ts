// media module (41 §2.1 M12; 40 §17). Two Nest modules share this folder:
//   MediaModule     (global, every deployable) MediaService and the
//                   AttachmentTargets registry for other modules, DSR export
//                   delivery (identity DataExportFiles), the media_asset
//                   consent scope and the W6 processing logic.
//   MediaApiModule  §17 operations on the api host (media-api.module.ts)
// The W6 worker host (workers/media-processor) runs MediaProcessor.
import { Global, Injectable, Module, Optional, type OnModuleInit } from '@nestjs/common';
import { AiContextSources } from '#modules/ai-mcp/interface/ai.js';
import { ConsentScopes, DataExportFiles } from '#modules/identity/interface/identity.js';
import { AdminMediaDownloadUrlHandler, MediaAdminRegistrations } from './application/admin-ops.js';
import { VehicleTransferMediaConsumer } from './application/transfer-consumer.js';
import { DbMediaService, MediaExportFiles, MediaUrls } from './application/media-service.js';
import { MediaProcessor } from './application/processor.js';
import { AttachmentTargets, MediaService } from './interface/media.js';

export { MediaProcessor } from './application/processor.js';
export { MEDIA_PROCESS_QUEUE, MEDIA_REDACTION_QUEUE, pendingScans } from './application/media-ops.js';

/**
 * Registrations of the media module: a user may attach their own media to
 * themself (avatar), and a consent scoped to a media asset can only be
 * granted by the user who owns it (SEC-AZ-4).
 */
@Injectable()
export class MediaRegistrations implements OnModuleInit {
  constructor(
    private readonly targets: AttachmentTargets,
    @Optional() private readonly scopes?: ConsentScopes,
    @Optional() private readonly ai?: AiContextSources,
  ) {}

  onModuleInit(): void {
    this.targets.register('user', async (_scope, id) => ({ owner: { type: 'user', id }, groups: [] }));
    // AI redaction suggestions (S9, ai.showcase_compose): the organization's own active images only; a human applies or
    // rejects them with media.redaction_decide (SEC-AI-3).
    this.ai?.registerSink('media.redaction_suggestions', async (scope, who, insightId, payload) => {
      const media = (payload.media as { media_asset_id: string; regions: unknown[] }[] | undefined) ?? [];
      const ids = media.filter((m) => m.regions.length > 0).map((m) => m.media_asset_id);
      if (!who.orgId || ids.length === 0) return 0;
      const r = await scope.db
        .updateTable('media.media_assets')
        .set({ redaction_status: 'suggested', redaction_insight_id: insightId })
        .where('id', 'in', ids)
        .where('owner_type', '=', 'organization')
        .where('owner_id', '=', who.orgId)
        .where('media_type', '=', 'image')
        .where('status', '=', 'active')
        .where('redaction_status', 'in', ['not_needed', 'suggested'])
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      return Number(r.numUpdatedRows);
    });
    this.scopes?.register('media_asset', async (scope, userId, id) => {
      const a = await scope.db
        .selectFrom('media.media_assets')
        .select('id')
        .where('id', '=', id)
        .where('owner_type', '=', 'user')
        .where('owner_id', '=', userId)
        .where('status', 'in', ['active', 'quarantined'])
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      return !!a;
    });
  }
}

@Global()
@Module({
  providers: [
    // One registry per application context (contexts share a process in pnpm dev and tests).
    { provide: AttachmentTargets, useFactory: () => new AttachmentTargets() },
    MediaUrls,
    { provide: MediaService, useClass: DbMediaService },
    { provide: DataExportFiles, useClass: MediaExportFiles },
    MediaProcessor,
    MediaRegistrations,
    MediaAdminRegistrations,
    VehicleTransferMediaConsumer,
    // admin-api host only (other hosts skip it: the route is not theirs).
    AdminMediaDownloadUrlHandler,
  ],
  exports: [AttachmentTargets, MediaService, DataExportFiles, MediaUrls, MediaProcessor],
})
export class MediaModule {}
