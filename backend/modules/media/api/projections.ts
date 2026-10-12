// Response projections of the media module (40 §17.1), by allowlist:
// storage keys, checksums, the uploader and encryption flags never leave
// the module (SEC-OUT-1). URLs are signed per request by the caller.
import { meta } from '#libs/http-pipeline/index.js';
import type { MediaAttachmentView } from '../interface/media.js';
import type { AssetRow, AttachmentRow } from '../infrastructure/assets.js';

/** 40 MediaAsset (thumbnail_url signed only when scan_status = clean). */
export function toMediaAsset(a: AssetRow, thumbnailUrl: string | null) {
  return {
    ...meta(a),
    owner_type: a.owner_type,
    owner_id: a.owner_id,
    purpose: a.purpose,
    media_type: a.media_type,
    mime_type: a.mime_type,
    file_size_bytes: Number(a.file_size_bytes),
    width: a.width,
    height: a.height,
    duration_seconds: a.duration_seconds,
    privacy_level: a.privacy_level,
    scan_status: a.scan_status,
    exif_stripped: a.exif_stripped,
    redaction_status: a.redaction_status,
    redaction_insight_id: a.redaction_insight_id,
    consent_status: a.consent_status,
    moderation_status: a.moderation_status,
    status: a.status as 'active' | 'quarantined' | 'removed',
    thumbnail_url: thumbnailUrl,
  };
}

/** 40 MediaAttachmentView. */
export function toAttachmentView(
  t: AttachmentRow,
  a: Pick<AssetRow, 'media_type' | 'width' | 'height'>,
  urls: { url: string | null; thumbnail: string | null },
): MediaAttachmentView {
  return {
    attachment_id: t.id,
    media_asset_id: t.media_asset_id,
    media_type: a.media_type as MediaAttachmentView['media_type'],
    role: t.role as MediaAttachmentView['role'],
    pair_group_key: t.pair_group_key,
    display_order: t.display_order,
    caption: t.caption,
    url: urls.url,
    thumbnail_url: urls.thumbnail,
    width: a.width,
    height: a.height,
  };
}
