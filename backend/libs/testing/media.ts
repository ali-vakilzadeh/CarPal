// Test media (L22): small, valid files of each upload type for the media
// pipeline tests, built in memory.
import sharp from 'sharp';

/** A minimal ISO BMFF file: ftyp + moov/mvhd (version 0) with a 1 kHz timescale. */
export function tinyMp4(seconds: number, brand = 'isom'): Buffer {
  const ftyp = Buffer.alloc(16);
  ftyp.writeUInt32BE(16, 0);
  ftyp.write('ftyp', 4, 'latin1');
  ftyp.write(brand, 8, 'latin1');
  const mvhd = Buffer.alloc(8 + 100);
  mvhd.writeUInt32BE(mvhd.length, 0);
  mvhd.write('mvhd', 4, 'latin1');
  mvhd.writeUInt32BE(1000, 8 + 12);
  mvhd.writeUInt32BE(seconds * 1000, 8 + 16);
  const moov = Buffer.alloc(8);
  moov.writeUInt32BE(8 + mvhd.length, 0);
  moov.write('moov', 4, 'latin1');
  return Buffer.concat([ftyp, moov, mvhd]);
}

/** A JPEG photo with an EXIF block (camera owner and GPS-like text) that processing must strip. */
export function jpegWithExif(width = 640, height = 480): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 180, g: 40, b: 40 } } })
    .withExif({ IFD0: { Artist: 'Secret Owner', Copyright: 'gps 35.7575,51.4106' } })
    .jpeg()
    .toBuffer();
}

export const tinyPdf = (): Buffer => Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');

export const EICAR_TEXT = String.raw`X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*`;
