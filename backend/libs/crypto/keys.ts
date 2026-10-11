// Key material (40 §2.17). Every key is derived with HKDF-SHA-256 from one
// master secret and a purpose label, so separate processes (api, auth server,
// workers, tests) agree on keys without sharing files. In development the
// master secret is a public constant (config refuses it outside dev); real
// environments supply it from the secret manager (KMS in full mode).
import { createPrivateKey, createPublicKey, hkdfSync, type KeyObject } from 'node:crypto';

/** HMAC key purposes (one key each, never reused across purposes). */
export type HmacPurpose =
  | 'link-token' // SEC-LT-1
  | 'otp' // SEC-AU-8
  | 'refresh-token' // SEC-AU-5
  | 'vin-hash' // SEC-CR vin_hash
  | 'contact-hash' // invited contact / push token lookup hashes
  | 'cursor' // signed Page cursors
  | 'log-pseudonym' // pseudonymous user id in access logs (SEC-LOG-1)
  | 'anon-key' // RLS anon_key from an anonymous device key
  | 'storage-url' // lite object storage signed URLs
  | 'idempotency'; // principal keys of idempotency records

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export class KeyRing {
  readonly #master: Buffer;
  readonly #cache = new Map<string, Buffer>();

  constructor(masterSecret: string) {
    if (masterSecret.length < 32) throw new Error('master secret must be at least 32 characters');
    this.#master = Buffer.from(masterSecret, 'utf8');
  }

  /** Raw derived bytes for a purpose label. */
  derive(label: string, length = 32): Buffer {
    const key = `${label}/${length}`;
    let v = this.#cache.get(key);
    if (!v) {
      v = Buffer.from(hkdfSync('sha256', this.#master, Buffer.from('carpal/v1'), Buffer.from(label), length));
      this.#cache.set(key, v);
    }
    return v;
  }

  hmacKey(purpose: HmacPurpose): Buffer {
    return this.derive(`hmac:${purpose}`);
  }

  /** Key-encryption key for envelope encryption (AES-256). */
  kek(id: string): Buffer {
    return this.derive(`kek:${id}`);
  }

  /** Password pepper (SEC-AU-7), passed to Argon2id as its secret input. */
  pepper(): Buffer {
    return this.derive('pepper:password');
  }

  /** Deterministic Ed25519 key pair for token signing (dev / derived mode). */
  ed25519(label: string): { privateKey: KeyObject; publicKey: KeyObject } {
    const seed = this.derive(`ed25519:${label}`);
    const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
    return { privateKey, publicKey: createPublicKey(privateKey) };
  }
}
