// Identifiers (41 §7): UUIDv7 generated in the application (RFC 9562), same
// layout as core.uuid_v7() in the database.
import { randomBytes } from 'node:crypto';

/** 40 §3.1 `Id`: lowercase canonical UUID, versions 1-8, RFC 4122 variant. */
export const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const isId = (v: unknown): v is string => typeof v === 'string' && ID_PATTERN.test(v);

let lastMs = 0;
let seq = 0;

/** UUIDv7: 48-bit Unix milliseconds, then random bits. Monotonic within one process. */
export function uuidv7(now: number = Date.now()): string {
  const b = randomBytes(16);
  let ms = now;
  if (ms <= lastMs) {
    // Same millisecond: keep ids sortable by bumping a 12-bit counter in rand_a.
    ms = lastMs;
    seq = (seq + 1) & 0xfff;
    if (seq === 0) ms = ++lastMs;
  } else {
    seq = b.readUInt16BE(6) & 0x7ff;
  }
  lastMs = ms;
  b.writeUIntBE(ms, 0, 6);
  b[6] = 0x70 | ((seq >> 8) & 0x0f);
  b[7] = seq & 0xff;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Milliseconds encoded in a UUIDv7. */
export const uuidv7Time = (id: string): number => parseInt(id.replace(/-/g, '').slice(0, 12), 16);
