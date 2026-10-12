// MediaService (interface/media.ts) for other modules, signed delivery URLs
// (SEC-UP-4) and DSR export delivery (identity DataExportFiles). Signed URLs
// are issued only after the caller's context was authorized: assets the
// caller owns, or publicly servable ones (52 §15 public rules).
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { ApiError } from '#libs/contract/index.js';
import type { AttachedToType } from '#libs/contract/generated/enums.js';
import type { Infra } from '#libs/infra/index.js';
import { InjectInfra } from '#libs/runtime/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { DataExportFiles } from '#modules/identity/interface/identity.js';
import { toAttachmentView } from '../api/projections.js';
import { dispositionOf, urlLifetimeMs } from '../domain/purposes.js';
import { displayKeyOf, servableToOwner, type AssetRow } from '../infrastructure/assets.js';
import { MediaService, type AttachedAsset, type MediaAttachmentView, type RequireReadyOptions } from '../interface/media.js';

/** Signs delivery URLs of processed variants. */
@Injectable()
export class MediaUrls {
  constructor(@InjectInfra() private readonly infra: Infra) {}

  async sign(key: string, a: Pick<AssetRow, 'privacy_level' | 'mime_type'>): Promise<{ url: string; expiresAt: Date }> {
    const ttl = urlLifetimeMs(a.privacy_level);
    const url = await this.infra.storage.presignGet(key, { expiresInMs: ttl, disposition: dispositionOf(a.mime_type) });
    // The URL carries whole seconds; report the same instant.
    return { url, expiresAt: new Date(Math.floor((Date.now() + ttl) / 1000) * 1000) };
  }

  /** Display and thumbnail URLs of an asset that may be served to this viewer, else nulls. */
  async forViewer(a: AssetRow, servable: boolean): Promise<{ url: string | null; thumbnail: string | null }> {
    if (!servable) return { url: null, thumbnail: null };
    const display = displayKeyOf(a);
    return {
      url: display ? (await this.sign(display, a)).url : null,
      thumbnail: a.thumbnail_reference ? (await this.sign(a.thumbnail_reference, a)).url : null,
    };
  }
}

@Injectable()
export class DbMediaService extends MediaService {
  constructor(private readonly urls: MediaUrls) {
    super();
  }

  async requireReady(scope: TxScope, assetIds: readonly string[], o: RequireReadyOptions): Promise<void> {
    if (assetIds.length === 0) return;
    const rows = await scope.db
      .selectFrom('media.media_assets')
      .selectAll()
      .where('id', 'in', [...assetIds])
      .where('deleted_at', 'is', null)
      .execute();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const list = assetIds.length > 1 || o.pointer.endsWith('_ids');
    let notReady = false;
    for (const [i, id] of assetIds.entries()) {
      const a = byId.get(id);
      const pointer = list ? `${o.pointer}/${i}` : o.pointer;
      if (
        !a ||
        a.owner_type !== o.owner.type ||
        a.owner_id !== o.owner.id ||
        !(o.purposes as string[]).includes(a.purpose) ||
        a.status === 'removed' ||
        a.status === 'pending_upload'
      )
        throw ApiError.validation([{ pointer, code: 'reference_not_found' }], 'REFERENCE_NOT_FOUND');
      if (!servableToOwner(a)) notReady = true;
    }
    if (notReady) throw new ApiError('MEDIA_NOT_READY');
  }

