// The browser parts of the upload engine (engine.ts UploadDeps): decoding for the megapixel and video-length
// checks, HEIC → JPEG conversion, SHA-256, and the signed PUT with progress.
//
// HEIC (BA-05, OQ-08 of the backend): the photo is decoded by the browser itself (Safari decodes HEIC natively;
// Chromium and Firefox do not) and re-encoded as JPEG through a canvas. No HEVC decoder is bundled: shipping one
// (libheif + libde265 as WASM) carries the HEVC patent question the backend declined too, so where the browser
// cannot decode the photo the user is asked for a JPEG (P7 deviation; OQ-19).
//
// SHA-256 uses SubtleCrypto.digest, which runs off the JavaScript thread in the browsers we support; a dedicated
// Worker is not used because Turbopack emits workers of our own sources as raw .ts files in production (P6 note).
import type { UploadTicket } from '@carpal/api-contracts';
import type { UploadKind } from './policy';
import type { Inspection } from './engine';

const JPEG_QUALITY = 0.9;

async function decodeImage(file: Blob): Promise<ImageBitmap> {
  if (typeof createImageBitmap !== 'function') throw new Error('no image decoder');
  return createImageBitmap(file);
}

export async function inspectFile(file: File, kind: UploadKind): Promise<Inspection> {
  if (kind === 'image') {
    try {
      const bmp = await decodeImage(file);
      const pixels = bmp.width * bmp.height;
      bmp.close();
      return { pixels };
    } catch {
      return { unreadable: true };
    }
  }
  if (kind === 'video') return { seconds: await videoSeconds(file) };
  return {};
}

function videoSeconds(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    const done = (value: number | null) => {
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      resolve(value);
    };
    video.preload = 'metadata';
    video.muted = true;
    video.onloadedmetadata = () => done(Number.isFinite(video.duration) ? video.duration : null);
    // A video the browser cannot read is still checked by the server (≤ 15 s, SEC-UP-2).
    video.onerror = () => done(null);
    video.src = url;
  });
}

export async function convertHeicToJpeg(file: File): Promise<File> {
  const bmp = await decodeImage(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no canvas');
    ctx.drawImage(bmp, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
    if (!blob) throw new Error('encode failed');
    const name = file.name.replace(/\.(heic|heif)$/i, '') + '.jpg';
    return new File([blob], name, { type: 'image/jpeg', lastModified: file.lastModified });
  } finally {
    bmp.close();
  }
}

export async function sha256Base64(file: Blob): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
  let s = '';
  for (const b of digest) s += String.fromCharCode(b);
  return btoa(s);
}

/**
 * PUT <UploadTicket.url> with the ticket's headers (fetch has no upload progress, so XMLHttpRequest). The browser
 * sets Content-Length itself from the body. No credentials: the storage host is another site without cookies.
 */
export function putSigned(ticket: UploadTicket, file: Blob, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(ticket.method, ticket.url);
    xhr.withCredentials = false;
    xhr.setRequestHeader('Content-Type', ticket.headers['Content-Type']);
    xhr.setRequestHeader('x-amz-checksum-sha256', ticket.headers['x-amz-checksum-sha256']);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => resolve(xhr.status);
    xhr.onerror = () => reject(new Error('network'));
    xhr.onabort = () => reject(signal?.reason ?? new Error('aborted'));
    signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(file);
  });
}

/**
 * A private file's bytes as a blob URL (in-place PDF preview, W-GAR-02): documents are served with
 * Content-Disposition: attachment (SEC-UP-4), so they are fetched (the storage host allows the PWA's origin, DI-08)
 * and shown from a blob typed by its declared type. The caller revokes the URL.
 */
export async function blobUrlOf(signedUrl: string, type: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(signedUrl, { credentials: 'omit', ...(signal ? { signal } : {}) });
  if (!res.ok) throw new Error(`download ${res.status}`);
  const blob = new Blob([await res.arrayBuffer()], { type });
  return URL.createObjectURL(blob);
}
