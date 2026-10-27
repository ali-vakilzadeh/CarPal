// Upload rules on the client (Docs/40 SEC-UP-2, backend GD-32, BA-05): the same types, sizes, megapixels and video
// length the backend enforces per purpose (backend modules/media/domain/purposes.ts), checked before anything is
// sent so the user learns at once why a file cannot be used. HEIC/HEIF photos are converted to JPEG first
// (image/heic is refused at media.upload_init). Pure functions.
import type { UploadPurpose } from '@carpal/api-contracts';

export type UploadKind = 'image' | 'video' | 'pdf';
export type UploadMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'video/mp4' | 'application/pdf';

const MB = 1024 * 1024;
export const SIZE_LIMIT: Record<UploadKind, number> = { image: 20 * MB, video: 100 * MB, pdf: 20 * MB };
export const MAX_PIXELS = 40_000_000;
export const MAX_VIDEO_SECONDS = 15;

/** What each purpose this PWA uploads for accepts (backend PURPOSES; avatars come with P9, posts with P8). */
export const PURPOSE_KINDS: Partial<Record<UploadPurpose, readonly UploadKind[]>> = {
  avatar: ['image'],
  vehicle_photo: ['image'],
  vehicle_document: ['image', 'pdf'],
  issue_photo: ['image', 'video'],
  service_evidence: ['image', 'pdf'],
  review_photo: ['image'],
  review_evidence: ['image', 'pdf'],
  post: ['image', 'video'],
  qna: ['image'],
  appointment_photo: ['image', 'video'],
};

const BY_MIME: Record<string, UploadMime> = {
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/png': 'image/png',
  'image/webp': 'image/webp',
  'video/mp4': 'video/mp4',
  'application/pdf': 'application/pdf',
};
const BY_EXTENSION: Record<string, UploadMime> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  mp4: 'video/mp4',
  pdf: 'application/pdf',
};

export function kindOf(mime: UploadMime): UploadKind {
  return mime === 'application/pdf' ? 'pdf' : mime === 'video/mp4' ? 'video' : 'image';
}

function extension(name: string): string {
  return name.toLowerCase().split('.').pop() ?? '';
}

/** True for HEIC/HEIF photos (iPhone default), by type or by name when the browser leaves the type empty. */
export function isHeic(file: { name: string; type: string }): boolean {
  return /^image\/hei[cf](-sequence)?$/.test(file.type) || ['heic', 'heif'].includes(extension(file.name));
}

/** The upload type of a file (from its declared type, else its extension), or null when it is not one we send. */
export function mimeOf(file: { name: string; type: string }): UploadMime | null {
  return BY_MIME[file.type.toLowerCase()] ?? (file.type ? null : (BY_EXTENSION[extension(file.name)] ?? null));
}

/** The file picker's accept list for a purpose (HEIC included: it is converted). */
export function acceptFor(purpose: UploadPurpose): string {
  const kinds = PURPOSE_KINDS[purpose] ?? [];
  const out: string[] = [];
  if (kinds.includes('image')) out.push('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', '.heic', '.heif');
  if (kinds.includes('video')) out.push('video/mp4');
  if (kinds.includes('pdf')) out.push('application/pdf');
  return out.join(',');
}

export type CheckProblem = 'type' | 'size' | 'pixels' | 'duration';

/** The first rule a file breaks for a purpose, or null. `pixels` and `seconds` come from the browser's decoder. */
export function checkFile(
  purpose: UploadPurpose,
  f: { mime: UploadMime | null; size: number; pixels?: number | null; seconds?: number | null },
): CheckProblem | null {
  if (!f.mime || !(PURPOSE_KINDS[purpose] ?? []).includes(kindOf(f.mime))) return 'type';
  const kind = kindOf(f.mime);
  if (f.size <= 0 || f.size > SIZE_LIMIT[kind]) return 'size';
  if (kind === 'image' && f.pixels != null && f.pixels > MAX_PIXELS) return 'pixels';
  if (kind === 'video' && f.seconds != null && f.seconds > MAX_VIDEO_SECONDS) return 'duration';
  return null;
}
