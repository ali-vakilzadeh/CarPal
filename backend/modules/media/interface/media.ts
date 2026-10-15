// Public interface of the media module (41 §4.2 interface/): other modules
// check that referenced assets are theirs and scanned clean, read the
// attachment views of their records, and register which records media may
// be attached to (media.attach asks the owning module, SEC-AZ-4). Storage
// keys never leave the module (SEC-OUT-1).
import type { AttachedToType, AttachmentRole, MediaType } from '#libs/contract/generated/enums.js';
import type { TxScope } from '#libs/tenancy/index.js';

/** 40 §17.1 UploadPurpose (plus system_export for server-generated files, 52 MediaAsset.purpose). */
export type UploadPurpose =
  | 'avatar'
  | 'org_logo'
  | 'org_cover'
  | 'vehicle_photo'
  | 'vehicle_document'
  | 'issue_photo'
  | 'service_evidence'
  | 'review_photo'
  | 'review_evidence'
  | 'portfolio'
  | 'post'
  | 'qna'
  | 'inventory_image'
  | 'appointment_photo'
  | 'job_log_photo'
  | 'verification_document'
  | 'certification_document'
  | 'inventory_import_csv'
  | 'fleet_import_csv'
  | 'system_export';

export interface MediaOwner {
  type: 'user' | 'organization';
  id: string;
}

/** 40 §17.1 MediaAttachmentView. */
export interface MediaAttachmentView {
  attachment_id: string;
  media_asset_id: string;
  media_type: MediaType;
  role: AttachmentRole;
  pair_group_key: string | null;
  display_order: number;
  caption: string | null;
  url: string | null;
  thumbnail_url: string | null;
  width: number | null;
  height: number | null;
}

/** Readiness of one attached asset (publish checks of the owning module). */
export interface AttachedAsset {
  attachmentId: string;
  assetId: string;
  role: AttachmentRole;
  /** status active and scan_status clean. */
  ready: boolean;
  moderationStatus: 'pending' | 'approved' | 'rejected';
}

/**
 * Who owns a record that media can be attached to, and which role groups
 * (40 §0.5) of that organization may attach to it. Null when the record does
 * not exist in the caller's context.
 */
export interface AttachmentTarget {
  owner: MediaOwner;
  /** Role groups for organization-owned records (ignored for user-owned ones). */
  groups: string[];
}

export type AttachmentTargetResolver = (scope: TxScope, targetId: string) => Promise<AttachmentTarget | null>;

/**
 * Attachment targets by 52 MediaAttachment.attached_to_type. The owning
 * modules register theirs at startup (organization: organization,
 * portfolio_item, provider_job_log; vehicle, trust, community, inventory,
 * appointment in their stages). An unregistered type cannot be attached to
 * (fail closed, 422 REFERENCE_NOT_FOUND).
 */
export class AttachmentTargets {
  readonly #resolvers = new Map<AttachedToType, AttachmentTargetResolver>();

  register(type: AttachedToType, resolver: AttachmentTargetResolver): void {
    if (this.#resolvers.has(type)) throw new Error(`attachment target ${type} registered twice`);
    this.#resolvers.set(type, resolver);
  }

  get(type: string): AttachmentTargetResolver | undefined {
    return this.#resolvers.get(type as AttachedToType);
  }
}

export interface RequireReadyOptions {
  owner: MediaOwner;
  purposes: readonly UploadPurpose[];
  /** JSON pointer of the referencing field (e.g. "/document_media_asset_id"). */
  pointer: string;
}

/** The active attachments of one role on a record of the calling module, replaced as a set. */
export interface SyncAttachments extends RequireReadyOptions {
  type: AttachedToType;
  id: string;
  role: AttachmentRole;
}

/** A server-generated file (import error reports, exports), stored private and encrypted. */
export interface GeneratedFile {
  owner: MediaOwner;
  uploadedBy: string;
  purpose: 'system_export';
  mime: 'text/csv';
  bytes: Buffer;
}

export abstract class MediaService {
  /**
   * Assets referenced by another module's record (documents, certificates):
   * each must exist, belong to `owner` and have one of `purposes` (else 422
   * REFERENCE_NOT_FOUND at the pointer), and be scanned clean (else 409
   * MEDIA_NOT_READY). Runs in the caller's transaction and RLS context.
   */
  abstract requireReady(scope: TxScope, assetIds: readonly string[], o: RequireReadyOptions): Promise<void>;

