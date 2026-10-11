// Password hashing (40 SEC-AU-7): Argon2id, memory 64 MiB, 3 passes,
// parallelism 1, 16-byte salt, plus a pepper from the key ring passed as the
// Argon2 secret input. Uses node:crypto argon2 (Node >= 24.7). Hashes are PHC
// strings: $argon2id$v=19$m=65536,t=3,p=1$<salt b64>$<hash b64>.
import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

export interface Argon2Params {
  memoryKiB: number;
  passes: number;
  parallelism: number;
}

export const SEC_AU_7_PARAMS: Argon2Params = { memoryKiB: 65_536, passes: 3, parallelism: 1 };

const b64 = (b: Buffer): string => b.toString('base64').replace(/=+$/, '');

function argon2id(password: string, salt: Buffer, pepper: Buffer, p: Argon2Params): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      {
        message: password.normalize('NFC'),
        nonce: salt,
        secret: pepper,
        parallelism: p.parallelism,
        passes: p.passes,
        memory: p.memoryKiB,
        tagLength: 32,
      },
      (err, out) => (err ? reject(err) : resolve(out)),
    );
  });
}

export class PasswordHasher {
  constructor(
    private readonly pepper: Buffer,
    private readonly params: Argon2Params = SEC_AU_7_PARAMS,
  ) {}

  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const out = await argon2id(password, salt, this.pepper, this.params);
    const { memoryKiB: m, passes: t, parallelism: p } = this.params;
    return `$argon2id$v=19$m=${m},t=${t},p=${p}$${b64(salt)}$${b64(out)}`;
  }

  async verify(password: string, phc: string): Promise<boolean> {
    const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(phc);
    if (!m) return false;
    const params = { memoryKiB: Number(m[1]), passes: Number(m[2]), parallelism: Number(m[3]) };
    const expected = Buffer.from(m[5]!, 'base64');
    const actual = await argon2id(password, Buffer.from(m[4]!, 'base64'), this.pepper, params);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  /** True when a stored hash uses weaker parameters than the current ones (rehash on next sign-in). */
  needsRehash(phc: string): boolean {
    const { memoryKiB, passes, parallelism } = this.params;
    return !phc.startsWith(`$argon2id$v=19$m=${memoryKiB},t=${passes},p=${parallelism}$`);
  }
}
