import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { tinyMp4 } from '#libs/testing/media.js';
import { dispositionOf, encryptedAtRest, mediaTypeOf, PURPOSES, urlLifetimeMs } from './purposes.js';
import { containsMalwareSignature, mp4DurationSeconds, sniffType } from './sniff.js';

describe('type sniffing (SEC-UP-2)', () => {
  it('detects the allowed types from their bytes', async () => {
    const img = sharp({ create: { width: 4, height: 4, channels: 3, background: '#808080' } });
    expect(sniffType(await img.clone().jpeg().toBuffer())).toBe('image/jpeg');
    expect(sniffType(await img.clone().png().toBuffer())).toBe('image/png');
    expect(sniffType(await img.clone().webp().toBuffer())).toBe('image/webp');
    expect(sniffType(tinyMp4(10))).toBe('video/mp4');
    expect(sniffType(tinyMp4(10, 'heic'))).toBe('image/heic');
    expect(sniffType(Buffer.from('%PDF-1.7\n%âãÏÓ\n'))).toBe('application/pdf');
    expect(sniffType(Buffer.from('part_number,name\nA-1,Filter\n'))).toBe('text/csv');
  });

  it('refuses SVG, HTML with control bytes, archives and executables', () => {
    expect(sniffType(Buffer.from('MZ\x90\x00\x03'))).toBeNull();
    expect(sniffType(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]))).toBeNull();
    expect(sniffType(Buffer.from([0xc3, 0x28]))).toBeNull(); // invalid UTF-8
    // An SVG is text: it can only pass as CSV, which no image purpose accepts.
    expect(sniffType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('text/csv');
  });

  it('finds the EICAR test signature and the MP4 duration', () => {
    expect(containsMalwareSignature(Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'))).toBe(true);
    expect(containsMalwareSignature(Buffer.from('harmless'))).toBe(false);
    expect(mp4DurationSeconds(tinyMp4(42))).toBe(42);
    expect(mp4DurationSeconds(Buffer.from('no header'))).toBeNull();
  });
});

describe('upload purposes (40 UploadPurpose)', () => {
  it('fixes types, privacy, encryption, disposition and URL lifetimes', () => {
    expect(PURPOSES.org_logo.types).not.toContain('application/pdf');
    expect(PURPOSES.verification_document.privacy).toBe('private');
    expect(PURPOSES.inventory_import_csv.types).toEqual(['text/csv']);
    expect(mediaTypeOf('application/pdf')).toBe('document');
    expect(encryptedAtRest('application/pdf', 'public')).toBe(true);
    expect(encryptedAtRest('image/jpeg', 'private')).toBe(true);
    expect(encryptedAtRest('image/jpeg', 'public')).toBe(false);
    expect(dispositionOf('text/csv')).toBe('attachment');
    expect(dispositionOf('image/png')).toBe('inline');
    expect(urlLifetimeMs('public')).toBe(3_600_000);
    expect(urlLifetimeMs('private')).toBe(300_000);
  });
});