  /**
   * Makes `assetIds` (in this order) the active attachments of `role` on the
   * record: each asset is checked like requireReady; attachments no longer
   * listed are removed. For records whose write type carries media ids
   * (40 IssueWrite.media_ids); the calling module has authorized the record.
   */
  abstract syncAttachments(scope: TxScope, assetIds: readonly string[], o: SyncAttachments): Promise<void>;

  /** Number of active attachments of clean, active images per record (inventory data quality, missing_images). */
  abstract imageCounts(scope: TxScope, type: AttachedToType, ids: readonly string[]): Promise<Map<string, number>>;

  /** Signed display URLs of clean, active assets visible in the caller's context (owners), by asset id. */
  abstract assetUrls(scope: TxScope, assetIds: readonly string[]): Promise<Map<string, string>>;

  /** Content of a clean, active asset (decrypted), or null. Worker use (CSV imports), system context. */
  abstract readContent(scope: TxScope, assetId: string): Promise<{ bytes: Buffer; mime: string; purpose: string } | null>;

  /** Stores a server-generated file as a clean, private asset of `owner`; returns its id. */
  abstract storeGenerated(scope: TxScope, f: GeneratedFile): Promise<string>;

  /** A 5-minute attachment URL of a clean, active asset the calling module has authorized, or null. */
  abstract signedDownload(scope: TxScope, assetId: string): Promise<{ url: string; expiresAt: Date } | null>;

  /**
   * Active attachments of records, ordered, for members of the owner: url and
   * thumbnail_url are signed for assets that are active and scanned clean
   * (private 5 min, public 1 h), else null.
   */
  abstract attachmentViews(scope: TxScope, type: AttachedToType, ids: readonly string[]): Promise<Map<string, MediaAttachmentView[]>>;

  /**
   * Active attachments of records whose assets are publicly servable (52 §15:
   * clean, moderation approved, consent where needed), signed for anyone, in
   * any RLS context. Public profiles, showcases, posts and Q&A (S6).
   */
  abstract publicAttachmentViews(scope: TxScope, type: AttachedToType, ids: readonly string[]): Promise<Map<string, MediaAttachmentView[]>>;

  /**
   * Active attachments of records of the calling module that it has
   * authorized another party to see (the provider of an appointment sees the
   * requester's photos, 40 PreVisitReport.media): clean active assets only,
   * private URLs (5 min), read through the media.shared_attachments definer
   * in any RLS context. The caller checks the relationship first.
   */
  abstract sharedAttachmentViews(scope: TxScope, type: AttachedToType, ids: readonly string[]): Promise<Map<string, MediaAttachmentView[]>>;

  /** Readiness of the active attachments of one record. */
  abstract attachedAssets(scope: TxScope, type: AttachedToType, id: string): Promise<AttachedAsset[]>;
  /**
   * Moderation decision for the active attachments of a record moderated as
   * a whole (a portfolio item approved by the moderation queue makes its
   * media publicly servable, 52 §15). Staff or system context.
   */
  abstract moderateAttached(scope: TxScope, type: AttachedToType, id: string, status: 'approved' | 'rejected'): Promise<number>;

  /** Signed URLs of organization logos that may be shown publicly (52 §15 public rules), by organization id. */
  abstract logoUrls(scope: TxScope, orgIds: readonly string[]): Promise<Map<string, string>>;

  /** The first publicly servable image (52 §15) attached to each record, signed for anyone, by record id. */
  abstract publicImageUrls(scope: TxScope, type: AttachedToType, ids: readonly string[]): Promise<Map<string, string>>;
}
