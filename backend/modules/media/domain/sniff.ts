// Type detection from the bytes (SEC-UP-2: the real type is detected; a
// mismatch with the declared type quarantines the file), the lite-mode
// malware check (the EICAR test signature stands in for a scanner) and the
// MP4 duration from the movie header.
import type { MimeType } from './purposes.js';

const startsWith = (b: Buffer, sig: number[], offset = 0): boolean => sig.every((v, i) => b[offset + i] === v);
const ascii = (b: Buffer, offset: number, length: number): string => b.subarray(offset, offset + length).toString('latin1');

/** ISO base media brands (ftyp major/compatible) that are HEIF images vs MP4 video. */
const HEIF_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'mif1', 'msf1']);
const MP4_BRANDS = new Set(['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'M4V ', 'f4v ']);

/** The type the bytes really are, or null when none of the allowed types. */
export function sniffType(b: Buffer): MimeType | null {
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'image/webp';
  if (ascii(b, 4, 4) === 'ftyp') {
    const major = ascii(b, 8, 4);
    if (HEIF_BRANDS.has(major)) return 'image/heic';
    if (MP4_BRANDS.has(major)) return 'video/mp4';
    return null;
  }
  if (ascii(b, 0, 5) === '%PDF-') return 'application/pdf';
  if (looksLikeCsv(b)) return 'text/csv';
  return null;
}

/** Plain UTF-8 text without NUL or other C0 controls (except tab, CR, LF): what a CSV import may be (SEC-IN-11). */
function looksLikeCsv(b: Buffer): boolean {
  if (b.length === 0) return false;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return false;
  }
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text);
}

/** The EICAR anti-virus test string: lite mode's stand-in for a real scanner hit. */
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
export const containsMalwareSignature = (b: Buffer): boolean => b.includes(Buffer.from(EICAR, 'latin1'));

/** Seconds of an MP4 movie (mvhd box), or null when no header is found. */
export function mp4DurationSeconds(b: Buffer): number | null {
  const at = b.indexOf('mvhd', 0, 'latin1');
  if (at < 4) return null;
  const v = at + 4; // version (1 byte) + flags (3 bytes)
  const version = b[v];
  if (version === 1) {
    if (b.length < v + 32) return null;
    const timescale = b.readUInt32BE(v + 20);
    const duration = Number(b.readBigUInt64BE(v + 24));
    return timescale ? duration / timescale : null;
  }
  if (b.length < v + 20) return null;
  const timescale = b.readUInt32BE(v + 12);
  const duration = b.readUInt32BE(v + 16);
  return timescale ? duration / timescale : null;
}
