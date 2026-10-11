// L11 crypto (41 §2.2, 40 §2.17): ids, derived keys, envelope encryption,
// HMAC, Argon2id passwords and signed cursors.
import { EnvelopeCipher } from './envelope.js';
import { Hmac } from './hmac.js';
import { KeyRing } from './keys.js';
import { CursorSigner } from './cursor.js';
import { PasswordHasher } from './password.js';

export { ID_PATTERN, isId, uuidv7, uuidv7Time } from './ids.js';
export { KeyRing, type HmacPurpose } from './keys.js';
export { EnvelopeCipher, type EnvelopeOptions } from './envelope.js';
export { Hmac, sha256, safeEqual } from './hmac.js';
export { PasswordHasher, SEC_AU_7_PARAMS, type Argon2Params } from './password.js';
export { CursorSigner, CURSOR_TTL_MS, type CursorCheck } from './cursor.js';

/** All crypto services of one process, built from the master secret. */
export class CryptoServices {
  readonly keys: KeyRing;
  readonly envelope: EnvelopeCipher;
  readonly hmac: Hmac;
  readonly passwords: PasswordHasher;
  readonly cursors: CursorSigner;

  constructor(masterSecret: string) {
    this.keys = new KeyRing(masterSecret);
    this.envelope = EnvelopeCipher.fromKeyRing(this.keys);
    this.hmac = new Hmac(this.keys);
    this.passwords = new PasswordHasher(this.keys.pepper());
    this.cursors = new CursorSigner(this.keys);
  }
}