  async #attachments(scope: TxScope, type: AttachedToType, ids: readonly string[]) {
    if (ids.length === 0) return [];
    return scope.db
      .selectFrom('media.media_attachments as t')
      .innerJoin('media.media_assets as a', 'a.id', 't.media_asset_id')
      .selectAll('t')
      .select([
        'a.media_type as a_media_type',
        'a.width as a_width',
        'a.height as a_height',
        'a.status as a_status',
        'a.scan_status as a_scan_status',
        'a.moderation_status as a_moderation_status',
        'a.privacy_level as a_privacy_level',
        'a.mime_type as a_mime_type',
        'a.storage_reference as a_storage_reference',
        'a.thumbnail_reference as a_thumbnail_reference',
      ])
      .where('t.attached_to_type', '=', type)
      .where('t.attached_to_id', 'in', [...ids])
      .where('t.status', '=', 'active')
      .where('t.deleted_at', 'is', null)
      .where('a.status', '<>', 'removed')
      .orderBy('t.display_order')
      .orderBy('t.id')
      .execute();
  }

  async attachmentViews(scope: TxScope, type: AttachedToType, ids: readonly string[]): Promise<Map<string, MediaAttachmentView[]>> {
    const out = new Map<string, MediaAttachmentView[]>();
    for (const r of await this.#attachments(scope, type, ids)) {
      const asset = {
        id: r.media_asset_id,
        media_type: r.a_media_type,
        width: r.a_width,
        height: r.a_height,
        status: r.a_status,
        scan_status: r.a_scan_status,
        privacy_level: r.a_privacy_level,
        mime_type: r.a_mime_type,
        storage_reference: r.a_storage_reference,
        thumbnail_reference: r.a_thumbnail_reference,
      } as AssetRow;
      const view = toAttachmentView(r, asset, await this.urls.forViewer(asset, servableToOwner(asset)));
      out.set(r.attached_to_id, [...(out.get(r.attached_to_id) ?? []), view]);
    }
    return out;
  }

  async attachedAssets(scope: TxScope, type: AttachedToType, id: string): Promise<AttachedAsset[]> {
    return (await this.#attachments(scope, type, [id])).map((r) => ({
      attachmentId: r.id,
      assetId: r.media_asset_id,
      role: r.role as AttachedAsset['role'],
      ready: r.a_status === 'active' && r.a_scan_status === 'clean',
      moderationStatus: r.a_moderation_status as AttachedAsset['moderationStatus'],
    }));
  }

  async logoUrls(scope: TxScope, orgIds: readonly string[]): Promise<Map<string, string>> {
    const ids = [...new Set(orgIds)].slice(0, 500);
    if (ids.length === 0) return new Map();
    const rows = await scope.db
      .selectFrom('media.media_attachments as t')
      .innerJoin('media.media_assets as a', 'a.id', 't.media_asset_id')
      .select(['t.attached_to_id', 'a.id', 'a.media_type', 'a.storage_reference', 'a.privacy_level', 'a.mime_type'])
      .where('t.attached_to_type', '=', 'organization')
      .where('t.attached_to_id', 'in', ids)
      .where('t.role', '=', 'logo')
      .where('t.status', '=', 'active')
      .where('a.publicly_servable', '=', true)
      .orderBy('t.id', 'desc')
      .execute();
    const out = new Map<string, string>();
    for (const r of rows) {
      if (out.has(r.attached_to_id)) continue;
      const key = displayKeyOf(r);
      if (key) out.set(r.attached_to_id, (await this.urls.sign(key, r)).url);
    }
    return out;
  }
}

/**
 * DSR export bundles (identity dsr.export_download): 5-minute attachment URLs
 * of clean export assets, through media.delivery_info (definer; identity has
 * already checked that the request is the caller's).
 */
@Injectable()
export class MediaExportFiles extends DataExportFiles {
  constructor(@InjectInfra() private readonly infra: Infra) {
    super();
  }

  async #info(scope: TxScope, assetId: string) {
    const { rows } = await sql<{ storage_reference: string | null }>`
      SELECT storage_reference FROM media.delivery_info(${assetId}::uuid)`.execute(scope.db);
    return rows[0]?.storage_reference ?? null;
  }

  async signedUrl(scope: TxScope, mediaAssetId: string): Promise<{ url: string; expiresAt: Date } | null> {
    const key = await this.#info(scope, mediaAssetId);
    if (!key) return null;
    const ttl = 300_000;
    const url = await this.infra.storage.presignGet(key, { expiresInMs: ttl, disposition: 'attachment' });
    return { url, expiresAt: new Date(Math.floor((Date.now() + ttl) / 1000) * 1000) };
  }

  async available(scope: TxScope, mediaAssetId: string): Promise<boolean> {
    return (await this.#info(scope, mediaAssetId)) !== null;
  }
}
