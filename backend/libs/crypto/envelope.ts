// Field encryption (40 §2.17, 41 §7): AES-256-GCM envelope encryption. Each
// value gets its own random data key; the data key is wrapped with a
// key-encryption key (KEK) whose id is stored in the blob, so KEKs can rotate.
// Blob layout (bytea column):
//   0x01 | kekIdLen(1) | kekId | wrapIv(12) | wrapTag(16) | wrappedDek(32) | iv(12) | tag(16) | ciphertext
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { KeyRing } from './keys.js';

const VERSION = 1;
const IV = 12;
const TAG = 16;

export interface EnvelopeOptions {
  /** Id of the KEK used for new values; older ids stay readable. */
  activeKekId: string;
  /** Resolves a KEK by id (KMS in full mode, derived key in dev). */
  kek: (id: string) => Buffer;
}

export class EnvelopeCipher {
  constructor(private readonly options: EnvelopeOptions) {}

  static fromKeyRing(keys: KeyRing, activeKekId = 'k1'): EnvelopeCipher {
    return new EnvelopeCipher({ activeKekId, kek: (id) => keys.kek(id) });
  }

  /**
   * Encrypts a value. `aad` binds the ciphertext to its context (e.g.
   * "vehicle.vin:<vehicle id>") so a blob copied to another row fails to decrypt.
   */
  encrypt(plaintext: string | Buffer, aad = ''): Buffer {
    const kekId = Buffer.from(this.options.activeKekId, 'utf8');
    if (kekId.length === 0 || kekId.length > 255) throw new Error('invalid KEK id');
    const dek = randomBytes(32);
    const wrapIv = randomBytes(IV);
    const wrap = createCipheriv('aes-256-gcm', this.options.kek(this.options.activeKekId), wrapIv);
    wrap.setAAD(kekId);
    const wrappedDek = Buffer.concat([wrap.update(dek), wrap.final()]);
    const wrapTag = wrap.getAuthTag();

    const iv = randomBytes(IV);
    const cipher = createCipheriv('aes-256-gcm', dek, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    dek.fill(0);
    return Buffer.concat([Buffer.from([VERSION, kekId.length]), kekId, wrapIv, wrapTag, wrappedDek, iv, tag, ct]);
  }

  decrypt(blob: Buffer, aad = ''): Buffer {
    if (blob.length < 2 || blob[0] !== VERSION) throw new Error('unsupported envelope');
    const idLen = blob[1]!;
    if (blob.length < 2 + idLen + IV + TAG + 32 + IV + TAG) throw new Error('truncated envelope');
    let o = 2;
    const kekId = blob.subarray(o, (o += idLen));
    const wrapIv = blob.subarray(o, (o += IV));
    const wrapTag = blob.subarray(o, (o += TAG));
    const wrappedDek = blob.subarray(o, (o += 32));
    const iv = blob.subarray(o, (o += IV));
    const tag = blob.subarray(o, (o += TAG));
    const ct = blob.subarray(o);

    const unwrap = createDecipheriv('aes-256-gcm', this.options.kek(kekId.toString('utf8')), wrapIv);
    unwrap.setAAD(kekId);
    unwrap.setAuthTag(wrapTag);
    const dek = Buffer.concat([unwrap.update(wrappedDek), unwrap.final()]);
    try {
      const decipher = createDecipheriv('aes-256-gcm', dek, iv);
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]);
    } finally {
      dek.fill(0);
    }
  }

  decryptString(blob: Buffer, aad = ''): string {
    return this.decrypt(blob, aad).toString('utf8');
  }

  /** KEK id of a blob (rotation jobs re-encrypt blobs whose id is not the active one). */
  static kekIdOf(blob: Buffer): string {
    return blob.subarray(2, 2 + blob[1]!).toString('utf8');
  }
}
