// Upload purposes (40 §17.1 UploadPurpose, SEC-UP-2, SEC-UP-5): each purpose
// fixes the allowed MIME types, the size limit and the default privacy
// level. Documents, CSV files and private media are encrypted at rest.
import type { UploadPurpose } from '../interface/media.js';

export type MimeType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic' | 'video/mp4' | 'application/pdf' | 'text/csv';
export type Privacy = 'public' | 'shared' | 'private' | 'internal';

const MB = 1024 * 1024;
const IMAGES: MimeType[] = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];
const PDF: MimeType[] = ['application/pdf'];
const VIDEO: MimeType[] = ['video/mp4'];
const CSV: MimeType[] = ['text/csv'];

/** SEC-UP-2 size limits per type. */
export const SIZE_LIMIT: Record<MimeType, number> = {
  'image/jpeg': 20 * MB,
  'image/png': 20 * MB,
  'image/webp': 20 * MB,
  'image/heic': 20 * MB,
  'video/mp4': 100 * MB,
  'application/pdf': 20 * MB,
  'text/csv': 20 * MB,
};

/** SEC-UP-2: at most 40 megapixels per image, 60 s per video. */
export const MAX_PIXELS = 40_000_000;
export const MAX_VIDEO_SECONDS = 60;

interface PurposePolicy {
  types: MimeType[];
  privacy: Privacy;
}

/** Uploadable purposes (system_export is server-generated only). */
export const PURPOSES: Record<Exclude<UploadPurpose, 'system_export'>, PurposePolicy> = {
  avatar: { types: IMAGES, privacy: 'public' },
  org_logo: { types: IMAGES, privacy: 'public' },
  org_cover: { types: IMAGES, privacy: 'public' },
  vehicle_photo: { types: IMAGES, privacy: 'private' },
  vehicle_document: { types: [...IMAGES, ...PDF], privacy: 'private' },
  issue_photo: { types: [...IMAGES, ...VIDEO], privacy: 'shared' },
  service_evidence: { types: [...IMAGES, ...PDF], privacy: 'private' },
  review_photo: { types: IMAGES, privacy: 'public' },
  review_evidence: { types: [...IMAGES, ...PDF], privacy: 'private' },
  portfolio: { types: [...IMAGES, ...VIDEO], privacy: 'public' },
  post: { types: [...IMAGES, ...VIDEO], privacy: 'public' },
  qna: { types: IMAGES, privacy: 'public' },
  inventory_image: { types: IMAGES, privacy: 'public' },
  appointment_photo: { types: [...IMAGES, ...VIDEO], privacy: 'shared' },
  job_log_photo: { types: IMAGES, privacy: 'private' },
  verification_document: { types: [...IMAGES, ...PDF], privacy: 'private' },
  certification_document: { types: [...IMAGES, ...PDF], privacy: 'private' },
  inventory_import_csv: { types: CSV, privacy: 'private' },
  fleet_import_csv: { types: CSV, privacy: 'private' },
};

export const mediaTypeOf = (mime: string): 'image' | 'video' | 'document' =>
  mime.startsWith('image/') ? 'image' : mime === 'video/mp4' ? 'video' : 'document';

/** SEC-UP-5: documents and private media are encrypted at rest. */
export const encryptedAtRest = (mime: string, privacy: Privacy): boolean => mediaTypeOf(mime) === 'document' || privacy === 'private';

/** SEC-UP-4: documents and CSV are delivered as attachments, images and video inline. */
export const dispositionOf = (mime: string): 'inline' | 'attachment' => (mediaTypeOf(mime) === 'document' ? 'attachment' : 'inline');

/** SEC-UP-4 signed URL lifetimes: public media 1 h, everything else 5 min. */
export const urlLifetimeMs = (privacy: string): number => (privacy === 'public' ? 3_600_000 : 300_000);
