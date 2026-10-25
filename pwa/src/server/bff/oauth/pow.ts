// Proof of work for ATT operations without attestation (SEC-BF-7, DI-22): find a nonce so that SHA-256(prefix + nonce)
// starts with `difficulty_bits` zero bits; the header value is `<challenge_id>.<nonce>`. Lite mode never asks for
// it; the BFF uses it only in strict mode or after a 403 ATTESTATION_REQUIRED.

export interface PowChallenge {
  challenge_id: string;
  prefix: string;
  difficulty_bits: number;
  expires_at: string;
}

const encoder = new TextEncoder();

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
  for (let i = 0; i < maxTries; i++) {
    const nonce = String(i);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(c.prefix + nonce)));
    if (leadingZeroBits(hash) >= c.difficulty_bits) return nonce;
  }
  throw new Error('proof of work: no solution within the try budget');
}

export function powHeader(challengeId: string, nonce: string): string {
  return `${challengeId}.${nonce}`;
}
