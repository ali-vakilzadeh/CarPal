// Proof of work for ATT operations without attestation (SEC-BF-7, DI-22): find a nonce so that SHA-256(prefix + nonce)
// starts with `difficulty_bits` zero bits; the header value is `<challenge_id>.<nonce>`. Lite mode never asks for
// it; the BFF uses it only in strict mode or after a 403 ATTESTATION_REQUIRED. P13.T11: Node's synchronous SHA-256 in
// batches (one await of crypto.subtle per try made the backend's 18-bit challenge take longer than the request
// budget); the event loop gets a turn between batches.
import { createHash } from 'node:crypto';

export interface PowChallenge {
  challenge_id: string;
  prefix: string;
  difficulty_bits: number;
  expires_at: string;
}

/** Tries per batch before yielding to the event loop (≈ 10 ms of hashing). */
const BATCH = 20_000;

export function leadingZeroBits(hash: Uint8Array): number {
  let bits = 0;
  for (const byte of hash) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

/** Solves a challenge; nonces are decimal counters like the backend's reference solver. Gives up after `maxTries`. */
export async function solvePow(c: Pick<PowChallenge, 'prefix' | 'difficulty_bits'>, maxTries = 1 << 26): Promise<string> {
  for (let start = 0; start < maxTries; start += BATCH) {
    const end = Math.min(maxTries, start + BATCH);
    for (let i = start; i < end; i++) {
      const nonce = String(i);
      if (
        leadingZeroBits(
          createHash('sha256')
            .update(c.prefix + nonce)
            .digest(),
        ) >= c.difficulty_bits
      )
        return nonce;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('proof of work: no solution within the try budget');
}

export function powHeader(challengeId: string, nonce: string): string {
  return `${challengeId}.${nonce}`;
}
